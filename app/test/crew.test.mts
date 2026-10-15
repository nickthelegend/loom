import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crewControls, crewSeatActivity, runnerCrewControls } from "../src/crew-model.ts";
import { notificationRoute } from "../src/team-runners-model.ts";
describe("crew phone state and actions", () => {
  it("keeps approvals explicit and does not resume uncertain native work", () => {
    assert.deepEqual(crewControls({ status: "awaiting_approval" }), ["pause", "stop", "approve"]);
    assert.deepEqual(crewControls({ status: "paused" }), ["stop", "resume"]);
    assert.deepEqual(crewControls({ status: "paused", recovery: "uncertain receipt" }), ["stop"]);
    assert.deepEqual(crewControls({ status: "completed", pr: {} }), []);
  });
  it("shows both active seats and only offers runner controls to its owner", () => {
    const crew = { active: [{ teammate: "a", step: "building", card: "one" }, { teammate: "b", step: "review", card: "two" }] };
    assert.equal(crewSeatActivity(crew, "a")?.card, "one"); assert.equal(crewSeatActivity(crew, "b")?.card, "two");
    const job = { mine: true, state: "claimed", progress: { status: "awaiting_approval", crew: {} } };
    assert.deepEqual(runnerCrewControls(job), ["approve", "stop"]);
    assert.deepEqual(runnerCrewControls({ ...job, mine: false }), []);
  });
  it("opens crew notifications on the right crew instead of the thread", () => {
    assert.deepEqual(notificationRoute({ projectId: "p", kind: "crew", crewId: "ship", chat: "crew-channel" }), { projectId: "p", tab: "crew", crewId: "ship" });
  });
});
