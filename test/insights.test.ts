/**
 * The Agent Health Score is a pure function of an agent's spans, so it is
 * asserted here without a live ClickHouse — the same math the Observatory badge
 * renders. Each penalty bucket is exercised in isolation, then together.
 */

import { describe, expect, it } from "vitest";
import { healthScore, type InsightSpan } from "../src/observability/insights.js";

const NOW = 1_700_000_000_000;

function turn(over: Partial<InsightSpan> = {}): InsightSpan {
  return {
    traceId: "t", spanId: "s", ts: NOW - 60_000, name: "gen_ai.agent.turn", ms: 800, code: 1, msg: "",
    agent: "opencode", ade: "opencode", model: "m", tin: 1000, tout: 100, cost: 0, handoffFrom: "", handoffTo: "",
    ...over,
  };
}
function errSpan(over: Partial<InsightSpan> = {}): InsightSpan {
  return turn({ name: "loom.error", code: 2, msg: "boom", ...over });
}

describe("healthScore", () => {
  it("is 100 / healthy for a clean history", () => {
    const h = healthScore([turn(), turn(), turn()], NOW);
    expect(h.score).toBe(100);
    expect(h.grade).toBe("healthy");
    expect(h.buckets).toEqual({ errorRate: 0, latency: 0, tokenBloat: 0, recency: 0 });
  });

  it("penalises the error rate (up to 40) and counts errors", () => {
    // 2 errors out of 4 spans → 50% → 20 point error-rate penalty
    const h = healthScore([turn(), turn(), errSpan({ ts: NOW - 40 * 60_000 }), errSpan({ ts: NOW - 50 * 60_000 })], NOW);
    expect(h.buckets.errorRate).toBe(20);
    expect(h.errorCount).toBe(2);
  });

  it("penalises slow turns over 30s (latency bucket)", () => {
    const h = healthScore([turn({ ms: 45_000 }), turn({ ms: 500 })], NOW);
    expect(h.buckets.latency).toBe(Math.round(0.5 * 25)); // half the turns are slow
  });

  it("penalises token bloat above the 80k comfort line", () => {
    const h = healthScore([turn({ tin: 200_000 })], NOW); // 120k over → full 20
    expect(h.buckets.tokenBloat).toBe(20);
  });

  it("penalises a very recent error and fades it over 30 minutes", () => {
    const fresh = healthScore([turn(), errSpan({ ts: NOW })], NOW);
    const stale = healthScore([turn(), errSpan({ ts: NOW - 40 * 60_000 })], NOW);
    expect(fresh.buckets.recency).toBe(15); // just now → full
    expect(stale.buckets.recency).toBe(0); // >30 min → gone
  });

  it("clamps to 0 and grades unhealthy when everything is on fire", () => {
    // error TURNS (name=gen_ai.agent.turn, code=2) so all four buckets fire:
    // errorRate 40 + latency 25 + tokenBloat 20 + recency 15 = 100 → clamps to 0.
    const onFire = turn({ code: 2, ms: 90_000, tin: 300_000, ts: NOW });
    const h = healthScore([onFire, { ...onFire, ts: NOW - 1000 }], NOW);
    expect(h.score).toBe(0);
    expect(h.grade).toBe("unhealthy");
  });

  it("grades a middling score as degraded", () => {
    // one slow error out of four spans: errorRate 10 + latency ~6 + recency 15 = ~69
    const spans = [turn(), turn(), turn({ ms: 40_000 }), errSpan({ ts: NOW })];
    const h = healthScore(spans, NOW);
    expect(h.score).toBeGreaterThanOrEqual(50);
    expect(h.score).toBeLessThan(80);
    expect(h.grade).toBe("degraded");
  });
});
