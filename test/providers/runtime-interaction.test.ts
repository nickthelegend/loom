/**
 * Phase 3 through the project runtime: a plan turn on a provider agent runs in
 * its native plan mode and Loom saves the proposed plan under plans/; a
 * structured question is answered through the runtime and releases the queue.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../../src/daemon/runtime.js";
import { stopAllProviderSessions } from "../../src/providers/agent.js";
import { makeProjectDir } from "../helpers.js";
import { codexDone, codexItem, codexNotify, codexTokens, fakeCodex, rpcOf } from "../native-fakes.js";

const open: ProjectRuntime[] = [];
afterAll(async () => { for (const rt of open) await rt.close().catch(() => {}); await stopAllProviderSessions(); });

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
};
const started = codexNotify("turn/started", { turn: { id: "$TURN", items: [], status: "inProgress", error: null } });

async function runtimeWith(bin: string) {
  const dir = makeProjectDir({ agents: [{ id: "codex", kind: "codex", options: { bin } }] });
  const rt = await ProjectRuntime.open({ id: `p-${Math.random().toString(36).slice(2)}`, name: "ix", dir });
  open.push(rt);
  return { rt, dir };
}

describe("runtime · provider interaction", () => {
  it("plans natively and keeps the proposed plan under .loom/plans/, not in the repo", async () => {
    const bin = fakeCodex({ script: [started, codexItem({ type: "plan", text: "# Add a cache layer\n\n- step one" }), codexTokens(10, 0, 1), codexDone()] });
    const { rt, dir } = await runtimeWith(bin);
    await rt.sendMessage("plan a cache", "codex", { plan: true });
    await until(() => !rt.anyBusy() && rt.log.list().some((e) => e.kind === "run_complete"));
    await until(() => rt.log.list().some((e) => e.payload.state === "plan_saved"));
    const turn = rpcOf(bin, "turn/start")[0]!;
    expect(turn).toMatchObject({ collaborationMode: { mode: "plan" } });
    // Loom's own plan briefing (write a file) is not sent to a native planner
    expect(JSON.stringify(turn.input)).not.toContain("[Loom · Plan mode]");
    const saved = rt.log.list().find((e) => e.payload.state === "plan_saved")!;
    expect(String(saved.payload.path)).toMatch(/^\.loom[\\/]plans[\\/]\d{4}-\d{2}-\d{2}-add-a-cache-layer\.md$/);
    expect(fs.existsSync(path.join(dir, "plans"))).toBe(false);
    const file = path.join(dir, String(saved.payload.path));
    expect(fs.readFileSync(file, "utf8")).toMatch(/^---\ntitle: "Add a cache layer"\nstatus: proposed[\s\S]*- step one/);
  });

  it("a fresh send starts the chat's session over instead of resuming it (#280)", async () => {
    const bin = fakeCodex();
    const { rt } = await runtimeWith(bin);
    await rt.sendMessage("first", "codex");
    await until(() => !rt.anyBusy() && rt.log.list({ kinds: ["run_complete"] }).length === 1);
    await rt.sendMessage("second, same session", "codex");
    await until(() => !rt.anyBusy() && rt.log.list({ kinds: ["run_complete"] }).length === 2);
    expect(rpcOf(bin, "thread/start")).toHaveLength(1);
    await rt.sendMessage("a short question", "codex", { fresh: true });
    await until(() => !rt.anyBusy() && rt.log.list({ kinds: ["run_complete"] }).length === 3);
    expect(rpcOf(bin, "thread/start")).toHaveLength(2);
    expect(rpcOf(bin, "thread/resume")).toHaveLength(0);
  });

  it("takes the answer to a structured question and lets the turn finish", async () => {
    const bin = fakeCodex({ script: [started, { ask: "item/tool/requestUserInput", params: { questions: [
      { id: "size", header: "Size", question: "How big?", options: [{ label: "small", description: "" }, { label: "large", description: "" }] }] } },
    codexItem({ type: "agentMessage", text: "Small it is." }), codexTokens(10, 0, 1), codexDone()] });
    const { rt } = await runtimeWith(bin);
    await rt.sendMessage("make it", "codex");
    await until(() => rt.log.list().some((e) => e.kind === "needs_input"));
    const asked = rt.log.list().find((e) => e.kind === "needs_input")!;
    await rt.answerQuestion("codex", "main", String(asked.payload.requestId), { size: "small" });
    await until(() => rt.log.list().some((e) => e.kind === "run_complete"));
    expect(rt.log.list().some((e) => e.kind === "message" && e.payload.text === "Small it is.")).toBe(true);
  });
});
