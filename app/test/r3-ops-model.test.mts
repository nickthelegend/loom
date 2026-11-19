import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { opsActionText, opsBytes, policyInput, projectOpsPath, staleReapPath } from "../src/ops-model.ts";

describe("R3 phone operations", () => {
  it("encodes project and agent identities and uses the stale-only reap route", () => {
    assert.equal(projectOpsPath("a/b"), "/api/projects/a%2Fb/ops");
    assert.equal(staleReapPath("a/b", "x?y"), "/api/projects/a%2Fb/stale/x%3Fy/reap");
  });
  it("validates both worktree limits before enabling an action", () => {
    assert.deepEqual(policyInput("7", "3"), { days: 7, keep: 3 });
    assert.deepEqual(policyInput("0", "0"), { days: 0, keep: 0 });
    for (const [days, keep] of [["", "2"], ["NaN", "3"], ["-1", "2"], ["3", "1.5"], ["3", "10001"]]) assert.throws(() => policyInput(days!, keep!));
  });
  it("reports repairs, previews, skipped trees and scheduling in plain language", () => {
    assert.equal(opsActionText({ fixed: ["cleared missing agent"], unfixable: ["duplicate id"], summary: { failures: 1 } }), "Fixed: cleared missing agent\nNeeds attention: duplicate id\nRemaining failing checks: 1");
    assert.equal(opsActionText({ dryRun: true, candidates: ["old"], skipped: [{ id: "dirty", reason: "uncommitted files" }] }), "Dry run: 1 run would be pruned.\nold\nKept dirty: uncommitted files");
    assert.equal(opsActionText({ backup: null }), "Backup schedule disabled.");
    assert.equal(opsActionText({ respawned: true }), "Session reaped and restarted.");
  });
  it("formats small and large byte totals consistently", () => {
    assert.equal(opsBytes(0), "0.00 MB");
    assert.equal(opsBytes(1572864), "1.50 MB");
  });
});
