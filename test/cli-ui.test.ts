import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { formatAgentRosterRow } from "../src/cli/ui.js";
import type { AgentStatus } from "../src/types.js";

// picocolors turns colour on under CI=true; assert on the words, not the escapes.
const plain = (s: string) => stripVTControlCharacters(s);

function agent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: "codex",
    kind: "codex",
    role: "executor",
    tier: "adapter",
    available: true,
    busy: false,
    holdsBaton: false,
    model: "gpt-5",
    ...overrides,
  };
}

describe("CLI agent roster", () => {
  it("shows each agent's id, kind, role, configured model, and baton eligibility", () => {
    const row = plain(formatAgentRosterRow(agent()));

    expect(row).toContain("codex");
    expect(row).toContain("role: executor");
    expect(row).toContain("model: gpt-5");
    expect(row).toContain("baton: can hold");
  });

  it("labels bridges as unable to hold the baton and uses the default model label", () => {
    const row = plain(formatAgentRosterRow(agent({ id: "kiro", kind: "kiro", tier: "bridge", model: "" })));

    expect(row).toContain("kiro");
    expect(row).toContain("model: default");
    expect(row).toContain("baton: cannot hold");
  });
});
