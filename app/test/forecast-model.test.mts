/** The phone's pre-flight forecast line. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approxTime, forecastLine } from "../src/forecast-model.ts";

describe("pre-flight forecast", () => {
  it("says what a turn usually costs and takes", () => {
    assert.deepEqual(forecastLine({ turns: 12, ms: { typical: 100_000, high: 200_000 }, usd: { typical: 0.12, high: 0.4 } }),
      { text: "~$0.12 · 1m 40s a turn, from its last 12", warn: false });
  });

  it("time only for an agent that reports no spend; nothing before it has turns", () => {
    assert.deepEqual(forecastLine({ turns: 3, ms: { typical: 42_000, high: 60_000 } }), { text: "~42s a turn, from its last 3", warn: false });
    assert.equal(forecastLine(undefined), null);
  });

  it("warns when one more long turn could cross the day's budget", () => {
    const l = forecastLine({ turns: 5, ms: { typical: 30_000, high: 30_000 }, usd: { typical: 0.5, high: 1 }, budget: { capUsd: 5, spentUsd: 4.5, mayCross: true } });
    assert.deepEqual(l, { text: "~$0.50 · 30s a turn, from its last 5 · $4.50 of $5.00 today — one more long turn could cross it", warn: true });
  });

  it("rounds time the way a person says it", () => {
    assert.equal(approxTime(9_400), "9s");
    assert.equal(approxTime(125_000), "2m 5s");
    assert.equal(approxTime(14 * 60_000 + 20_000), "14m");
  });
});
