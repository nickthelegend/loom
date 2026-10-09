/**
 * Where the money and the tokens went. Each dollar lands once, on the turn
 * that spent it, so the breakdowns add up to the total.
 */

import { describe, expect, it } from "vitest";

import { usageReport } from "../src/core/usage.js";
import type { LoomEvent } from "../src/types.js";

let id = 0;
const ev = (kind: string, payload: Record<string, unknown>, agentId?: string, chat = "main", ts = Date.now()): LoomEvent =>
  ({ id: ++id, ts, kind, payload, chat, ...(agentId ? { agentId } : {}) }) as LoomEvent;

describe("the usage report", () => {
  it("counts a turn's dollars once, even when run_complete repeats them, and splits by model and chat", () => {
    const r = usageReport([
      ev("message", { text: "go" }),
      ev("status", { state: "turn_cost", costUsd: 0.4 }, "claude"),
      ev("run_complete", { costUsd: 0.4, model: "sonnet", inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, durationMs: 4000 }, "claude"),
      ev("run_complete", { costUsd: 0.1, model: "gpt", inputTokens: 500, outputTokens: 50, durationMs: 2000 }, "codex", "side"),
      ev("run_complete", { inputTokens: 300, outputTokens: 30, durationMs: 1000 }, "opencode"),
    ], { kinds: { claude: "claude-code" }, models: { opencode: "opencode/big-pickle" } });

    expect(r.totals.usd).toBeCloseTo(0.5);
    expect(r.totals.turns).toBe(3);
    expect(r.totals.tokensIn).toBe(1800);
    expect(r.totals.cachedIn).toBe(600);
    expect(r.totals.cacheHitRate).toBeCloseTo(600 / 1800);
    expect(r.totals.prompts).toBe(1);
    expect(r.totals.unpriced).toBe(1); // opencode reported tokens and no price
    expect(r.byAgent[0]).toMatchObject({ agentId: "claude", kind: "claude-code", usd: 0.4, models: ["sonnet"] });
    expect(r.byModel.map((m) => m.model)).toEqual(["sonnet", "gpt", "opencode/big-pickle"]);
    expect(r.byChat.find((c) => c.chat === "side")!.usd).toBeCloseTo(0.1);
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]!.usd).toBeCloseTo(0.5);
  });

  it("counts tools, failures, errors, questions and changed lines; ignores what came before `since`", () => {
    const old = Date.now() - 10 * 86_400_000;
    const r = usageReport([
      ev("run_complete", { costUsd: 9, inputTokens: 1 }, "codex", "main", old),
      ev("tool_call", { tool: "bash", ok: true }, "codex"),
      ev("tool_call", { tool: "bash", exitCode: 1 }, "codex"),
      ev("tool_call", { tool: "search", server: "web" }, "codex"),
      ev("error", { message: "boom" }, "codex"),
      ev("needs_input", { question: "?" }, "codex"),
      ev("turn_diff", { files: [{ path: "a" }, { path: "b" }], added: 12, removed: 3 }, "codex"),
    ], { since: Date.now() - 86_400_000 });
    expect(r.totals.usd).toBe(0);
    expect(r.byTool).toEqual([{ tool: "bash", calls: 2, failures: 1 }, { tool: "web.search", calls: 1, failures: 0 }]);
    expect(r.totals).toMatchObject({ toolCalls: 3, toolFailures: 1, errors: 1, questions: 1, filesChanged: 2, linesAdded: 12, linesRemoved: 3 });
  });
});
