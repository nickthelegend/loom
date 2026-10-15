/**
 * Agent Teams, Phase 2 — persistent teammates over native continuity.
 *
 * Each teammate has its own binding (its thread × the goal's worktree): the
 * first card reconstructs, the second is a delta into the same native session,
 * Refresh moves the binding to a new epoch, `remember` keeps a crew-scoped
 * memory, and a goal cut off by a restart resumes. Against the Codex protocol
 * fake (test/native-fakes.ts), never a real harness.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";
import { codexDone, codexMessage, codexNotify, fakeCodex, rpcOf, type Step } from "./native-fakes.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const loom = (actions: unknown[]) => "Sure.\n```loom\n" + JSON.stringify({ actions }) + "\n```";
/** One Codex turn whose reply is `text`. */
const reply = (text: string, extra: Step[] = []): Step[] => [
  codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } }),
  ...extra,
  codexMessage(text),
  codexDone(),
];

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-crew-continuity");
  process.env.LOOM_NO_NOTIFY = "1";
});

async function project(opts: { builder?: Step[]; builderTurns?: Step[][] } = {}) {
  const dir = tmpDir("crew-native");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  // The Lead plans two cards for the builder, then wraps up; the builder does
  // each card and remembers one thing on the first.
  const lead = fakeCodex({
    scripts: [reply(loom([{ type: "plan", cards: [{ title: "First card" }, { title: "Second card" }] }]))],
    script: reply(loom([{ type: "done", summary: "both cards done" }])),
  });
  const builder = fakeCodex({
    scripts: opts.builderTurns ?? [reply(loom([{ type: "remember", kind: "decision", text: "The queue uses Postgres LISTEN, not Redis." }, { type: "done", summary: "first" }]))],
    script: opts.builder ?? reply(loom([{ type: "done", summary: "next" }])),
  });
  writeProjectConfig(dir, {
    name: "nativecrew",
    agents: [{ id: "lead-cx", kind: "codex", options: { bin: lead } }, { id: "build-cx", kind: "codex", options: { bin: builder } }],
    brain: { extractor: "off", continuity: true },
  });
  rt = await ProjectRuntime.open({ id: `crewn-${path.basename(dir)}`, name: "nativecrew", dir });
  const crew = rt.crews.create({
    name: "Ship",
    planApproval: false,
    teammates: [
      { id: "lead", agent: "lead-cx", role: "lead" },
      { id: "builder", agent: "build-cx", role: "builder" },
    ],
  });
  return { dir, crew, lead, builder };
}

/** The builder's native packets, oldest first. */
function builderPackets(r: ProjectRuntime, crewId: string) {
  const st = r.crews.get(crewId).state;
  const brain = r.continuity!;
  if (!st.threads.builder) return [];
  const bindings = brain.store.bindingsFor(st.threads.builder, "build-cx");
  return brain.store.receipts().filter((x) => bindings.some((b) => b.id === x.bindingId))
    .map((x) => ({ receipt: x, packet: brain.store.packet(x.packetId)!.packet }));
}

