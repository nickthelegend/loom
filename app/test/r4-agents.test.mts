import assert from "node:assert/strict";
import { it } from "node:test";
import { filterSessionChats, environmentEntry, policyInput, retryNotice, sessionState } from "../src/r4-agents-model.ts";
it("filters archived chats and labels together without exposing hidden chats in search", () => {
  const chats = [{ id: "1", title: "Fix bug", labels: [{ name: "bug", color: "#ff0000" }] }, { id: "2", title: "Old bug", archived: true, labels: [{ name: "bug", color: "#ff0000" }] }, { id: "3", title: "Docs" }];
  assert.deepEqual(filterSessionChats(chats, false, "bug").map(c => c.id), ["1"]);
  assert.deepEqual(filterSessionChats(chats, true, "bug", "old").map(c => c.id), ["2"]);
  assert.deepEqual(filterSessionChats(chats, false, "", "old"), []);
  assert.deepEqual(filterSessionChats(chats, true, "bug", "message contents", ["2"]).map(c => c.id), ["2"]);
  assert.deepEqual(filterSessionChats(chats, false, "bug", "message contents", ["2"]), []);
});
it("preserves environment values literally and rejects malformed names", () => {
  assert.deepEqual(environmentEntry("KEY=a=b $HOME"), { key: "KEY", value: "a=b $HOME" });
  assert.deepEqual(environmentEntry("KEY="), { key: "KEY", value: "" });
  assert.throws(() => environmentEntry("BAD KEY=x")); assert.throws(() => environmentEntry("missing"));
});
it("reports sleep without hiding a running agent and validates retry policies", () => {
  assert.equal(sessionState({ asleep: true }), "Asleep"); assert.equal(sessionState({ asleep: true, busy: true }), "Working");
  assert.deepEqual(policyInput("1.5", "10", "2", "3"), { maxTurnMinutes: 1.5, idleSleepMinutes: 10, retries: { count: 2, waitSeconds: 3 } });
  assert.throws(() => policyInput("bad", "0", "0", "0")); assert.throws(() => policyInput("0", "0", "11", "0"));
});
it("shows the active retry until that agent completes or is stopped", () => {
  const retry = { id: 1, kind: "status", agentId: "echo", payload: { state: "turn_retry", text: "Retry 1 of 2 in 5s" } };
  assert.equal(retryNotice([retry]), "Retry 1 of 2 in 5s");
  assert.equal(retryNotice([retry, { id: 2, kind: "run_complete", agentId: "other", payload: {} }]), "Retry 1 of 2 in 5s");
  assert.equal(retryNotice([retry, { id: 2, kind: "error", agentId: "echo", payload: { retrying: true } }]), "Retry 1 of 2 in 5s");
  assert.equal(retryNotice([retry, { id: 2, kind: "status", agentId: "echo", payload: { state: "interrupted" } }]), null);
  assert.equal(retryNotice([retry, { id: 2, kind: "run_complete", agentId: "echo", payload: {} }]), null);
});
