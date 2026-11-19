import assert from "node:assert/strict";
import { test } from "node:test";
import { teamShareInput, shareOpenLabel, teamLibraryLabel, annotationLabel, mentionShareUrl } from "../src/sharing-model.ts";
test("phone sharing payloads preserve chat, passcode and teammate intent", () => {
  assert.deepEqual(teamShareInput("pass", "side", { login: "@bob", note: "Continue", preset: "1d", passcode: "1234", notifyFirstOpen: true }), { chat: "side", pass: "bob", note: "Continue", preset: "1d", passcode: "1234", notifyFirstOpen: true });
  assert.equal(teamShareInput("changes", "main", { preset: "1h" }).changes, true);
  assert.equal(teamShareInput("review", "main", { login: "alice", preset: "7d" }).review, "alice");
  assert.throws(() => teamShareInput("pass", "main", { preset: "1d", login: "bad/login" }));
  assert.throws(() => teamShareInput("chat", "main", { preset: "1d", passcode: "x" }));
});
test("phone distinguishes Team entries and annotations and explains link usage", () => {
  assert.equal(teamLibraryLabel({ name: "Build", source: "team" }), "Build · Team");
  assert.equal(teamLibraryLabel({ name: "Build" }), "Build · Personal");
  assert.equal(annotationLabel({ name: "Bob", verdict: "request-changes" }), "Bob · Changes requested");
  assert.equal(annotationLabel({ name: "Bob", messageId: 8 }), "Bob · message #8");
  assert.equal(shareOpenLabel({}), "0 views · Never opened");
  assert.match(shareOpenLabel({ views: 3, lastOpenedAt: Date.now(), passcodeProtected: true }), /3 views.*Passcode/);
});

test("hand-off mentions open only HTTP(S) share links", () => {
  const url = "https://example.test/share/" + "a".repeat(32);
  assert.equal(mentionShareUrl("@bob Chat hand-off: " + url), url);
  assert.equal(mentionShareUrl("javascript:alert(1)"), null);
  assert.equal(mentionShareUrl("https://user:pass@example.test/share/" + "a".repeat(32)), null);
});
