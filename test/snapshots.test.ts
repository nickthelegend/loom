/**
 * Time-Travel snapshots: folding the event log into scrubbable frames, with
 * baton, per-agent state, and decisions accumulating correctly over time.
 */

import { describe, expect, it } from "vitest";
import { buildSnapshots } from "../src/observability/snapshots.js";
import type { LoomEvent } from "../src/types.js";

let seq = 0;
function ev(kind: string, agentId: string | undefined, payload: Record<string, unknown>): LoomEvent {
  return { id: ++seq, ts: seq * 1000, kind: kind as LoomEvent["kind"], ...(agentId ? { agentId } : {}), payload };
}

describe("buildSnapshots", () => {
  it("returns [] for no events", () => {
    expect(buildSnapshots([])).toEqual([]);
  });

  it("tracks baton, turns, and decisions accumulating over time", () => {
    const events: LoomEvent[] = [
      ev("handoff", undefined, { from: null, to: "planner" }),
      ev("run_complete", "planner", { durationMs: 500, inputTokens: 100, outputTokens: 20, costUsd: 0.01 }),
      ev("status", "planner", { state: "agent_decision", decisionId: "d1", title: "Event log", category: "architecture", confidence: 95 }),
      ev("handoff", undefined, { from: "planner", to: "builder" }),
      ev("run_complete", "builder", { durationMs: 800, inputTokens: 200, outputTokens: 40, costUsd: 0.02 }),
      ev("status", "builder", { state: "agent_decision", decisionId: "d2", title: "React Query", category: "implementation", confidence: 86 }),
    ];
    const snaps = buildSnapshots(events);
    // every snapshot-worthy event produces a frame (2 handoffs + 2 turns + 2 decisions = 6)
    expect(snaps).toHaveLength(6);

    const afterPlannerTurn = snaps[1]!;
    expect(afterPlannerTurn.batonHolder).toBe("planner");
    expect(afterPlannerTurn.agentStates.planner!.turnsCompleted).toBe(1);
    expect(afterPlannerTurn.decisionsAtPoint).toEqual([]); // decision hasn't fired yet

    const afterFirstDecision = snaps[2]!;
    expect(afterFirstDecision.decisionsAtPoint).toEqual(["d1"]);
    expect(afterFirstDecision.triggerEvent.type).toBe("decision");

    const last = snaps[snaps.length - 1]!;
    expect(last.batonHolder).toBe("builder");
    expect(last.decisionsAtPoint).toEqual(["d1", "d2"]); // both accumulated
    expect(last.agentStates.builder!.costUsd).toBeCloseTo(0.02);
    expect(last.turnIndex).toBe(2); // two turns completed total
  });

  /**
   * `filesCreatedSoFar` was initialised to 0, never incremented, and shipped
   * through the API as a count of created files — structurally always zero. It
   * counts something now: git porcelain calls an untracked file "??", and a
   * turn touching one is the only "created" this log can support.
   */
  it("counts a created file only when the turn touched an untracked one", () => {
    const snaps = buildSnapshots([
      ev("handoff", undefined, { to: "builder" }),
      ev("turn_diff", "builder", {
        files: [
          { status: "??", path: "src/new.ts" },
          { status: " M", path: "src/old.ts" },
        ],
      }),
      ev("run_complete", "builder", { durationMs: 10 }),
    ]);
    const last = snaps[snaps.length - 1]!;
    expect(last.filesCreatedSoFar).toBe(1);
    expect(last.filesModifiedSoFar).toBe(2); // both files were changed by the turn
  });

  it("marks an errored agent in the frame it errors", () => {
    const snaps = buildSnapshots([
      ev("handoff", undefined, { to: "codex" }),
      ev("error", "codex", { message: "codex exited 1" }),
    ]);
    const errFrame = snaps.find((s) => s.triggerEvent.type === "error")!;
    expect(errFrame.agentStates.codex!.status).toBe("errored");
    expect(errFrame.triggerEvent.description).toContain("errored");
  });
});
