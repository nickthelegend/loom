/**
 * The 1.2.1 round-3 stress test (#300–#322): five projects at once, with
 * restarts mid-run — pinned down.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { projectChecks } from "../src/cli/doctor.js";
import { findConflicts } from "../src/core/brain-index.js";
import { coldResume, observedInputRate } from "../src/core/prices.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ReviewRunner } from "../src/daemon/review.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { Memory } from "../src/core/brain.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

describe("#300 what a cold session really costs to re-read", () => {
  it("learns from the agent's own cold turns, else its blended rate — not the list price", () => {
    // REACH: a cold question cost $4.75 for 170k in (12k cached); the next cold one is priced from it
    const turns = [
      { costUsd: 4.75, tokensIn: 170_068, cachedIn: 12_164, tokensOut: 900 },
      { costUsd: 1.44, tokensIn: 291_055, cachedIn: 280_651, tokensOut: 1_461 },
    ];
    const rate = observedInputRate(turns)!;
    const est = coldResume({ tokens: 172_178, ageMs: 3 * 3_600_000, rate }, null).estUsd!;
    expect(est).toBeGreaterThan(4.5); // the real one cost $6.03; the list price said $0.34
    expect(est).toBeLessThan(6.5);
    // no cold turn yet: the blended rate, with the cache write on top
    expect(observedInputRate([turns[1]!])).toBeGreaterThan(1e-5);
    expect(observedInputRate([])).toBeNull();
  });
});

describe("#317 complementary accepted findings aren't a conflict", () => {
  const mem = (id: string, text: string): Memory => ({ id, kind: "decision", text, confidence: 1, createdAt: 0, updatedAt: 0, provenance: { agentId: "user", ts: 0 } } as unknown as Memory);
  it("two findings accepted on one file aren't flagged; a real negation still is", () => {
    const a = mem("a", "Review finding accepted (codex, medium): reach/server.py:40 — clear the Bedrock env vars in the test fixture — will do");
    const b = mem("b", "Review finding accepted (antigravity, medium): reach/server.py:88 — add an end-to-end test of the full utterance — yes");
    expect(findConflicts([a, b])).toEqual([]);
    const c = mem("c", "We use tabs for indentation in every Python file");
    const d = mem("d", "We do not use tabs for indentation in every Python file");
    expect(findConflicts([c, d])[0]).toMatchObject({ signal: "negation" });
  });
});

describe("#319 a signed-out agent can't hold the baton", () => {
  it("doctor doesn't count it", () => {
    const dir = makeProjectDir({ agents: [{ id: "a", kind: "echo", role: "worker" }, { id: "b", kind: "echo", role: "worker" }] });
    expect(projectChecks(dir).find((c) => c.name === "agents")!.detail).toMatch(/2 can hold the baton/);
    expect(projectChecks(dir, ["echo"]).find((c) => c.name === "agents")!.detail).toMatch(/0 can hold the baton \(a, b signed out\)/);
  });
});

describe("#311 a reviewer that never finishes is named up front", () => {
  it("no finished review and two left out: unreliable", () => {
    const done = (agent: string, status: string): LoomEvent => ({ id: 1, ts: 0, kind: "review", payload: { phase: "done", results: [{ agent, status, reply: "" }] } } as unknown as LoomEvent);
    const events = [done("opencode", "failed"), done("opencode", "failed"), done("codex", "done"), done("grok", "failed")];
    const r = new ReviewRunner({ list: () => events } as never);
    expect(r.unreliable(["opencode", "codex", "grok"])).toEqual(["opencode"]);
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-round3");
  process.env.LOOM_NO_NOTIFY = "1";
});

async function gitProject(name: string) {
  const dir = tmpDir(name);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: dir });
  writeProjectConfig(dir, { name, agents: [{ id: "lead", kind: "echo" }, { id: "codex", kind: "echo" }], defaultAgent: "lead", brain: { extractor: "off" } });
  rt = await ProjectRuntime.open({ id: `${name}-${path.basename(dir)}`, name, dir });
  return dir;
}

describe("in a project", () => {
  it("#313 a night shift starting on uncommitted edits says so, and how to put them back", async () => {
    const dir = await gitProject("r3-dirty");
    fs.writeFileSync(path.join(dir, "a.txt"), "left over\n");
    rt!.shifts.start({ tasks: ["one"], to: "lead" });
    const note = rt!.log.list({ kinds: ["status"] }).find((e) => e.payload.state === "dirty_start");
    expect(String(note?.payload.text)).toMatch(/This night shift starts on 1 uncommitted change already in the tree \(a\.txt\).*Rewind/);
    await waitUntil(() => rt!.log.list({ kinds: ["shift"] }).some((e) => e.payload.phase === "report"), { timeoutMs: 40_000 });
  }, 60_000);

  it("#318 decisions with stripped underscores are mended from the planner's own words", async () => {
    await gitProject("r3-repair");
    const finding = { id: "r1.1", agent: "codex", severity: "medium", file: "tests/test_reach.py", line: 36, text: "clear REACH_BEDROCK_MODEL in the fixture" };
    rt!.log.append({ kind: "review", chat: "c1", payload: { phase: "done", reviewId: "r1", findings: [finding], results: [] } });
    rt!.log.append({ kind: "message", agentId: "lead", chat: "c1", payload: { text: "ACCEPT r1.1 — set REACH_BEDROCK_MODEL to \"\" in tests/test_reach.py" } });
    // a decision is written twice, as it is in the wild: the event, and the memory that points at it
    const brokenText = "Review finding accepted (codex, medium): tests/test_reach.py:36 — clear REACH_BEDROCK_MODEL in the fixture — set REACHBEDROCKMODEL to \"\" in tests/testreach.py";
    const fixedText = "Review finding accepted (codex, medium): tests/test_reach.py:36 — clear REACH_BEDROCK_MODEL in the fixture — set REACH_BEDROCK_MODEL to \"\" in tests/test_reach.py";
    const event = rt!.log.append({ kind: "decision", payload: { text: brokenText, source: "review" } });
    const broken = rt!.brain.add({ kind: "decision", text: brokenText, provenance: { agentId: "user", eventId: event.id, ts: Date.now() } }).memory;

    // #326 a dry run says what it would change, and changes nothing
    const dry = rt!.repairDecisions({ dryRun: true });
    expect(dry).toMatchObject({ repaired: 1, checked: 1 });
    expect(dry.changes).toEqual([{ id: broken.id, before: brokenText, after: fixedText }]);
    expect(rt!.brain.get(broken.id)!.text).toBe(brokenText);

    expect(rt!.repairDecisions()).toMatchObject({ repaired: 1, checked: 1 });
    expect(rt!.brain.get(broken.id)!.text).toBe(fixedText);
    expect(rt!.repairDecisions().repaired).toBe(0);
    // #325 and what `loom memory` and every briefing read shows the mended text, not the record's
    const doc = rt!.unifiedMemory().document;
    expect(doc).toContain("set REACH_BEDROCK_MODEL to");
    expect(doc).not.toContain("REACHBEDROCKMODEL");
  });

  it("#321 a turn that would cross the daily budget doesn't start", async () => {
    await gitProject("r3-budget");
    // three turns of about $0.40 each: a typical turn here costs ~$0.40
    for (let i = 0; i < 3; i++) {
      rt!.log.append({ kind: "status", agentId: "lead", payload: { state: "turn_cost", costUsd: 0.4 } });
      rt!.log.append({ kind: "run_complete", agentId: "lead", payload: { durationMs: 1000 } });
    }
    await rt!.close();
    rt = await ProjectRuntime.open({ id: rt!.info.id, name: rt!.info.name, dir: rt!.info.dir });
    rt.setBudget("lead", 1.4); // $1.20 spent: under the cap, but another turn would cross it
    await expect(rt.sendMessage("one more", "lead")).rejects.toThrow(/spent \$1\.20 of its \$1\.40\/day budget, and a turn here usually costs ~\$0\.40/);
  });
});
