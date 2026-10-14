/**
 * The phone's thread: one plan card per agent per prompt, and no tool line
 * under a card that already says it.
 *
 *   cd app && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldedEvents } from "../src/fold-model.ts";

const plan = (id: number, agentId = "opencode") => ({ id, kind: "status", agentId, payload: { state: "plan_updated", plan: [] } });

describe("plan updates", () => {
  it("keeps only the newest per agent within a prompt", () => {
    const ev = [plan(1), { id: 2, kind: "tool_call", agentId: "opencode" }, plan(3), plan(4)];
    assert.deepEqual([...foldedEvents(ev)].sort(), [1, 3]);
  });

  it("starts over when you send the next prompt, and keeps agents apart", () => {
    const ev = [plan(1), { id: 2, kind: "message" }, plan(3), plan(4, "codex"), plan(5, "codex")];
    assert.deepEqual([...foldedEvents(ev)].sort(), [4]);
  });

  it("hides the plan tool's own lines once a card stands in, and not before", () => {
    const tool = (id: number) => ({ id, kind: "tool_call", agentId: "opencode", payload: { tool: "todowrite" } });
    assert.deepEqual([...foldedEvents([tool(1), plan(2), tool(3)])].sort(), [1, 3]);
    // an adapter that never sends a plan update keeps its tool line
    assert.deepEqual([...foldedEvents([tool(1), { id: 2, kind: "message" }])], []);
  });

  it("hides the question tool's line under its card", () => {
    const ev = [
      { id: 1, kind: "needs_input", agentId: "opencode", payload: { requestId: "q1" } },
      { id: 2, kind: "tool_call", agentId: "opencode", payload: { tool: "question" } },
      { id: 3, kind: "message", agentId: "opencode", payload: { text: "Dogs" } },
    ];
    assert.deepEqual([...foldedEvents(ev)], [2]);
  });
});

import { groupToolRuns, summarizeTools } from "../src/fold-model.ts";

describe("tool runs", () => {
  const call = (id: number, tool: string, agentId = "opencode", extra: Record<string, unknown> = {}) => ({ id, kind: "tool_call", agentId, ts: id, payload: { tool, ...extra } });
  it("folds consecutive calls from one agent, and leaves a lone call alone", () => {
    const out = groupToolRuns([call(1, "bash"), call(2, "read"), { id: 3, kind: "message", agentId: "opencode" }, call(4, "read"), call(5, "bash", "codex")]);
    assert.deepEqual(out.map((e) => e.kind), ["tool_group", "message", "tool_call", "tool_call"]);
  });
  it("says what a run did, the way the desktop does", () => {
    assert.equal(summarizeTools([call(1, "bash"), call(2, "read"), call(3, "todowrite")]), "Ran 1 command, read 1 file, updated the plan");
    assert.equal(summarizeTools([call(1, "edit"), call(2, "edit"), call(3, "grep")]), "Edited 2 files, searched the code");
  });
});
