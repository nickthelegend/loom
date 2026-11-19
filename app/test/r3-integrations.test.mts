import assert from "node:assert/strict";
import { test } from "node:test";
import { INTAKE_SOURCES, integrationPatch } from "../src/integrations-model.ts";

test("Jira is available and blank secrets preserve saved credentials", () => {
  assert.deepEqual(INTAKE_SOURCES, ["github", "linear", "jira"]);
  assert.deepEqual(integrationPatch({ port: "465", password: "", host: "smtp.example.com" }, ["port"], ["password"]), { port: 465, host: "smtp.example.com" });
  assert.deepEqual(integrationPatch({ key: "abc" }, [], ["key"]), { key: "abc" });
  assert.throws(() => integrationPatch({ port: "NaN" }, ["port"]), /number/);
  assert.throws(() => integrationPatch({ port: "" }, ["port"]), /number/);
});
