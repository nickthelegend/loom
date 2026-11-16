import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleText } from "../src/trigger-model.ts";

test("says a schedule the way a person would", () => {
  assert.equal(scheduleText({ kind: "schedule", everyMin: 30 }), "every 30 min");
  assert.equal(scheduleText({ kind: "schedule", everyMin: 60 }), "every hour");
  assert.equal(scheduleText({ kind: "schedule", everyMin: 180 }), "every 3 hours");
  assert.equal(scheduleText({ kind: "schedule", cron: "0 9 * * *" }), "every day at 09:00");
  assert.equal(scheduleText({ kind: "schedule", cron: "30 7 * * 1-5" }), "weekdays at 07:30");
  assert.equal(scheduleText({ kind: "schedule", cron: "@weekly" }), "every Sunday");
  assert.equal(scheduleText({ kind: "schedule", cron: "*/5 * * * 2" }), "cron */5 * * * 2");
  assert.equal(scheduleText({ kind: "webhook" }), "on a webhook");
});
