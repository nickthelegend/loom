/**
 * The Loom pet's mood, from what the agents are doing (desktop/pet-model.js).
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error — the desktop shell's plain-JS module
import { describeTool, petState } from "../desktop/pet-model.js";

const now = 1_000_000;
const proj = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, holder: "opencode", needsInput: false, agents: [{ id: "opencode", busy: false }], ...extra });

describe("the pet", () => {
  it("puts a question first, with the question in the bubble", () => {
    const s = petState(
      [proj("a", { agents: [{ id: "codex", busy: true }] }), proj("b", { needsInput: true })],
      { b: [{ id: 1, ts: now, kind: "needs_input", agentId: "opencode", chat: "main", payload: { question: "Cats or Dogs?" } }] },
      now,
    );
    expect(s).toMatchObject({ mood: "alert", title: "OpenCode needs you", sub: "Cats or Dogs?", project: "b", chat: "main" });
  });

  it("says what a working agent last did", () => {
    const s = petState([proj("loom", { agents: [{ id: "opencode", busy: true }] })], {
      loom: [{ id: 1, ts: now - 50, kind: "tool_call", agentId: "opencode", chat: "c1", payload: { tool: "bash", summary: "npm test" } }],
    }, now);
    expect(s).toMatchObject({ mood: "work", title: "loom · OpenCode", sub: "Ran npm test", chat: "c1" });
  });

  it("cheers a turn that just finished, then goes idle, then dozes", () => {
    const done = { loom: [{ id: 1, ts: now - 2000, kind: "run_complete", agentId: "codex", payload: { durationMs: 18_400 } }] };
    expect(petState([proj("loom")], done, now)).toMatchObject({ mood: "happy", title: "Codex is done", sub: "loom · 18s" });
    expect(petState([proj("loom")], done, now + 20_000, now).mood).toBe("idle");
    expect(petState([proj("loom")], done, now + 200_000, now).mood).toBe("sleep");
  });

  it("words tool calls the way you'd say them", () => {
    expect(describeTool({ tool: "read", summary: "README.md" })).toBe("Read README.md");
    expect(describeTool({ tool: "edit", summary: "src/a.ts" })).toBe("Edited src/a.ts");
    expect(describeTool({ tool: "todowrite" })).toBe("Updated the plan");
    expect(describeTool({ tool: "bash", summary: "make", exitCode: 2 })).toBe("Ran make — failed");
  });
});
