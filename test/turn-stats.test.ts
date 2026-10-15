/** The leaderboard, heatmap and CSV — straight off run_complete and error events. */

import { describe, expect, it } from "vitest";
import { leaderboard, perDay, trustByAgent, turnRows, turnsCsv } from "../src/core/turn-stats.js";
import type { LoomEvent } from "../src/types.js";

const DAY = 86_400_000;
const now = new Date(2026, 8, 24, 12).getTime();
let id = 0;
const ev = (kind: string, agentId: string, payload: Record<string, unknown>, ts = now): LoomEvent =>
  ({ id: ++id, ts, kind, agentId, payload }) as LoomEvent;

const events = [
  ev("run_complete", "codex", { durationMs: 1000, costUsd: 0.1, inputTokens: 10, outputTokens: 5 }),
  ev("run_complete", "codex", { durationMs: 3000, costUsd: 0.3 }),
  ev("error", "codex", { message: 'quota, "exceeded"\nstack...' }, now - DAY),
  ev("run_complete", "echo", { durationMs: 20 }, now - 2 * DAY),
  ev("message", "echo", { text: "not a turn" }),
];

describe("turn stats", () => {
  it("reads turns off run_complete and error only", () => {
    const rows = turnRows(events);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatchObject({ ok: false, error: 'quota, "exceeded"' });
  });

  it("ranks by clean finishes, with medians and cost per turn", () => {
    const lb = leaderboard(turnRows(events));
    expect(lb.map((a) => a.agentId)).toEqual(["echo", "codex"]);
    const codex = lb[1]!;
    expect(codex).toMatchObject({ turns: 3, ok: 2, errors: 1, medianMs: 2000, tokens: 15 });
    expect(codex.successRate).toBeCloseTo(2 / 3);
    expect(codex.avgCostUsd).toBeCloseTo(0.2);
    expect(lb[0]!.avgCostUsd).toBeNull(); // echo reported no cost: no average, not $0
  });

  it("counts every day in the window, zeros included", () => {
    const days = perDay(turnRows(events), 7, now);
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ turns: 2, errors: 0 });
    expect(days[5]).toMatchObject({ turns: 1, errors: 1 });
    expect(days[0]!.turns).toBe(0);
  });

  it("quotes CSV cells that need it", () => {
    const csv = turnsCsv(turnRows(events)).trim().split("\n");
    expect(csv[0]).toBe("time,agent,chat,ok,duration_ms,cost_usd,input_tokens,output_tokens,model,error");
    expect(csv[3]).toContain('"quota, ""exceeded"""');
  });
});

describe("trust: did its done hold up?", () => {
  it("counts Proof's verdicts on each agent's turns, and the times the loop watch and the shield caught it", () => {
    const t = trustByAgent([
      ev("proof", "", { about: "codex", verdict: "verified" }),
      ev("proof", "", { about: "codex", verdict: "verified" }),
      ev("proof", "", { about: "codex", verdict: "contradicted" }),
      ev("proof", "", { about: "opencode", verdict: "unverified" }),
      ev("status", "opencode", { state: "loop_detected" }),
      ev("status", "codex", { state: "shield_tripped" }),
      ev("status", "codex", { state: "turn_cost", costUsd: 1 }),
    ]);
    expect(t.codex).toEqual({ verified: 2, contradicted: 1, unverified: 0, holdRate: 2 / 3, loops: 0, shield: 1 });
    // nothing checked either way: no rate to give
    expect(t.opencode).toEqual({ verified: 0, contradicted: 0, unverified: 1, holdRate: null, loops: 1, shield: 0 });
  });
});