describe("crew teammates over native continuity", () => {
  it("the second card on the same teammate is a delta into the same native session", async () => {
    const { crew, builder } = await project();
    await rt!.crews.goal(crew.id, "Make the queue durable");
    await waitUntil(() => rt!.crews.get(crew.id).state.goal?.status === "completed", { timeoutMs: 30_000 });

    const turns = builderPackets(rt!, crew.id);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.packet.mode)).toEqual(["reconstruction", "delta"]);
    expect(turns.every((t) => t.receipt.status === "accepted" && t.receipt.execution === "complete")).toBe(true);
    // one binding, one native session, resumed explicitly for the second card
    expect(turns[0]!.packet.target.id).toBe(turns[1]!.packet.target.id);
    expect(turns[1]!.packet.target.nativeSessionId).toBeTruthy();
    expect(rpcOf(builder, "thread/start")).toHaveLength(1);
    // the role briefing rides in the packet, once per turn
    expect(turns[0]!.packet.supplement).toContain("You are builder, the builder on Ship");

    const sessions = rt!.crews.get(crew.id).sessions;
    expect(sessions.builder).toMatchObject({ mode: "native", generation: 0, epoch: 1, resumable: true, lastPacket: "delta" });
    expect(sessions.lead).toMatchObject({ mode: "native" });
  });

  it("remember keeps a crew-scoped memory that later briefings read, and nobody else's", async () => {
    const { crew } = await project();
    await rt!.crews.goal(crew.id, "Make the queue durable");
    await waitUntil(() => rt!.crews.get(crew.id).state.goal?.status === "completed", { timeoutMs: 30_000 });
    const channel = rt!.crews.get(crew.id).state.channel;
    const memory = rt!.brain.all().find((m) => m.text.includes("Postgres LISTEN"));
    expect(memory).toMatchObject({ kind: "decision", scope: { chat: channel }, provenance: { agentId: "build-cx" } });
    expect(rt!.log.list({ chat: channel }).some((e) => String(e.payload.text ?? "").includes("builder remembers (decision)"))).toBe(true);
    // scoped to the crew: an ordinary chat's retrieval doesn't see it
    expect(rt!.brain.list({ chat: "main" }).some((m) => m.id === memory!.id)).toBe(false);
    expect(rt!.brain.list({ chat: channel }).some((m) => m.id === memory!.id)).toBe(true);
  });

  it("refresh moves the teammate's binding to a new epoch: its next packet reconstructs", async () => {
    const { crew } = await project();
    await rt!.crews.goal(crew.id, "Make the queue durable");
    await waitUntil(() => rt!.crews.get(crew.id).state.goal?.status === "completed", { timeoutMs: 30_000 });
    const session = await rt!.crews.refresh(crew.id, "builder");
    expect(session).toMatchObject({ mode: "native", generation: 1, epoch: 2, resumable: false });
    const channel = rt!.crews.get(crew.id).state.channel;
    expect(rt!.log.list({ kinds: ["crew"], chat: channel }).some((e) => e.payload.phase === "refreshed" && e.payload.teammate === "builder")).toBe(true);
    await expect(rt!.crews.refresh(crew.id, "nobody")).rejects.toThrow(/no teammate "nobody"/);
  });

  it("refuses a goal when a teammate isn't a native harness", async () => {
    const { dir, crew } = await project();
    writeProjectConfig(dir, {
      name: "nativecrew",
      agents: [{ id: "lead-cx", kind: "codex", options: { bin: "/nope" } }, { id: "build-cx", kind: "echo" }],
      brain: { extractor: "off", continuity: true },
      crews: rt!.crews.list().map(({ state: _s, busy: _b, sessions: _x, ...c }) => c),
    });
    await rt!.close();
    rt = await ProjectRuntime.open({ id: `crewn-${path.basename(dir)}`, name: "nativecrew", dir });
    await expect(rt.crews.goal(crew.id, "anything")).rejects.toThrow(/every teammate must be Codex, Claude Code or OpenCode/);
  });

  /** A goal whose builder is mid-turn on its first card when Loom closes, reopened. */
  async function cutOff() {
    // the fake's turn counter restarts with its process, so the resumed turn
    // replays this one: a hang long enough to close inside, short enough to finish
    const { dir, crew } = await project({ builderTurns: [reply(loom([{ type: "done", summary: "first, at last" }]), [{ sleep: 5000 }])] });
    await rt!.crews.goal(crew.id, "Make the queue durable");
    await waitUntil(() => builderPackets(rt!, crew.id)[0]?.receipt.status === "accepted", { timeoutMs: 30_000 });
    await rt!.close();
    rt = await ProjectRuntime.open({ id: `crewn-${path.basename(dir)}`, name: "nativecrew", dir });
    expect(rt.crews.get(crew.id).state.goal!.status).toBe("interrupted");
    return crew;
  }

  it("a goal cut off by a clean restart resumes into the same native session", async () => {
    const crew = await cutOff();
    // Loom closing interrupted the turn, so its outcome is known
    expect(builderPackets(rt!, crew.id)[0]!.receipt.execution).toBe("interrupted");
    rt!.crews.resume(crew.id);
    await waitUntil(() => rt!.crews.get(crew.id).state.goal?.status === "completed", { timeoutMs: 30_000 });
    const turns = builderPackets(rt!, crew.id);
    expect(turns.map((t) => t.packet.mode)).toEqual(["reconstruction", "delta", "delta"]);
    expect(new Set(turns.map((t) => t.packet.target.sessionEpoch))).toEqual(new Set([1]));
    expect(rt!.continuity!.store.activeReceipts()).toHaveLength(0);
    expect(rt!.crews.get(crew.id).state.goal!.cards.every((c) => c.stage === "done")).toBe(true);
  });

  it("a turn whose outcome is unknown is reconciled on resume, and the teammate rebuilt in a new epoch", async () => {
    const crew = await cutOff();
    // as after a crash: the run's outcome is unknown and it still holds the worktree
    const store = rt!.continuity!.store;
    const cut = builderPackets(rt!, crew.id)[0]!.receipt;
    store.transition(cut.id, "accepted", "unknown", "previous owner exited; native action outcome requires reconciliation");
    expect(store.activeReceipts().map((r) => r.id)).toEqual([cut.id]);
    rt!.crews.resume(crew.id);
    await waitUntil(() => rt!.crews.get(crew.id).state.goal?.status === "completed", { timeoutMs: 30_000 });
    const turns = builderPackets(rt!, crew.id);
    expect(turns[0]!.receipt.evidence).toMatch(/resumed by its owner after Loom restarted/);
    // nothing the cut-off session held is trusted: the resumed card reconstructs, in epoch 2
    expect(turns[1]!.packet).toMatchObject({ mode: "reconstruction", target: { sessionEpoch: 2 } });
    expect(store.activeReceipts()).toHaveLength(0);
  });
});
