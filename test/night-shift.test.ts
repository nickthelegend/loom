/**
 * Night Shift: tasks run one after another, a chat each, and the morning
 * report says how each went — verified, done, didn't hold, failed, needs you,
 * not started — stopping early at its time or its budget.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { outcomeOf, parseTasks, parseUntil, report, type ShiftConfig } from "../src/core/shift.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { pushCategory, pushContent } from "../src/daemon/push.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

let id = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, agentId?: string): LoomEvent =>
  ({ id: ++id, ts: 0, kind, ...(agentId ? { agentId } : {}), payload } as LoomEvent);
const task = { text: "fix the adder", chat: "c1" };

describe("how a task went", () => {
  it("reads verified, didn't hold, done and failed from its chat", () => {
    const said = ev("message", { text: "fix the adder" });
    const done = ev("run_complete", { durationMs: 4000 }, "codex");
    expect(outcomeOf(task, [said, ev("turn_diff", { files: [{ path: "add.js" }] }), ev("status", { state: "turn_cost", costUsd: 0.12 }), done,
      ev("proof", { verdict: "verified", headline: "Verified: 4 tests pass in a clean checkout" })]))
      .toEqual({ text: "fix the adder", chat: "c1", status: "verified", agent: "codex", headline: "Verified: 4 tests pass in a clean checkout", loops: 0, files: ["add.js"], costUsd: 0.12, ms: 4000 });
    expect(outcomeOf(task, [said, done, ev("proof", { verdict: "contradicted", headline: "said 14 pass; 11 did" })])).toMatchObject({ status: "didnt_hold" });
    expect(outcomeOf(task, [said, done])).toMatchObject({ status: "done" });
    expect(outcomeOf(task, [said, ev("run_complete", { error: "codex exited 1" }, "codex")])).toMatchObject({ status: "failed", error: "codex exited 1" });
  });

  it("a proof of an earlier turn doesn't vouch for the last one", () => {
    const proofThenNudge = [ev("message", {}), ev("run_complete", {}, "a"), ev("proof", { verdict: "verified" }),
      ev("status", { state: "loop_detected" }, "a"), ev("run_complete", {}, "a")];
    expect(outcomeOf(task, proofThenNudge)).toMatchObject({ status: "done", loops: 1 });
  });

  it("an open question is yours; never sent is not started", () => {
    expect(outcomeOf(task, [ev("message", {}), ev("needs_input", { question: "Postgres or SQLite?" }, "a")]))
      .toMatchObject({ status: "needs_you", question: "Postgres or SQLite?" });
    expect(outcomeOf(task, [], { queued: true })).toMatchObject({ status: "not_started" });
    expect(outcomeOf({ ...task, skipped: true }, [])).toMatchObject({ status: "not_started" });
  });

  it("the report sums it up in one line", () => {
    const shift: ShiftConfig = { id: "s1", startedAt: 0, tasks: [], stopped: "it spent its $1.00 budget" };
    const o = (status: string, costUsd = 0) => ({ text: "t", chat: "c", status, loops: 0, files: [], costUsd, ms: 0 }) as never;
    const r = report(shift, [o("verified", 0.1), o("verified", 0.2), o("needs_you"), o("not_started")], 99);
    expect(r).toMatchObject({ summary: "4 tasks: 2 verified, 1 needs you, 1 not started", costUsd: 0.3, stopped: "it spent its $1.00 budget", endedAt: 99 });
  });

  it("reads a stop-by time and a list of tasks the way people write them", () => {
    const now = new Date("2026-10-15T23:00:00").getTime();
    expect(parseUntil("7:00", now)).toBe(new Date("2026-10-16T07:00:00").getTime());
    expect(parseUntil("6:30am", now)).toBe(new Date("2026-10-16T06:30:00").getTime());
    expect(parseUntil("11:30 pm", now)).toBe(new Date("2026-10-15T23:30:00").getTime());
    expect(() => parseUntil("soonish", now)).toThrow(/isn't a time/);
    expect(parseTasks("- fix the adder\n\n2. add a test\n  * update the README  ")).toEqual(["fix the adder", "add a test", "update the README"]);
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-shift");
  process.env.LOOM_NO_NOTIFY = "1";
});

/** A git project (so Proof can check) with an echo agent. */
async function project() {
  const dir = tmpDir("shift");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: dir });
  writeProjectConfig(dir, { name: "shift", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } });
  rt = await ProjectRuntime.open({ id: `shift-${path.basename(dir)}`, name: "shift", dir });
  return dir;
}
const reports = () => rt!.log.list({ kinds: ["shift"] }).filter((e) => e.payload.phase === "report");

