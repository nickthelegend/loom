/** Unread chats on the phone. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markRead, unreadChats } from "../src/seen-model.ts";

describe("unread chats", () => {
  it("baselines a chat it has never seen instead of calling it unread", () => {
    const r = unreadChats([{ id: "a", lastReplyId: 10 }], {}, "main");
    assert.equal(r.unread.size, 0);
    assert.deepEqual(r.seen, { a: 10 });
  });
  it("flags newer replies, except in the chat you're in", () => {
    const r = unreadChats([{ id: "a", lastReplyId: 12 }, { id: "b", lastReplyId: 9 }, { id: "main", lastReplyId: 30 }], { a: 10, b: 9, main: 1 }, "main");
    assert.deepEqual([...r.unread], ["a"]);
  });
  it("only ever moves the read mark forward", () => {
    assert.deepEqual(markRead({ a: 5 }, "a", 3), { a: 5 });
    assert.deepEqual(markRead({ a: 5 }, "a", 8), { a: 8 });
  });
});
