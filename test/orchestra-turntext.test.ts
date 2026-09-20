/**
 * The bug that made orchestra look broken (#104).
 *
 * Every run planned tasks and spawned none. The thread said "your reply had no
 * ```loom actions block" directly underneath a reply that plainly contained
 * one — because the engine parses accumulated turn text, not the logged
 * message, and that text was capped to its last 20,000 characters. A plan's
 * block sits at the END of a long reply, so the cap kept the closing fence and
 * threw away the opening one.
 *
 * Measured on a real run before the fix: seven consecutive plans of 6, 5, 5,
 * 5, 5, 8 and 8 tasks, every one parseable from the log and every one binned.
 */

import { describe, expect, it } from "vitest";

import { capTurnText, parseOrchestraActions, TURN_TEXT_LIMIT } from "../src/core/orchestra.js";

/** A plan shaped like the ones that were lost: long prose, then the block. */
function plan(tasks: number, promptChars: number): string {
  const actions = Array.from({ length: tasks }, (_, i) => ({
    type: "spawn",
    id: `t${i + 1}`,
    title: `task ${i + 1}`,
    agent: "codex",
    prompt: "x".repeat(promptChars),
  }));
  return (
    "Grounded in the real repo. " +
    "Here is what I found and why it shapes the plan. ".repeat(40) +
    "\n\n```loom\n" +
    JSON.stringify({ actions }, null, 2) +
    "\n```\n"
  );
}

describe("keeping an orchestrator's plan intact", () => {
  /**
   * The exact sizes from the run that exposed this. Each was destroyed by the
   * old 20k tail cap and each must now survive.
   */
  it.each([
    [6, 4_000],
    [5, 5_000],
    [5, 4_400],
    [8, 6_000],
  ])("keeps a %i-task plan whose prompts are %i characters each", (tasks, chars) => {
    const reply = plan(tasks, chars);
    expect(reply.length).toBeGreaterThan(20_000); // the size that used to lose it

    // What the old cap did, spelled out so the regression is unmistakable.
    const oldWay = parseOrchestraActions(reply.slice(-20_000));
    expect(oldWay, "the old cap really did destroy this").toBeNull();

    // What it does now.
    const kept = parseOrchestraActions(capTurnText(reply));
    expect(kept).not.toBeNull();
    expect(kept).toHaveLength(tasks);
    expect(kept!.every((a) => a.type === "spawn")).toBe(true);
  });

  it("still bounds memory when the text really is enormous", () => {
    const huge = "noise ".repeat(200_000); // ~1.2MB, no actions block in it
    const kept = capTurnText(huge);
    expect(kept.length).toBeLessThanOrEqual(TURN_TEXT_LIMIT);
    // It keeps the tail, which is where a reply's payload would be.
    expect(huge.endsWith(kept)).toBe(true);
  });

  /**
   * The cut is made at the block, not at an offset — so even a reply with
   * megabytes of preamble keeps its plan.
   */
  it("cuts at the start of the block rather than a character count", () => {
    const reply = "preamble. ".repeat(60_000) + plan(4, 500);
    expect(reply.length).toBeGreaterThan(TURN_TEXT_LIMIT);
    const kept = capTurnText(reply);
    expect(kept.startsWith("```loom")).toBe(true);
    expect(parseOrchestraActions(kept)).toHaveLength(4);
  });

  /** An untagged fence carrying a bare object is the other shape models emit. */
  it("keeps a bare {\"actions\"} payload too", () => {
    const body = JSON.stringify({ actions: [{ type: "spawn", id: "t1", title: "a", agent: "codex", prompt: "p" }] });
    const reply = "prose. ".repeat(80_000) + "\n" + body;
    const kept = capTurnText(reply);
    expect(parseOrchestraActions(kept)).toHaveLength(1);
  });

  it("leaves a short reply exactly as it was", () => {
    const reply = plan(2, 10);
    expect(reply.length).toBeLessThan(TURN_TEXT_LIMIT);
    expect(capTurnText(reply)).toBe(reply);
  });

  /**
   * A reply genuinely cut off mid-block — the model stopped — must still be
   * reported as unparseable. Recovering it would mean inventing the tasks.
   */
  it("does not pretend a reply that really was truncated is fine", () => {
    const reply = plan(5, 3_000);
    const half = reply.slice(0, reply.indexOf("```loom") + 9_000); // no closing fence
    expect(parseOrchestraActions(capTurnText(half))).toBeNull();
  });
});
