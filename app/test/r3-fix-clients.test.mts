/**
 * Round 3 phone fixes (#430): a stale 401, and the feed coming back.
 *
 *   cd app && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/r3-fix-clients.test.mts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeMissed, reconcileLive, type LiveMap } from "../src/live-model.ts";
import { forgetRevoked, upsertMachine } from "../src/machines-model.ts";

describe("#430.9 a 401 forgets the computer it came from", () => {
  const two = () => {
    const a = upsertMachine([], { url: "http://a:7420", token: "ta" }, { id: "a" });
    return upsertMachine(a.list, { url: "http://b:7420", token: "tb" }, { id: "b" }).list;
  };

  it("a late 401 from A, after switching to B, removes A and leaves B active", () => {
    const out = forgetRevoked(two(), "b", { url: "http://a:7420", token: "ta" });
    assert.deepEqual(out.list.map((m) => m.id), ["b"]);
    assert.equal(out.activeId, "b");
    assert.equal(out.wasActive, false); // the screen you're on stays put
  });

  it("the active one revoked: it goes and the next carries on", () => {
    const out = forgetRevoked(two(), "a", { url: "http://a:7420", token: "ta" });
    assert.deepEqual(out.list.map((m) => m.id), ["b"]);
    assert.equal(out.activeId, "b");
    assert.equal(out.wasActive, true);
  });

  it("a second 401 for the same token, or one for a token since replaced, changes nothing", () => {
    const once = forgetRevoked(two(), "a", { url: "http://a:7420", token: "ta" });
    const again = forgetRevoked(once.list, once.activeId, { url: "http://a:7420", token: "ta" });
    assert.equal(again.removed, null);
    assert.deepEqual(again.list.map((m) => m.id), ["b"]); // B survives the repeat
    const repaired = upsertMachine(two(), { url: "http://a:7420", token: "ta2" }).list;
    assert.equal(forgetRevoked(repaired, "a", { url: "http://a:7420", token: "ta" }).removed, null);
  });
});

describe("#430.10 the feed coming back", () => {
  const ev = (id: number, chat?: string) => ({ id, kind: "message", ...(chat ? { chat } : {}) });

  it("folds in what was missed: this chat's, once each, in order", () => {
    const shown = [ev(1, "main"), ev(2, "main"), ev(5, "main")]; // 5 arrived live after reconnecting
    const missed = [ev(3, "main"), ev(4, "side"), ev(5, "main"), ev(6)];
    assert.deepEqual(mergeMissed(shown, missed, "main").map((e) => e.id), [1, 2, 3, 5, 6]);
    assert.equal(mergeMissed(shown, [], "main"), shown);
  });

  it("drops a half-reply that finished while away, and takes the daemon's text for one still going", () => {
    const m: LiveMap = { a: { text: "Hel", base: 0, thinking: false }, b: { text: "par", base: 0, thinking: false } };
    const out = reconcileLive(m, [{ agentId: "b", chat: "main", text: "partial reply so far" }], "main");
    assert.deepEqual(Object.keys(out), ["b"]);
    assert.equal(out.b!.text, "partial reply so far");
    // an older daemon sends no snapshot: nothing is known, nothing changes
    assert.equal(reconcileLive(m, undefined, "main"), m);
  });
});
