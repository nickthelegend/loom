import { describe, expect, it } from "vitest";
import { buildBriefing, buildProjection } from "../src/core/projection.js";
import type { LoomEvent, ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  name: "demo",
  agents: [
    { id: "plannerbot", kind: "echo", role: "planner" },
    { id: "execbot", kind: "echo", role: "executor" },
  ],
};

let id = 0;
function ev(kind: LoomEvent["kind"], payload: Record<string, unknown>, agentId?: string): LoomEvent {
  return { id: ++id, ts: 1_700_000_000_000 + id * 1000, kind, payload, ...(agentId ? { agentId } : {}) };
}

const events: LoomEvent[] = [
  ev("message", { text: "build me a parser", author: "user" }),
  ev("message", { text: "plan: tokenize then parse" }, "plannerbot"),
  ev("decision", { text: "use recursive descent" }),
  ev("file_edit", { path: "src/parser.ts" }, "plannerbot"),
  ev("handoff", { from: "plannerbot", to: "execbot" }),
  ev("message", { text: "x".repeat(500) }, "execbot"),
];

describe("projection", () => {
  it("renders roles, decisions, conversation, files — and marks the target", () => {
    const out = buildProjection({
      projectName: "demo",
      config,
      events,
      targetAgentId: "execbot",
      fromAgentId: "plannerbot",
    });
    expect(out).toContain("# Loom shared context — demo");
    expect(out).toContain("`execbot` (echo) — executor ← you");
    expect(out).toContain("use recursive descent");
    expect(out).toContain("**user**: build me a parser");
    expect(out).toContain("`src/parser.ts`");
    expect(out).toContain("plannerbot → execbot");
    expect(out).toContain("Do not edit");
  });

  it("truncates long messages", () => {
    const out = buildProjection({
      projectName: "demo",
      config,
      events,
      targetAgentId: "execbot",
    });
    expect(out).not.toContain("x".repeat(400));
    expect(out).toContain("…");
  });

  it("briefing is one-shot handoff context, pointing at the memory file", () => {
    const briefing = buildBriefing({
      projectName: "demo",
      config,
      events,
      targetAgentId: "execbot",
      fromAgentId: "plannerbot",
    });
    expect(briefing).toContain('[Loom handoff] You are "execbot"');
    expect(briefing).toContain('from "plannerbot"');
    expect(briefing).toContain(".loom/memory/execbot.md");
    expect(briefing).toContain("use recursive descent");
    expect(briefing.length).toBeLessThan(3000);
  });
});
