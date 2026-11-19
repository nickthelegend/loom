import assert from "node:assert/strict";
import { test } from "node:test";
import { gitDraftRequest, diffSummary } from "../src/git-review-model.ts";

test("PR and message drafts retain the active chat and selected review checklist", () => {
  assert.deepEqual(gitDraftRequest("pr", "chat-a", "security", ""), { route: "/git/pr-description", body: { chat: "chat-a", template: "security" }, field: "description" });
  assert.deepEqual(gitDraftRequest("message", "chat-b", "release", ""), { route: "/git/suggest-message", body: { chat: "chat-b" }, field: "message" });
});
test("CHANGELOG requests require an explicit merged branch", () => {
  assert.throws(() => gitDraftRequest("changelog", "main", "standard", "  "), /Choose a merged branch/);
  assert.deepEqual(gitDraftRequest("changelog", "main", "standard", " feature/parser "), { route: "/git/changelog", body: { branch: "feature/parser" }, field: "entry" });
});
test("diff statistics distinguish zero changes from missing attribution", () => {
  assert.equal(diffSummary({ added: 0, removed: 2, files: 1 }), "+0 / −2 · 1 files");
  assert.equal(diffSummary(), "No diff statistics yet");
});
