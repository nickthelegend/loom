/**
 * Landing's view model: chips, which buttons a goal PR's card shows, the
 * badge count and the cost summary. Plain node (type stripping):
 *
 *   cd app && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdoptablePr, LandingGoal, LandingState } from "../src/api.ts";
import {
  STATE_CHIP,
  adoptConfirm,
  costSummary,
  dollars,
  landBlockedNote,
  landingBadge,
  landingButtons,
  reviewLine,
  sortGoals,
  stateChip,
} from "../src/team-landing-model.ts";

const landing = (over: Partial<LandingState> = {}): LandingState => ({
  pr: 7,
  url: "https://github.com/o/r/pull/7",
  state: "green",
  headSha: "abc",
  fixAttempts: 0,
  flaky: [],
  reviews: 1,
  ...over,
});

const goal = (runId: string, over: Partial<LandingState> = {}, g: Partial<LandingGoal> = {}): LandingGoal => ({
  runId,
  goal: `goal ${runId}`,
  status: "completed",
  costUsd: 1.5,
  landing: landing(over),
  ...g,
});

const adoptable = (pr: number): AdoptablePr => ({
  pr,
  url: `https://github.com/o/r/pull/${pr}`,
  branch: `loom/orchestra/r${pr}/x`,
  owner: "bob",
  reason: "needs someone",
});

describe("stateChip", () => {
  it("colours each state and flags the one that needs you", () => {
    assert.deepEqual(stateChip("needs_human"), { label: "needs you", tone: "err", attention: true });
    assert.equal(stateChip("green").tone, "ok");
    assert.equal(stateChip("failing").tone, "err");
    assert.equal(stateChip("fixing").tone, "warn");
    assert.equal(stateChip("pending").tone, "live");
    assert.equal(stateChip("merged").tone, "merged");
    const attention = Object.entries(STATE_CHIP).filter(([, c]) => c.attention).map(([k]) => k);
    assert.deepEqual(attention, ["needs_human"]);
  });

  it("an unknown state from a newer daemon gets a quiet chip", () => {
    assert.deepEqual(stateChip("parked"), { label: "parked", tone: "dim", attention: false });
  });

  it("Phase 6: queued in the landing train is a known, quiet chip; no Land button; it says who it waits behind", () => {
    assert.deepEqual(STATE_CHIP.queued, { label: "queued", tone: "dim", attention: false });
    const g = goal("q1", { state: "queued", landRequested: true, train: true, reason: "waiting behind bob's goal in lane api" });
    assert.deepEqual(landingButtons(g), ["review"]);
    assert.equal(landBlockedNote(g), "Queued to land — waiting behind bob's goal in lane api.");
  });
});

describe("landingButtons", () => {
  it("a finished green goal offers Land and Re-review", () => {
    assert.deepEqual(landingButtons(goal("a")), ["land", "review"]);
  });

  it("Override shows only for a failed review not yet overridden", () => {
    const failed = { state: "failure" as const, reviewer: "bot", high: 2, findings: 5 };
    assert.deepEqual(landingButtons(goal("a", { review: failed })), ["land", "override", "review"]);
    assert.deepEqual(landingButtons(goal("a", { review: { ...failed, overridden: "false alarm" } })), ["land", "review"]);
    assert.deepEqual(landingButtons(goal("a", { review: { ...failed, state: "success" } })), ["land", "review"]);
  });

  it("no Land while the goal runs, for an adopted goal, or once landing", () => {
    assert.deepEqual(landingButtons(goal("a", {}, { status: "running" })), ["review"]);
    const adopted = { branch: "loom/x", pr: 7, url: "", owner: "bob" };
    assert.deepEqual(landingButtons(goal("a", {}, { adopted })), ["review"]);
    assert.deepEqual(landingButtons(goal("a", { state: "landing", landRequested: true })), []);
    assert.deepEqual(landingButtons(goal("a", { state: "pending", landRequested: true })), ["review"]);
  });

  it("Land again after landing stopped on a human", () => {
    assert.deepEqual(landingButtons(goal("a", { state: "needs_human", landRequested: true })), ["land", "review"]);
  });

  it("nothing on a merged or closed PR; no Re-review without a commit", () => {
    assert.deepEqual(landingButtons(goal("a", { state: "merged" })), []);
    assert.deepEqual(landingButtons(goal("a", { state: "closed" })), []);
    assert.deepEqual(landingButtons(goal("a", { headSha: undefined })), ["land"]);
  });
});

describe("landBlockedNote", () => {
  it("says why Land is missing", () => {
    assert.match(landBlockedNote(goal("a", {}, { status: "waiting_human" }))!, /still waiting human/);
    assert.match(landBlockedNote(goal("a", {}, { adopted: { branch: "b", pr: 1, url: "", owner: "bob" } }))!, /@bob/);
    assert.match(landBlockedNote(goal("a", { state: "landing" }))!, /Land requested/);
    assert.equal(landBlockedNote(goal("a")), null);
    assert.equal(landBlockedNote(goal("a", { state: "merged" })), null);
  });
});

describe("reviewLine", () => {
  it("reads the review result", () => {
    assert.equal(reviewLine(undefined), null);
    assert.equal(reviewLine({ state: "failure", reviewer: "codex", high: 2, findings: 5 }), "review failed · 2 high of 5 · codex");
    assert.equal(reviewLine({ state: "success", reviewer: null, high: 0, findings: 1 }), "review passed · 1 finding");
    assert.equal(reviewLine({ state: "skipped", reviewer: null, high: 0, findings: 0 }), "review skipped");
    assert.equal(
      reviewLine({ state: "failure", reviewer: null, high: 1, findings: 1, overridden: "style only" }),
      "review overridden: style only",
    );
  });
});

describe("landingBadge and sortGoals", () => {
  it("counts goals that need a human plus adoptable PRs", () => {
    const t = {
      goals: [goal("a", { state: "needs_human" }), goal("b", { state: "failing" }), goal("c", { state: "needs_human" })],
      adoptable: [adoptable(9)],
    };
    assert.equal(landingBadge(t), 3);
    assert.equal(landingBadge({ goals: [], adoptable: [] }), 0);
    assert.equal(landingBadge(null), 0);
  });

  it("puts what needs you first and done PRs last", () => {
    const out = sortGoals([
      goal("merged", { state: "merged", updatedAt: 9 }),
      goal("old", { state: "green", updatedAt: 1 }),
      goal("new", { state: "fixing", updatedAt: 5 }),
      goal("needs", { state: "needs_human", updatedAt: 0 }),
    ]);
    assert.deepEqual(out.map((g) => g.runId), ["needs", "new", "old", "merged"]);
  });
});

describe("adoptConfirm", () => {
  it("names whose branch your agents will work on", () => {
    assert.match(adoptConfirm(adoptable(9)), /^Your agents will work on bob's branch/);
  });
});

describe("costSummary", () => {
  it("keeps today's rows per member and passes the totals through", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const c = costSummary(
      {
        byMemberDay: [
          { member: "alice", day: "2026-09-19", usd: 1.25, goals: 1 },
          { member: "bob", day: "2026-09-19", usd: 3, goals: 2 },
          { member: "bob", day: "2026-09-18", usd: 10, goals: 4 },
        ],
        landed: 2,
        totalUsd: 14.25,
        perLandedPrUsd: 7.13,
      },
      now,
    )!;
    assert.deepEqual(c.today.map((r) => r.member), ["bob", "alice"]);
    assert.equal(c.todayUsd, 4.25);
    assert.equal(c.perLandedPrUsd, 7.13);
    assert.equal(costSummary(null), null);
  });

  it("formats dollars, zero included", () => {
    assert.equal(dollars(0), "$0.00");
    assert.equal(dollars(2.5), "$2.50");
    assert.equal(dollars(null), "—");
  });
});
