import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryPriority, memoryQuery } from "../src/memory-model.ts";

describe("#419 phone memory controls", () => {
  it("encodes every search filter, including chat IDs and date bounds", () => {
    const route = memoryQuery({ q: "sqlite & tests", kind: "decision", agent: "echo", since: "2026-01-01", until: "2026-01-31", chat: "one/two", includeArchived: true });
    assert.ok(route.startsWith("/search?"));
    const params = new URLSearchParams(route.slice(8));
    assert.equal(params.get("q"), "sqlite & tests");
    assert.equal(params.get("kind"), "decision");
    assert.equal(params.get("author"), "echo");
    assert.equal(params.has("agent"), false);
    assert.equal(params.get("since"), "2026-01-01");
    assert.equal(params.get("until"), "2026-01-31");
    assert.equal(params.get("chat"), "one/two");
    assert.equal(params.get("includeArchived"), "1");
    assert.ok(memoryQuery({ q: " " }).startsWith("?"));
  });
  it("rejects invalid priorities before sending a mutation", () => {
    assert.equal(memoryPriority(" -1000 "), -1000);
    assert.equal(memoryPriority("1000"), 1000);
    for (const value of ["", "1.5", "NaN", "Infinity", "1001"]) assert.throws(() => memoryPriority(value));
  });
});