describe("a night shift", () => {
  it("runs each task in its own chat, one after another, and reports in the morning", async () => {
    await project();
    const shift = rt!.shifts.start({ tasks: "Done. All tests pass.\nLooked around the code.\nask: Postgres or SQLite?\nfail: the CLI crashed", to: "echo" });
    expect(shift.tasks).toHaveLength(4);
    expect(new Set(shift.tasks.map((t) => t.chat)).size).toBe(4);
    expect(rt!.shifts.active).toBe(true);
    await waitUntil(() => reports().length === 1, { timeoutMs: 40_000 });
    const r = reports()[0]!.payload as Record<string, any>;
    expect(r.tasks.map((t: { status: string }) => t.status)).toEqual(["didnt_hold", "done", "needs_you", "failed"]);
    expect(r.tasks[0].headline).toBeTruthy();
    expect(r.tasks[2].question).toBe("Postgres or SQLite?");
    expect(r.summary).toBe("4 tasks: 1 done (not checked), 1 didn't hold, 1 failed, 1 needs you");
    expect(r.costUsd).toBeGreaterThan(0);
    // the question didn't hold the line: the task after it ran
    expect(rt!.queue.snapshot().paused).toBe(false);
    // and the phone hears about it once
    const e = reports()[0]!;
    expect(pushCategory(e)).toBe("goals");
    expect(pushContent("shift", e).title).toBe("🌙 Night shift done · shift");
    expect(rt!.shifts.status()).toMatchObject({ active: false, last: { summary: r.summary } });
  });

  it("stops starting new tasks when it's stopped, or spends its budget — and says so", async () => {
    await project();
    rt!.shifts.start({ tasks: ["first sleep:300", "second", "third"], to: "echo", maxUsd: 0.0005 });
    await waitUntil(() => reports().length === 1, { timeoutMs: 40_000 });
    const r = reports()[0]!.payload as Record<string, any>;
    expect(r.tasks.map((t: { status: string }) => t.status)).toEqual(["done", "not_started", "not_started"]);
    expect(r.stopped).toBe("it spent its $0.00 budget");
    expect(rt!.queue.length).toBe(0);

    rt!.shifts.start({ tasks: ["one sleep:800", "two"], to: "echo" });
    await waitUntil(() => rt!.log.list({ kinds: ["message"] }).some((m) => !m.agentId && String(m.payload.text) === "one sleep:800"));
    rt!.shifts.stop();
    await waitUntil(() => reports().length === 2, { timeoutMs: 40_000 });
    expect((reports()[1]!.payload as Record<string, any>)).toMatchObject({ stopped: "you stopped it", summary: "2 tasks: 1 done (not checked), 1 not started" });
  });

  it("picks the watch up again after a restart", async () => {
    const dir = await project();
    const info = { id: `shift-${path.basename(dir)}`, name: "shift", dir };
    rt!.shifts.start({ tasks: ["one", "two sleep:400", "three"], to: "echo" });
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length >= 1);
    await rt!.close();
    rt = await ProjectRuntime.open(info);
    expect(rt.shifts.active).toBe(true);
    // a restart pauses the queue until someone looks — on a night shift nobody is, so the shift resumes it
    await waitUntil(() => reports().length === 1, { timeoutMs: 40_000 });
    const r = reports()[0]!.payload as Record<string, any>;
    expect(r.tasks).toHaveLength(3);
    expect(r.tasks[0].status).toBe("done");
    // the task the restart cut off says so; the one after it still ran
    expect(r.tasks[1]).toMatchObject({ status: "failed", error: "it stopped before finishing (was Loom restarted?)" });
    expect(r.tasks[2].status).toBe("done");
  });

  it("refuses what it can't run, and one shift at a time", async () => {
    await project();
    expect(() => rt!.shifts.start({ tasks: "" })).toThrow(/at least one task/);
    expect(() => rt!.shifts.start({ tasks: "x", to: "ghost" })).toThrow(/no agent "ghost"/);
    rt!.shifts.start({ tasks: "x sleep:300", to: "echo" });
    expect(() => rt!.shifts.start({ tasks: "y" })).toThrow(/already running/);
    await waitUntil(() => reports().length === 1, { timeoutMs: 40_000 });
  });
});
