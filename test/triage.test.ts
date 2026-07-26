/**
 * Agent self-triage: root-cause an agent from its own traces. We stub the
 * ClickHouse (SigNoz) fetch and force the deterministic heuristic path so the
 * root cause + fix are asserted without a model call.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { parseAnthropicText, parseCliOutput, triageAgent } from "../src/observability/triage.js";

beforeAll(() => {
  process.env.LOOM_TRIAGE_NO_LLM = "1"; // deterministic: heuristic only
});
afterEach(() => vi.unstubAllGlobals());

function stubCh(rows: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => rows.map((r) => JSON.stringify(r)).join("\n") }) as unknown as Response),
  );
}

describe("agent self-triage", () => {
  it("root-causes a timeout from SigNoz spans, with the upstream handoff", async () => {
    const now = Date.now();
    stubCh([
      { ts: now, name: "loom.error", ms: 0, code: 2, msg: "tool_call 'bash' timed out after 30s", kind: "error", cost: 0, tin: 0, tout: 0 },
      { ts: now - 5000, name: "gen_ai.agent.turn", ms: 1200, code: 1, msg: "", kind: "run_complete", cost: 0.01, tin: 100, tout: 50 },
      { ts: now - 8000, name: "loom.baton.handoff", ms: 0, code: 1, msg: "opencode -> claude-code", kind: "handoff", cost: 0, tin: 0, tout: 0 },
    ]);
    const r = await triageAgent("claude-code");
    expect(r.from).toBe("backend");
    expect(r.errorCount).toBe(1);
    expect(r.source).toBe("heuristic");
    expect(r.rootCause).toMatch(/timed out/i);
    expect(r.rootCause).toMatch(/opencode/); // upstream surfaced
    expect(r.suggestedFix).toMatch(/timeout|timed out/i);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("falls back to the local event log when SigNoz is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const now = Date.now();
    const events: LoomEvent[] = [
      { id: 1, ts: now - 2000, kind: "handoff", payload: { from: "planner", to: "exec" } } as LoomEvent,
      { id: 2, ts: now - 1000, kind: "error", agentId: "exec", payload: { message: "401 unauthorized: not signed in" } } as LoomEvent,
    ];
    const r = await triageAgent("exec", events);
    expect(r.from).toBe("local-log");
    expect(r.errorCount).toBe(1);
    expect(r.rootCause).toMatch(/401|unauthor/i);
    expect(r.suggestedFix).toMatch(/sign|auth|key|permission/i);
  });

  it("reports healthy when there are no error spans", async () => {
    stubCh([{ ts: Date.now(), name: "gen_ai.agent.turn", ms: 300, code: 1, msg: "", kind: "run_complete", cost: 0.01, tin: 5, tout: 3 }]);
    const r = await triageAgent("plannerbot");
    expect(r.errorCount).toBe(0);
    expect(r.rootCause).toMatch(/healthy/i);
  });

  /**
   * The fallback path used to write `cost: 0` on every turn it derived from the
   * event log — not "we don't know", a measured-looking zero in the column where
   * the SigNoz path puts a real number. Nothing renders triage evidence costs
   * today, which is exactly why it survived: a fabricated figure that isn't
   * drawn yet is one render away from being believed. The log has the answer.
   */
  it("takes the turn's real cost from the log, not a zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const now = Date.now();
    const events: LoomEvent[] = [
      { id: 1, ts: now - 3000, kind: "run_complete", agentId: "spender",
        payload: { durationMs: 4200, costUsd: 0.0731, inputTokens: 900, outputTokens: 120 } } as LoomEvent,
      { id: 2, ts: now - 1000, kind: "error", agentId: "spender",
        payload: { message: "tool_call 'bash' timed out after 30s" } } as LoomEvent,
    ];
    const r = await triageAgent("spender", events);
    expect(r.from).toBe("local-log");
    const turn = r.evidence.find((s) => s.kind === "run_complete");
    expect(turn?.cost).toBe(0.0731);
  });

  it("returns no-data when SigNoz is empty and there is no fallback", async () => {
    stubCh([]);
    const r = await triageAgent("ghost");
    expect(r.source).toBe("no-data");
    expect(r.from).toBe("none");
  });
});

describe("triage LLM prose via the Anthropic API (works headless, no CLI needed)", () => {
  it("uses the ANTHROPIC_API_KEY path and returns source=llm", async () => {
    const prev = { key: process.env.ANTHROPIC_API_KEY, noLlm: process.env.LOOM_TRIAGE_NO_LLM };
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.LOOM_TRIAGE_NO_LLM; // allow the LLM path for this test
    // URL-aware fetch: ClickHouse gets rows; the Anthropic endpoint gets prose.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("api.anthropic.com")) {
          return {
            ok: true,
            json: async () => ({ content: [{ type: "text", text: "opencode timed out on turn 5; raise the deadline." }] }),
          } as unknown as Response;
        }
        const rows = [{ ts: Date.now(), name: "gen_ai.agent.turn", ms: 61000, code: 2, msg: "deadline exceeded", kind: "run_complete", cost: 0, tin: 5, tout: 0 }];
        return { ok: true, text: async () => rows.map((r) => JSON.stringify(r)).join("\n") } as unknown as Response;
      }),
    );
    const r = await triageAgent("opencode");
    expect(r.source).toBe("llm");
    expect(r.rootCause).toMatch(/timed out on turn 5/);
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
    if (prev.noLlm !== undefined) process.env.LOOM_TRIAGE_NO_LLM = prev.noLlm;
  });
});

describe("parseAnthropicText — reading an Anthropic /v1/messages reply", () => {
  it("concatenates text blocks", () => {
    expect(parseAnthropicText({ content: [{ type: "text", text: "root " }, { type: "text", text: "cause." }] })).toBe("root cause.");
  });
  it("returns null when there is no text", () => {
    expect(parseAnthropicText({ content: [] })).toBeNull();
    expect(parseAnthropicText({})).toBeNull();
  });
});

describe("parseCliOutput — reading the claude CLI's print-mode reply", () => {
  it("pulls .result out of --output-format json", () => {
    const raw = JSON.stringify({ type: "result", is_error: false, result: "opencode crashed on turn 5; restart it." });
    expect(parseCliOutput(raw)).toBe("opencode crashed on turn 5; restart it.");
  });
  it("returns null for an empty result (the child-session case)", () => {
    expect(parseCliOutput(JSON.stringify({ is_error: false, result: "" }))).toBeNull();
  });
  it("returns null when the CLI reports an error", () => {
    expect(parseCliOutput(JSON.stringify({ is_error: true, result: "Not logged in" }))).toBeNull();
  });
  it("falls back to raw text for a non-JSON (older CLI) reply", () => {
    expect(parseCliOutput("  the agent timed out; raise the deadline.  ")).toBe("the agent timed out; raise the deadline.");
  });
  it("returns null for blank output", () => {
    expect(parseCliOutput("   ")).toBeNull();
  });
});
