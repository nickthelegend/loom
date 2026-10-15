import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { fakeCodex, codexMessage, codexDone, codexNotify } from "./native-fakes.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const block = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";
const started = codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } });
let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });

async function setup(delay = 0, parallel = false) {
  process.env.LOOM_HOME = tmpDir("crew-native-home");
  const dir = makeProjectDir();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "seed"], { cwd: dir });
  const lead = fakeCodex({ script: [started, codexMessage(block([{ type: "plan", cards: [
    { title: "First card", touches: ["result.txt"], ...(parallel ? { assignee: "builder" } : {}) },
    { title: "Second card", touches: ["result2.txt"], ...(parallel ? { assignee: "builder-two" } : {}) },
  ] }])), codexDone()] });
  const builder = fakeCodex({ script: [started, ...(delay ? [{ sleep: delay }] : []), { write: { file: "result.txt", text: "$TURN" } },
    codexMessage(block([{ type: "done", summary: "built" }])), codexDone()] });
  const second = parallel ? fakeCodex({ script: [started, { sleep: delay }, { write: { file: "result2.txt", text: "$TURN" } },
    codexMessage(block([{ type: "done", summary: "built second" }])), codexDone()] }) : undefined;
  writeProjectConfig(dir, { name: "native crew", brain: { continuity: true, extractor: "off" },
    agents: [{ id: "lead", kind: "codex", options: { bin: lead } }, { id: "builder", kind: "codex", options: { bin: builder } },
      ...(second ? [{ id: "two", kind: "codex", options: { bin: second } }] : [])] });
  const info = { id: `native-crew-${path.basename(dir)}`, name: "native crew", dir };
  rt = await ProjectRuntime.open(info);
  const crew = rt.crews.create({ name: "Ship", planApproval: false, play: parallel ? "fanout" : "ship",
    teammates: [{ id: "lead", agent: "lead", role: "lead" }, { id: "builder", agent: "builder", role: "builder" },
      ...(second ? [{ id: "builder-two", agent: "two", role: "builder" as const }] : [])] });
  return { info, crewId: crew.id };
}
async function completed(id: string) {
  await waitUntil(() => !rt!.crews.get(id).busy, { timeoutMs: 60_000 });
  expect(rt!.crews.get(id).state.goal, JSON.stringify(rt!.crews.get(id).state.goal)).toMatchObject({ status: "completed" });
}

describe("persistent native crew teammates", () => {
  it("admits two native builders only in separate workspaces and integrates both results", async () => {
    const { crewId } = await setup(1500, true);
    await rt!.crews.goal(crewId, "Parallel native cards");
    await waitUntil(() => rt!.continuity!.store.activeReceipts().length === 2, { timeoutMs: 60_000 });
    const active = rt!.continuity!.store.activeReceipts();
    const workspaces = active.map(r => rt!.continuity!.store.bindingById(r.bindingId)!.workspaceId);
    expect(new Set(workspaces).size).toBe(2);
    await completed(crewId);
    const goal = rt!.crews.get(crewId).state.goal!;
    expect(fs.existsSync(path.join(goal.dir, "result.txt"))).toBe(true);
    expect(fs.existsSync(path.join(goal.dir, "result2.txt"))).toBe(true);
    expect(rt!.continuity!.store.activeReceipts()).toEqual([]);
  }, 120_000);
  it("uses deltas on the second card and keeps each seat's native session through restart and another goal", async () => {
    const { info, crewId } = await setup();
    await rt!.crews.goal(crewId, "Build two cards");
    await completed(crewId);
    const first = structuredClone(rt!.crews.get(crewId).state);
    expect(first.sessions!.builder.nativeSessionId).toBeTruthy();
    expect(first.sessions!.lead.bindingId).not.toBe(first.sessions!.builder.bindingId);
    const receipts = rt!.continuity!.store.receipts().filter(r => r.bindingId === first.sessions!.builder.bindingId);
    expect(receipts).toHaveLength(2);
    expect(receipts.map(r => rt!.continuity!.store.packet(r.packetId)!.packet.mode)).toEqual(["reconstruction", "delta"]);
    await rt!.close(); rt = await ProjectRuntime.open(info);
    await rt.crews.goal(crewId, "Another goal");
    await completed(crewId);
    const second = rt.crews.get(crewId).state;
    expect(second.goal!.dir).toBe(first.goal!.dir);
    expect(second.goal!.branch).not.toBe(first.goal!.branch);
    expect(second.sessions!.builder).toEqual(first.sessions!.builder);
    expect(rt.continuity!.store.activeReceipts()).toEqual([]);
    await rt.crews.refresh(crewId, "builder");
    expect(rt.crews.get(crewId).state.sessions!.builder).toMatchObject({ epoch: 2, nativeSessionId: null });
  }, 120_000);

  it("quiesces a mid-card shutdown and resumes the same teammate instead of silently replacing its session", async () => {
    const { info, crewId } = await setup(1200);
    await rt!.crews.goal(crewId, "Resume mid-card");
    await waitUntil(() => Boolean(rt!.crews.get(crewId).state.sessions?.builder?.nativeSessionId), { timeoutMs: 60_000 });
    const session = structuredClone(rt!.crews.get(crewId).state.sessions!.builder);
    expect(rt!.anyBusy()).toBe(true);
    await rt!.close(); rt = await ProjectRuntime.open(info);
    expect(rt.crews.get(crewId).state.goal!.status).toBe("interrupted");
    rt.crews.resume(crewId);
    await completed(crewId);
    expect(rt.crews.get(crewId).state.sessions!.builder).toEqual(session);
  }, 120_000);

  it("holds an uncertain native action until the user reconciles it", async () => {
    const { crewId } = await setup();
    await rt!.crews.goal(crewId, "Build first"); await completed(crewId);
    const st = rt!.crews.get(crewId).state, brain = rt!.continuity!;
    const request = brain.capture({ id: crypto.randomUUID(), conversationId: st.threads.builder, agentInstanceId: "builder",
      text: "uncertain action", source: "route", model: null, plan: false, targetAddedTokens: 12000 }).request;
    const cfg = rt!.config.agents.find(a => a.id === "builder")!;
    const prepared = await brain.prepare(request, "codex", st.goal!.dir, cfg.options ?? {});
    await brain.submit(prepared);
    brain.store.transition(prepared.receipt.id, "outcome_unknown", "unknown", "lost native acknowledgement");
    st.goal!.status = "interrupted";
    expect(() => rt!.crews.resume(crewId)).toThrow(/uncertain native turn/);
    await expect(rt!.crews.refresh(crewId, "builder")).rejects.toThrow(/reconcile/);
    expect(brain.store.activeReceipts()).toHaveLength(1);
  }, 120_000);
});
