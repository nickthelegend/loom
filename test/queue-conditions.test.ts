/**
 * Prompts queued for later, and queues worth keeping.
 *
 * A condition is a promise about when something runs, so the risk is a prompt
 * that goes early (the thing you were avoiding happens anyway) or one that
 * never goes at all (silently lost). Both are tested here against a real
 * runtime, with a real clock.
 */

import { afterEach, describe, expect, it } from "vitest";

import { describeCondition, parseCondition } from "../src/core/prompt-queue.js";
import { deleteRecipe, getRecipe, listRecipes, roleToTarget, saveRecipe, targetToRole } from "../src/core/recipes.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

async function open() {
  process.env.LOOM_HOME = tmpDir("home-cond");
  const dir = makeProjectDir({ name: "cond", agents: [{ id: "echo", kind: "echo", role: "builder" }] });
  rt = await ProjectRuntime.open({ id: `cond-${Date.now()}`, name: "cond", dir });
  return rt;
}

const prompts = (r: ProjectRuntime) =>
  r.log.list({ kinds: ["message"] }).filter((e) => !e.agentId).map((e) => String(e.payload.text));

describe("reading a condition", () => {
  it("takes the ways a time arrives, and refuses the rest", () => {
    const at = parseCondition({ kind: "at", at: 1789000000000 });
    expect(at).toEqual({ kind: "at", at: 1789000000000 });
    expect(parseCondition({ kind: "at", at: "2026-09-21T03:00:00Z" })).toMatchObject({ kind: "at" });
    expect(parseCondition({ kind: "landed", runId: "o7x" })).toEqual({ kind: "landed", runId: "o7x" });
    expect(parseCondition({ kind: "quiet", ms: 600_000 })).toEqual({ kind: "quiet", ms: 600_000 });
    // a quiet period longer than a day is almost certainly a mistake
    expect(parseCondition({ kind: "quiet", ms: 99 * 3_600_000 })).toEqual({ kind: "quiet", ms: 86_400_000 });
    expect(parseCondition(undefined)).toBeUndefined();
    expect(() => parseCondition({ kind: "at", at: "half past tuesday" })).toThrow(/time I can read/);
    expect(() => parseCondition({ kind: "landed" })).toThrow(/needs the goal/);
    expect(() => parseCondition({ kind: "vibes" })).toThrow(/unknown condition/);
  });

  it("says what it's waiting for in words", () => {
    expect(describeCondition({ kind: "landed", runId: "o7x" })).toContain("o7x");
    expect(describeCondition({ kind: "checks-green", runId: "o7x" })).toMatch(/green/);
    expect(describeCondition({ kind: "quiet", ms: 600_000 })).toMatch(/10 quiet minutes/);
  });
});

describe("a prompt held for a time", () => {
  it("doesn't go early, and goes once the moment passes", async () => {
    const r = await open();
    const soon = Date.now() + 1200;
    const item = r.enqueue({ text: "later, please", target: { kind: "agent", agentId: "echo" }, when: { kind: "at", at: soon } });
    expect(r.queueBlocker(item)).toMatch(/waiting until/);

    await new Promise((res) => setTimeout(res, 400));
    expect(prompts(r)).toEqual([]); // still held

    await waitUntil(() => prompts(r).includes("later, please"), { timeoutMs: 20_000 });
    expect(Date.now()).toBeGreaterThanOrEqual(soon);
  }, 40_000);

  it("a time already past is simply due", async () => {
    const r = await open();
    r.enqueue({ text: "overdue", target: { kind: "agent", agentId: "echo" }, when: { kind: "at", at: Date.now() - 60_000 } });
    await waitUntil(() => prompts(r).includes("overdue"), { timeoutMs: 15_000 });
  }, 30_000);

  it("a condition about a goal that doesn't exist releases it rather than stranding it", async () => {
    const r = await open();
    const item = r.enqueue({ text: "after a ghost", target: { kind: "agent", agentId: "echo" }, when: { kind: "landed", runId: "never-was" } });
    expect(r.queueBlocker(item)).toBeNull();
    await waitUntil(() => prompts(r).includes("after a ghost"), { timeoutMs: 15_000 });
  }, 30_000);

  it("clearing the condition lets it go", async () => {
    const r = await open();
    const item = r.enqueue({
      text: "eventually",
      target: { kind: "agent", agentId: "echo" },
      when: { kind: "at", at: Date.now() + 3_600_000 },
    });
    expect(r.queueBlocker(item)).toMatch(/waiting until/);
    r.editQueued(item.id, { when: null });
    await waitUntil(() => prompts(r).includes("eventually"), { timeoutMs: 15_000 });
  }, 30_000);
});

describe("recipes", () => {
  it("saves by role, so a recipe travels between projects", () => {
    process.env.LOOM_HOME = tmpDir("home-recipes");
    const roleOf = (id: string) => ({ "claude-code": "planner", codex: "builder" })[id];
    expect(targetToRole({ kind: "agent", agentId: "claude-code" }, roleOf)).toBe("planner");
    expect(targetToRole({ kind: "orchestra" }, roleOf)).toBe("orchestra");
    expect(targetToRole({ kind: "auto" }, roleOf)).toBe("auto");
    // an agent with no role keeps its id — better than losing where it goes
    expect(targetToRole({ kind: "agent", agentId: "grok" }, () => undefined)).toBe("grok");
  });

  it("resolves a role against whatever this project happens to call its agents", () => {
    const agents = [
      { id: "a1", role: "planner", kind: "claude-code" },
      { id: "b2", role: "builder", kind: "codex" },
    ];
    expect(roleToTarget("planner", agents)).toEqual({ kind: "agent", agentId: "a1" });
    expect(roleToTarget("codex", agents)).toEqual({ kind: "agent", agentId: "b2" }); // by kind
    expect(roleToTarget("b2", agents)).toEqual({ kind: "agent", agentId: "b2" }); // by id
    expect(roleToTarget("orchestra", agents)).toEqual({ kind: "orchestra" });
    // nothing matches: Auto, not a refusal — the prompt is still editable
    expect(roleToTarget("reviewer", agents)).toEqual({ kind: "auto" });
  });

  it("keeps them, lists them, replaces by name and removes them", () => {
    process.env.LOOM_HOME = tmpDir("home-recipes2");
    saveRecipe({ name: "ship", steps: [{ text: "run the tests", to: "builder" }, { text: "open the PR", to: "auto" }] });
    expect(listRecipes()[0]).toMatchObject({ name: "ship" });
    expect(getRecipe("ship")!.steps).toHaveLength(2);

    saveRecipe({ name: "ship", steps: [{ text: "only this now", to: "auto" }] });
    expect(listRecipes()).toHaveLength(1); // replaced, not duplicated
    expect(getRecipe("ship")!.steps).toHaveLength(1);

    expect(deleteRecipe("ship")).toBe(true);
    expect(deleteRecipe("ship")).toBe(false);
    expect(listRecipes()).toEqual([]);
  });

  it("refuses a name or a shape that would bite later", () => {
    process.env.LOOM_HOME = tmpDir("home-recipes3");
    expect(() => saveRecipe({ name: "", steps: [{ text: "x", to: "auto" }] })).toThrow(/usable recipe name/);
    expect(() => saveRecipe({ name: "../escape", steps: [{ text: "x", to: "auto" }] })).toThrow(/usable recipe name/);
    expect(() => saveRecipe({ name: "empty", steps: [] })).toThrow(/no steps/);
    expect(() => saveRecipe({ name: "blank", steps: [{ text: "   ", to: "auto" }] })).toThrow(/needs something to say/);
  });
});
