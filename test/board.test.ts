/**
 * The board's judgement: what a pull request is actually waiting on, and which
 * column that puts it in. This is the whole feature — a card that says
 * "Ready to merge" when CI is red is worse than no board at all.
 */

import { describe, expect, it } from "vitest";
import { columnFor, prState, type BoardState } from "../src/daemon/board.js";

/** gh's real shape, trimmed to what prState reads. */
const pr = (over: Record<string, unknown> = {}) =>
  ({
    number: 1,
    title: "t",
    state: "OPEN",
    updatedAt: "2026-07-16T00:00:00Z",
    url: "https://github.com/o/r/pull/1",
    statusCheckRollup: [],
    ...over,
  }) as Parameters<typeof prState>[0];

describe("prState", () => {
  it("calls a red build red, whatever the reviewers said", () => {
    // a failure outranks everything: approved + broken is not ready to merge
    for (const bad of ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR"]) {
      expect(prState(pr({ statusCheckRollup: [{ conclusion: bad }], reviewDecision: "APPROVED" }))).toBe(
        "ci-failed",
      );
    }
  });

  it("does not mistake a queued or skipped check for a failure", () => {
    // gh reports SKIPPED for irrelevant jobs and PENDING/IN_PROGRESS mid-run;
    // treating those as red would put half of every repo in Needs you
    const checks = [{ conclusion: "SKIPPED" }, { state: "PENDING" }, { conclusion: "SUCCESS" }];
    expect(prState(pr({ statusCheckRollup: checks }))).toBe("review-pending");
  });

  it("puts changes-requested ahead of draft", () => {
    expect(prState(pr({ reviewDecision: "CHANGES_REQUESTED", isDraft: true }))).toBe(
      "changes-requested",
    );
  });

  it("does not call a draft 'waiting on a reviewer'", () => {
    expect(prState(pr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" }))).toBe("draft");
  });

  it("only claims 'ready' when checks actually ran and passed", () => {
    expect(prState(pr({ reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }))).toBe(
      "ready",
    );
    // approved but no CI at all: say approved, don't imply a green build
    expect(prState(pr({ reviewDecision: "APPROVED", statusCheckRollup: [] }))).toBe("approved");
    expect(prState(pr({ reviewDecision: "APPROVED", statusCheckRollup: null }))).toBe("approved");
  });

  it("treats an unreviewed open PR as review-pending", () => {
    expect(prState(pr({ reviewDecision: "REVIEW_REQUIRED" }))).toBe("review-pending");
    expect(prState(pr({ reviewDecision: "" }))).toBe("review-pending");
    expect(prState(pr({}))).toBe("review-pending");
  });
});

describe("columnFor", () => {
  it("routes every state to exactly one column", () => {
    const states: BoardState[] = [
      "working",
      "input-needed",
      "ci-failed",
      "changes-requested",
      "review-pending",
      "draft",
      "approved",
      "ready",
    ];
    for (const s of states) expect(columnFor(s), s).toBeTruthy();
  });

  it("puts everything that wants a human in Needs you", () => {
    expect(columnFor("input-needed")).toBe("needs-you");
    expect(columnFor("ci-failed")).toBe("needs-you");
    expect(columnFor("changes-requested")).toBe("needs-you");
  });

  it("keeps work in flight out of the merge column", () => {
    expect(columnFor("working")).toBe("working");
    expect(columnFor("draft")).toBe("in-review");
    expect(columnFor("review-pending")).toBe("in-review");
    expect(columnFor("ready")).toBe("ready");
    expect(columnFor("approved")).toBe("ready");
  });
});
