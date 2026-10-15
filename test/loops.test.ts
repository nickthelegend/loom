/**
 * Loop watch: an agent re-running the same failing command is caught, said,
 * and — when the project asks — stopped and nudged once. The card's ways out
 * (stop, nudge, hand it to another agent) work from the runtime.
 *
 * echo's `loop:<n>` runs `npm test`, failing, n times — an agent stuck on a red test.
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FAILING_AT, LoopWatch, REPEATING_AT, nudgeText, signature } from "../src/core/loops.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { pushCategory, pushContent } from "../src/daemon/push.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-loops");
  process.env.LOOM_NO_NOTIFY = "1";
});

let n = 0;
const ev = (kind: string, payload: Record<string, unknown>, agentId = "a", chat?: string): LoomEvent =>
  ({ id: ++n, ts: 0, kind, agentId, ...(chat ? { chat } : {}), payload } as LoomEvent);
const failing = (command = "npm test", extra: Record<string, unknown> = {}) => ev("tool_call", { tool: "shell", command, exitCode: 1, ok: false, ...extra });

describe("the watch", () => {
  it("says so once, the third time the same command fails in a turn", () => {
    const w = new LoopWatch();
    expect(w.observe(failing())).toBeNull();
    expect(w.observe(failing("npm  test"))).toBeNull(); // same command, spaced differently
    const loop = w.observe(failing("npm test", { preview: "Tests  1 failed (1)" }));
    expect(loop).toEqual({ agentId: "a", chat: "main", kind: "failing", call: "npm test", count: FAILING_AT, output: "Tests  1 failed (1)" });
    for (let i = 0; i < 6; i++) expect(w.observe(failing())).toBeNull(); // once per turn, not every time after
  });

  it("a passing run, another command, or another agent doesn't count toward it", () => {
    const w = new LoopWatch();
    w.observe(failing()); w.observe(failing());
    expect(w.observe(ev("tool_call", { tool: "shell", command: "npm test", exitCode: 0 }))).toBeNull();
    expect(w.observe(failing("npx tsc --noEmit"))).toBeNull();
    expect(w.observe(failing("npm test", {}))).toMatchObject({ kind: "failing", count: 3 });
    const other = new LoopWatch();
    other.observe(failing()); other.observe(ev("tool_call", { tool: "shell", command: "npm test", exitCode: 1 }, "b"));
    expect(other.observe(failing("npm test", {}))).toBeNull();
  });

  it("the same call made over and over, failing or not", () => {
    const w = new LoopWatch();
    const read = () => ev("tool_call", { tool: "read", summary: "read src/a.ts" });
    for (let i = 1; i < REPEATING_AT; i++) expect(w.observe(read())).toBeNull();
    expect(w.observe(read())).toMatchObject({ kind: "repeating", call: "read: read src/a.ts", count: REPEATING_AT });
    // an OpenCode bash call: its command is in the input
    expect(signature({ tool: "bash", input: { command: "pytest -x" } })).toBe("pytest -x");
  });

  it("starts over when the turn ends, it's stopped, or a person speaks", () => {
    const w = new LoopWatch();
    w.observe(failing()); w.observe(failing());
    w.observe(ev("run_complete", {}));
    expect(w.observe(failing())).toBeNull();
    w.observe(failing());
    w.observe(ev("status", { state: "interrupted" }));
    expect(w.observe(failing())).toBeNull();
    w.observe(failing());
    w.reset("main");
    expect(w.observe(failing())).toBeNull();
    // chats are separate: a person speaking in another one doesn't reset this one
    w.observe(failing());
    w.reset("side");
    expect(w.observe(failing())).toMatchObject({ kind: "failing" });
  });

  it("the nudge names the command and asks for a different approach", () => {
    expect(nudgeText({ agentId: "a", chat: "main", kind: "failing", call: "npm test", count: 3 })).toMatch(/run `npm test` 3 times.*different approach/s);
    expect(nudgeText({ agentId: "a", chat: "main", kind: "repeating", call: "read: x", count: 5 })).toMatch(/same call.*5 times/);
  });
});

async function project(extra: Record<string, unknown> = {}) {
  const dir = tmpDir("loops");
  writeProjectConfig(dir, { name: "loops", agents: [{ id: "stuck", kind: "echo" }, { id: "helper", kind: "echo" }], defaultAgent: "stuck", brain: { extractor: "off" }, ...extra } as never);
  rt = await ProjectRuntime.open({ id: `loops-${path.basename(dir)}`, name: "loops", dir });
}
const loopCards = () => rt!.log.list({ kinds: ["status"] }).filter((e) => e.payload.state === "loop_detected");
const repliesOf = (agent: string) => rt!.log.list({ kinds: ["message"] }).filter((e) => e.agentId === agent).map((e) => String(e.payload.text));

describe("in a project", () => {
  it("tells you, by default, and lets the agent carry on", async () => {
    await project();
    await rt!.sendMessage("fix it loop:4");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    expect(loopCards()).toHaveLength(1);
    const card = loopCards()[0]!;
    expect(card).toMatchObject({ agentId: "stuck", payload: { loop: "failing", call: "npm test", count: 3, text: "stuck ran `npm test` 3 times this turn, failing each time" } });
    expect(card.payload.output).toMatch(/1 failed/);
    expect(card.payload.nudged).toBeUndefined();
    // all four ran: nobody stopped it
    expect(rt!.log.list({ kinds: ["tool_call"] })).toHaveLength(4);
    // the phone hears it as a question for you
    expect(pushCategory(card)).toBe("questions");
    expect(pushContent("loops", card).title).toBe("stuck is going in circles · loops");
  });

  it("with watchdog nudge, stops it and asks it to step back — once", async () => {
    await project({ watchdog: { auto: "nudge" } });
    await rt!.sendMessage("fix it loop:20");
    await waitUntil(() => repliesOf("stuck").some((t) => t.includes("Stop repeating it")), { timeoutMs: 15_000 });
    // stopped at the third failure, not the twentieth
    expect(rt!.log.list({ kinds: ["tool_call"] }).length).toBeLessThan(6);
    expect(loopCards()[0]!.payload).toMatchObject({ nudged: true });
    expect(pushContent("loops", loopCards()[0]!).body).toMatch(/Loom stopped it and asked it to step back/);
    // a second loop before you've said anything is only reported
    await rt!.sendMessage("again loop:5", "stuck", { source: "route" });
    await waitUntil(() => loopCards().length === 2);
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length >= 2);
    expect(loopCards()[1]!.payload.nudged).toBeUndefined();
  });

  it("off is off", async () => {
    await project({ watchdog: { auto: "off" } });
    await rt!.sendMessage("loop:4");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    expect(loopCards()).toHaveLength(0);
  });

  it("hand it off: another agent gets the request, and is told what went wrong", async () => {
    await project();
    await rt!.sendMessage("make add() right loop:3");
    await waitUntil(() => loopCards().length === 1);
    const done = await rt!.actOnLoop("main", "stuck", "handoff", "helper");
    expect(done).toEqual({ done: "handed off", to: "helper" });
    await waitUntil(() => repliesOf("helper").length === 1, { timeoutMs: 10_000 });
    expect(repliesOf("helper")[0]).toMatch(/make add\(\) right/);
    expect(repliesOf("helper")[0]).toMatch(/briefed/);
    await expect(rt!.actOnLoop("main", "stuck", "handoff")).rejects.toThrow(/which agent/);
  });
});
