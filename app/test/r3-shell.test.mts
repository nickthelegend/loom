import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCENTS, accentOf, parseLocation } from "../src/shell-model.ts";
import { scopeOf } from "../src/cache-model.ts";

describe("#422 device shell preferences", () => {
  it("restores each preset and rejects corrupt or inherited names", () => {
    for (const key of Object.keys(ACCENTS)) assert.equal(accentOf(key), key);
    for (const bad of [null, {}, "constructor", "unknown", ""]) assert.equal(accentOf(bad), "cyan");
    assert.equal(ACCENTS.violet[1], "#6d28d9");
  });
  it("round-trips the selected project, chat and tab with no credentials", () => {
    const saved = { project: "alpha", chat: "planning", tab: "memory" };
    assert.deepEqual(parseLocation(JSON.stringify(saved)), saved);
    assert.deepEqual(parseLocation(JSON.stringify({ ...saved, token: "never-copy" })), saved);
    assert.notEqual(scopeOf("http://machine-a"), scopeOf("http://machine-b"));
  });
  it("ignores missing or damaged session state", () => {
    for (const raw of [null, "{", "null", "{}", "[]", '{"project":3}', '{"project":"","chat":"main","tab":"thread"}']) assert.equal(parseLocation(raw), null);
  });
});
