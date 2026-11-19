import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expiryPresets, filterTeamActivity, shareCountdown } from "../src/sharing-model.ts";

describe("#424 phone sharing", () => {
  it("offers all three presets and counts down through expiry", () => {
    assert.deepEqual(expiryPresets.map(p => p.value), ["1h", "1d", "7d"]);
    assert.equal(shareCountdown(90061000, 0), "1d 1h 1m 1s left");
    assert.equal(shareCountdown(1000, 999), "0d 0h 0m 1s left");
    assert.equal(shareCountdown(1000, 1000), "Expired");
    assert.equal(shareCountdown(1000, 2000), "Expired");
  });
  it("filters team starts, both merge events, and mentions by person or repo", () => {
    const feed = [{ type: "goal_started", github: "alice", repo: "acme/api" }, { type: "goal_landed", github: "alice", repo: "acme/web" },
      { type: "pr_merged", github: "bob", repo: "acme/api" }, { type: "mention", github: "bob", meta: { to: "alice" } }];
    assert.equal(filterTeamActivity(feed, "pr_merged", "").length, 2);
    assert.equal(filterTeamActivity(feed, "goal_started", "ALICE").length, 1);
    assert.equal(filterTeamActivity(feed, "pr_merged", "api")[0]?.github, "bob");
    assert.equal(filterTeamActivity(feed, "mention", "alice").length, 1);
    assert.equal(filterTeamActivity(feed, "goal_started", "unknown").length, 0);
  });
});

it("routes only team mention pushes to the Team screen", async () => {
  const { isTeamMention } = await import("../src/sharing-model.ts");
  assert.equal(isTeamMention({ screen: "team", kind: "mention" }), true);
  assert.equal(isTeamMention({ kind: "orchestra", projectId: "p" }), false);
  assert.equal(isTeamMention(null), false);
});

it("completes teammate mentions without treating email addresses as mentions", async () => {
  const { mentionQuery, insertMention } = await import("../src/sharing-model.ts");
  assert.equal(mentionQuery("review @Al"), "al");
  assert.equal(mentionQuery("mail@alice"), null);
  assert.equal(insertMention("review @al", "alice"), "review @alice ");
});
