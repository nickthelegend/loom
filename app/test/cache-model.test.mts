/** What the phone keeps offline. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCached, savedAgo, scopeOf, threadKey, touch, trimEvents } from "../src/cache-model.ts";

describe("offline cache", () => {
  it("keeps the most recently opened threads and evicts the oldest", () => {
    let idx: string[] = [];
    const evicted: string[] = [];
    for (const k of ["a", "b", "c", "a", "d"]) {
      const r = touch(idx, k, 3);
      idx = r.index;
      evicted.push(...r.evict);
    }
    assert.deepEqual(idx, ["d", "a", "c"]);
    assert.deepEqual(evicted, ["b"]);
  });

  it("keeps only a thread's tail", () => {
    assert.deepEqual(trimEvents([1, 2, 3, 4, 5], 2), [4, 5]);
    assert.deepEqual(trimEvents([1], 2), [1]);
  });

  it("names a file safely whatever the ids hold", () => {
    assert.equal(threadKey("ab12", "../x y"), "thread-ab12-_x_y");
    assert.match(threadKey("p", "c/d"), /^[\w-]+$/);
  });

  it("keeps each daemon's copy apart", () => {
    assert.equal(scopeOf("http://10.0.0.2:7420"), scopeOf("http://10.0.0.2:7420"));
    assert.notEqual(scopeOf("http://10.0.0.2:7420"), scopeOf("http://10.0.0.3:7420"));
    assert.match(scopeOf("https://x.example"), /^[0-9a-z]+$/);
  });

  it("says how old a copy is", () => {
    const now = 1_000_000_000;
    assert.equal(savedAgo(now - 5_000, now), "saved just now");
    assert.equal(savedAgo(now - 5 * 60_000, now), "saved 5 min ago");
    assert.equal(savedAgo(now - 3 * 3_600_000, now), "saved 3 h ago");
    assert.equal(savedAgo(now - 26 * 3_600_000, now), "saved 1 day ago");
  });

  it("treats a torn or foreign file as no cache", () => {
    assert.equal(parseCached("{not json"), null);
    assert.equal(parseCached(JSON.stringify({ hello: 1 })), null);
    assert.deepEqual(parseCached(JSON.stringify({ at: 1, data: [1] })), { at: 1, data: [1] });
  });
});
