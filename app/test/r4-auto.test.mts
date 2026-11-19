import assert from "node:assert/strict";
import { test } from "node:test";
import { automationInput, automationStatus, emptyAutomation, quietDefaults } from "../src/r4-auto-model.ts";

test("phone schedules require a matching preview and produce the daemon contract", () => {
  const d = emptyAutomation(); d.prompt = "Review docs";
  assert.throws(() => automationInput(d, ""), /Preview/);
  assert.equal(automationInput(d, d.when).when, "every weekday at 9am");
  d.when = "every day at 9am"; assert.throws(() => automationInput(d, "every weekday at 9am"));
  d.when = ""; d.condition = "clean";
  assert.throws(() => automationInput(d, ""), /Preview/);
  assert.equal(automationInput(d, "", true).when, undefined);
  assert.equal(automationInput(d, "", true).condition, "clean");
});
test("phone covers every trigger kind and action", () => {
  for (const [kind, key] of [["file", "onChange"], ["event", "on"], ["branch", "onCommit"], ["url", "watchUrl"]] as const) {
    const d = { ...emptyAutomation(), kind, when: "value", action: "route" as const, target: "review", condition: "clean" };
    const body = automationInput(d, ""); assert.equal(body[key], "value"); assert.equal(body.route, "review"); assert.equal(body.condition, "clean");
  }
  assert.equal(automationInput({ ...emptyAutomation(), kind: "webhook", action: "recipe", target: "daily" }, "").recipe, "daily");
  assert.equal(automationInput({ ...emptyAutomation(), kind: "event", action: "orchestrate" }, "").orchestrate, true);
  assert.equal(automationStatus({ hold: "automation quiet hours", held: 4 }), "automation quiet hours · 4 held");
});

test("scoped boolean controls open safely without exposing quiet-hour details", () => {
  assert.deepEqual(quietDefaults(true), { range: "22:00-07:00", days: "mon-fri" });
  assert.deepEqual(quietDefaults(false), quietDefaults());
  assert.deepEqual(quietDefaults({ range: "23:00-06:00", days: [1, 5] }), { range: "23:00-06:00", days: "mon,fri" });
});
