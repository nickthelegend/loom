import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunOptions } from "../src/orchestra-options.ts";

test("phone Orchestra options preserve approval, budget, fleet limits and webhook", () => {
  assert.deepEqual(parseRunOptions("2.50", "5", "echo=2,codex=1", " https://example.com/hook ", true), {
    maxUsd: 2.5, stallMinutes: 5, kindLimits: { echo: 2, codex: 1 }, webhookUrl: "https://example.com/hook", planOnly: true,
  });
  assert.equal(parseRunOptions("", "", "", "", false).maxUsd, undefined);
});
test("phone rejects invalid caps and parallel counts before sending", () => {
  for (const bad of ["echo=0", "echo=1.5", "echo=2=3", "=2", "echo=101"]) assert.throws(() => parseRunOptions("", "", bad, "", false));
  for (const bad of ["0", "-1", "Infinity", "NaN"]) assert.throws(() => parseRunOptions(bad, "", "", "", false));
});
