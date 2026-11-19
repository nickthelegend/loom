import { test } from "node:test";
import assert from "node:assert/strict";
import { configValidationText, standingDetail } from "../src/cli-tools-model.ts";

test("config validation presents paths, warnings and success on the phone", () => {
  assert.equal(configValidationText({ valid: true, errors: [], warnings: [] }), ".loom/config.json is valid");
  assert.equal(configValidationText({ valid: false, errors: [{ path: "agents.0.id", message: "duplicate" }], warnings: ["move model into options"] }), ".loom/config.json is invalid\nagents.0.id: duplicate\nWarning: move model into options");
});
test("scoreboard preserves unknown values and renders observed rates and costs", () => {
  assert.match(standingDetail({ key: "echo", turns: 0, winRate: null, finishedRate: null, medianMs: null, avgCostUsd: null }), /wins — · finishes —\nMedian — · per turn —/);
  assert.match(standingDetail({ key: "echo", turns: 3, winRate: 0.5, finishedRate: 1, medianMs: 1200, avgCostUsd: 0 }), /wins 50% · finishes 100%\nMedian 1.2s · per turn \$0.0000/);
});
