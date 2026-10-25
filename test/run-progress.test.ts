/** Peer ask (field): a chain of orchestras was a black box for an hour — one event per change. */

import { describe, expect, it } from "vitest";
import { formatEvent, runEvents } from "../src/cli/run-progress.js";
import type { OrchestraRun } from "../src/core/orchestra.js";

const task = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `do ${id}`, agent: "codex", status, attempts: status === "pending" ? 0 : 1, ...extra });
const run = (status: string, round: number, tasks: unknown[]) => ({ id: "r1", status, round, tasks }) as unknown as OrchestraRun;

describe("run progress events", () => {
  it("says what changed between two looks, and nothing when nothing did", () => {
    const a = run("planning", 0, []);
    expect(runEvents(null, a)).toEqual([{ kind: "run", run: "r1", status: "planning", round: 0 }]);
    const b = run("running", 1, [task("t1", "running"), task("t2", "pending")]);
    expect(runEvents(a, b)).toEqual([
      { kind: "run", run: "r1", status: "running", round: 1 },
      { kind: "planned", run: "r1", task: "t1", agent: "codex", title: "do t1" },
      { kind: "task", run: "r1", task: "t1", agent: "codex", status: "running", attempt: 1 },
      { kind: "planned", run: "r1", task: "t2", agent: "codex", title: "do t2" },
    ]);
    expect(runEvents(b, b)).toEqual([]);
    const c = run("running", 2, [task("t1", "done", { files: ["a.ts", "b.ts"] }), task("t2", "failed", { error: "tests failed\nstack…" })]);
    expect(runEvents(b, c)).toEqual([
      { kind: "round", run: "r1", round: 2 },
      { kind: "task", run: "r1", task: "t1", agent: "codex", status: "done", attempt: 1, files: 2 },
      { kind: "task", run: "r1", task: "t2", agent: "codex", status: "failed", attempt: 1, error: "tests failed" },
    ]);
    // sent back for another try
    const d = run("running", 2, [task("t1", "done", { files: ["a.ts", "b.ts"] }), task("t2", "running", { attempts: 2 })]);
    const again = runEvents(c, d);
    expect(again).toEqual([{ kind: "task", run: "r1", task: "t2", agent: "codex", status: "running", attempt: 2 }]);
    expect(formatEvent(again[0]!, "api")).toMatch(/^\d\d:\d\d:\d\d api t2 \[codex\] running \(attempt 2\)$/);
    expect(formatEvent(runEvents(b, c)[1]!)).toMatch(/t1 \[codex\] done — 2 files$/);
  });
});
