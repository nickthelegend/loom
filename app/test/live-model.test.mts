/**
 * Live replies on the phone: pieces and the snapshot folded into one text.
 *
 *   cd app && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEvent, applyStream, seed, type LiveMap } from "../src/live-model.ts";

describe("a reply as it's typed", () => {
  it("appends pieces in order and skips a repeat", () => {
    let m: LiveMap = {};
    m = applyStream(m, { agentId: "a", text: "Hel", off: 0 });
    m = applyStream(m, { agentId: "a", text: "lo ", off: 3 });
    m = applyStream(m, { agentId: "a", text: "lo ", off: 3 });
    m = applyStream(m, { agentId: "a", text: "world", off: 6 });
    assert.equal(m.a!.text, "Hello world");
  });

  it("opened mid-reply: the snapshot and the pieces around it make the whole reply once", () => {
    // a piece arrived before the first page did
    let m = applyStream({}, { agentId: "a", text: "gamma ", off: 11 });
    m = seed(m, [{ agentId: "a", chat: "main", text: "alpha beta gamma " }], "main");
    assert.equal(m.a!.text, "alpha beta gamma ");
    m = applyStream(m, { agentId: "a", text: "gamma ", off: 11 }); // late duplicate
    m = applyStream(m, { agentId: "a", text: "delta", off: 17 });
    assert.equal(m.a!.text, "alpha beta gamma delta");
  });

  it("ignores another thread's snapshot", () => {
    assert.deepEqual(seed({}, [{ agentId: "a", chat: "c2", text: "x" }], "main"), {});
  });

  it("the finished message or the turn's end takes the typing away", () => {
    const m = applyStream({}, { agentId: "a", text: "hi", off: 0 });
    assert.deepEqual(applyEvent(m, { kind: "message", agentId: "a", payload: { text: "hi" } }), {});
    assert.deepEqual(applyEvent(m, { kind: "status", agentId: "a", payload: { state: "interrupted" } }), {});
    assert.equal(applyEvent(m, { kind: "tool_call", agentId: "a", payload: {} }), m);
  });

  it("shows thinking until words arrive", () => {
    let m = applyStream({}, { agentId: "a", text: "hmm", reasoning: true });
    assert.equal(m.a!.thinking, true);
    m = applyStream(m, { agentId: "a", text: "Answer", off: 0 });
    assert.deepEqual(m.a, { text: "Answer", base: 0, thinking: false });
  });
});
