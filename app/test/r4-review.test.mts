import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_REFRESH_MS, hunkRequest, reviewProgress, viewedRequest } from "../src/r4-review-model.ts";
test("viewed requests retain the reviewed version and chat/run context", () => {
  const file = { path: "a.ts", version: "original", patch: "+a", viewed: false };
  assert.deepEqual(viewedRequest(file, "chat-a", "run-a"), { chat: "chat-a", run: "run-a", path: "a.ts", version: "original", viewed: true });
  assert.equal(viewedRequest({ ...file, viewed: true }, "chat-b").viewed, false);
  assert.equal(reviewProgress({ viewed: 7, total: 12 }), "7 of 12 viewed");
});
test("hunk actions carry an exact server version and hunk id", () => {
  assert.deepEqual(hunkRequest("a.ts", "snapshot", "hunk", "discard"), { path: "a.ts", version: "snapshot", id: "hunk", action: "discard" });
});

test("review screens leave at least a minute between background refreshes", () => {
  assert.ok(REVIEW_REFRESH_MS >= 60_000);
});
