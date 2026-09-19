/**
 * The team brain's view model: grouping memories by tier and turning inbox
 * items into daemon calls. Plain node (type stripping), no React Native:
 *
 *   cd app && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrainInboxItem, BrainMemory } from "../src/api.ts";
import {
  attribution,
  groupMemories,
  historyOf,
  inboxActions,
  mergeKeeper,
  openableUrl,
} from "../src/team-brain-model.ts";

const mem = (id: string, over: Partial<BrainMemory> = {}): BrainMemory => ({
  id,
  text: `memory ${id}`,
  kind: "fact",
  tier: "proposed",
  author: "bob",
  confirmedBy: ["bob"],
  mine: false,
  state: "live",
  ...over,
});

describe("groupMemories", () => {
  it("orders Canon, Confirmed, Yours, Proposed and drops empty tiers", () => {
    const out = groupMemories([
      mem("p1"),
      mem("o1", { tier: "own", author: "alice", mine: true }),
      mem("c1", { tier: "canon", author: null, confirmedBy: [] }),
    ]);
    assert.deepEqual(out.map((s) => s.label), ["Canon", "Yours", "Proposed"]);
    assert.deepEqual(out.map((s) => s.items.map((m) => m.id)), [["c1"], ["o1"], ["p1"]]);
  });

  it("leaves resolved memories to history and sorts the most confirmed first", () => {
    const all = [
      mem("a", { tier: "confirmed", confirmedBy: ["bob", "carol"] }),
      mem("b", { tier: "confirmed", confirmedBy: ["bob", "carol", "dan"] }),
      mem("gone", { state: "superseded", resolvedBy: "alice" }),
      mem("a"), // a duplicate id never shows twice
    ];
    const out = groupMemories(all);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.items.map((m) => m.id), ["b", "a"]);
    assert.deepEqual(historyOf(all).map((m) => m.id), ["gone"]);
  });
});

describe("attribution", () => {
  it("says who and how many confirmed", () => {
    assert.equal(attribution(mem("x")), "by @bob");
    assert.equal(attribution(mem("x", { tier: "confirmed", confirmedBy: ["bob", "carol"] })), "by @bob · confirmed by 2");
    assert.equal(attribution(mem("x", { tier: "own", mine: true, author: "alice", confirmedBy: ["alice"] })), "yours");
    assert.match(attribution(mem("x", { tier: "canon", author: null })), /^canon/);
  });
});

describe("inboxActions", () => {
  const a = mem("A", { tier: "confirmed", confirmedBy: ["bob", "carol"] });
  const b = mem("B");

  it("correction and contradiction resolve either way", () => {
    for (const type of ["correction", "contradiction"] as const) {
      const acts = inboxActions({ id: "i", type, detail: "", a, b });
      assert.deepEqual(
        acts.map((x) => [x.label, x.action, x.body]),
        [
          ["Keep A", "resolve", { winner: "A", loser: "B", reason: type }],
          ["Keep B", "resolve", { winner: "B", loser: "A", reason: type }],
        ],
      );
    }
    assert.deepEqual(inboxActions({ id: "i", type: "correction", detail: "", a }), []);
  });

  it("duplicate merges into the more settled copy", () => {
    const [m] = inboxActions({ id: "i", type: "duplicate", detail: "", a: b, b: a });
    assert.equal(m!.action, "merge");
    assert.deepEqual(m!.body, { keep: "A", drop: "B" });
    assert.equal(m!.label, "Merge · keep B"); // A of the pair is `b` here
    assert.deepEqual(mergeKeeper(mem("x"), mem("y")), { keep: mem("x"), drop: mem("y") });
  });

  it("untrusted: trust asks first, private doesn't", () => {
    const acts = inboxActions({ id: "i", type: "untrusted", detail: "", a: b });
    assert.deepEqual(acts.map((x) => [x.action, x.body, Boolean(x.confirm)]), [
      ["trust", { id: "B" }, true],
      ["private", { id: "B" }, false],
    ]);
  });

  it("promote proposes the memory as canon", () => {
    const item: BrainInboxItem = { id: "i", type: "promote", detail: "", a };
    const [p] = inboxActions(item);
    assert.equal(p!.label, "Propose as canon");
    assert.deepEqual([p!.action, p!.body], ["promote", { ids: ["A"] }]);
  });
});

describe("openableUrl", () => {
  it("only lets web links out", () => {
    assert.equal(openableUrl("https://github.com/o/r/pull/1"), "https://github.com/o/r/pull/1");
    assert.equal(openableUrl("javascript:alert(1)"), null);
    assert.equal(openableUrl(null), null);
  });
});
