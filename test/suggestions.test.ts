import { describe, expect, it } from "vitest";
import { suggestHandoff } from "../src/core/suggestions.js";
import type { LoomEvent, ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  name: "demo",
  agents: [
    { id: "plannerbot", kind: "echo", role: "planner" },
    { id: "execbot", kind: "echo", role: "executor" },
    { id: "reviewbot", kind: "echo", role: "reviewer" },
  ],
};

function msg(text: string, agentId?: string): LoomEvent {
  return { id: 1, ts: Date.now(), kind: "message", payload: { text }, ...(agentId ? { agentId } : {}) };
}

describe("suggested handoffs", () => {
  it("planner finishing a plan → suggest executor", () => {
    const s = suggestHandoff(msg("The plan is complete and ready to execute.", "plannerbot"), config, "plannerbot");
    expect(s).toMatchObject({ to: "execbot" });
  });

  it("executor finishing → suggest reviewer", () => {
    const s = suggestHandoff(msg("Implementation is complete, all tests passing.", "execbot"), config, "execbot");
    expect(s).toMatchObject({ to: "reviewbot" });
  });

  it("no suggestion for ordinary chatter", () => {
    expect(suggestHandoff(msg("still thinking about the schema", "plannerbot"), config, "plannerbot")).toBeNull();
  });

  it("no suggestion from a non-holder or from the user", () => {
    expect(suggestHandoff(msg("plan is complete", "plannerbot"), config, "execbot")).toBeNull();
    expect(suggestHandoff(msg("plan is complete"), config, "plannerbot")).toBeNull();
  });

  it("no suggestion when the target role doesn't exist", () => {
    const soloConfig: ProjectConfig = {
      name: "solo",
      agents: [{ id: "plannerbot", kind: "echo", role: "planner" }],
    };
    expect(
      suggestHandoff(msg("plan is complete", "plannerbot"), soloConfig, "plannerbot"),
    ).toBeNull();
  });
});
