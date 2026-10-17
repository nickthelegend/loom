import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { formatAgentRosterRow, formatAgentRow, formatProjectRow } from "../src/cli/ui.js";
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

describe("what the roster says honestly (#251, #252, #257)", () => {
  it("a signed-out agent isn't ready, and says how to sign in", () => {
    const row = plain(formatAgentRow(agent({ id: "grok-code", kind: "grok-code", signedOut: "Not signed in. — run `grok` once and sign in" })));
    expect(row).toMatch(/^ ○ grok-code/);
    expect(row).toContain("not signed in: Not signed in. — run `grok` once and sign in");
    expect(plain(formatAgentRosterRow(agent({ signedOut: "no session" })))).toMatch(/^ ○ .*not signed in: no session/);
  });

  it("a read-only model agent holds the baton read-only, not 'can hold'", () => {
    const row = plain(formatAgentRosterRow(agent({ id: "or", kind: "model", readOnly: true })));
    expect(row).toContain("baton: read-only (answers, can't edit)");
    expect(row).not.toContain("can hold");
  });

  it("a project with an agent mid-turn is working, not idle", () => {
    const base = { id: "p", name: "reach", dir: "/x", holder: "claude-code", needsInput: false, lastEvent: null, agents: [agent({ id: "claude-code", busy: true })] };
    expect(plain(formatProjectRow(base as never))).toContain("◐ working (claude-code)");
    expect(plain(formatProjectRow({ ...base, agents: [agent()] } as never))).toContain("○ idle");
  });
});
