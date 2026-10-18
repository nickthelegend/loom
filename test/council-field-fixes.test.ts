/**
 * The 1.2.0 field test's council run on a real project (#274–#280): what it
 * got wrong, pinned down.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compareWithDaemon, type Check } from "../src/cli/doctor.js";
import { fixPrompt, parseVerdicts, proofStage } from "../src/core/council.js";
import { coldResume, priceBookFrom } from "../src/core/prices.js";
import { couldNotRun, detectTestCommand, judge, parseCounts, ranTestCommand, type Ran } from "../src/core/proof.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { grokAuth } from "../src/core/setup.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

describe("#275 a planner's verdict keeps its words", () => {
  it("underscores, backticks and paths in the note survive; Markdown round the verdict doesn't matter", () => {
    const v = parseVerdicts([
      "ACCEPT r1.1 — add tests/test_reach.py for where_is, reading REACH_BEDROCK_MODEL",
      "- **REJECT** `r1.2` — runner.start_fetch already retries",
      "__FIXED__ r1.3: wrapped `_ask_bedrock` in a timeout",
    ].join("\n"), ["r1.1", "r1.2", "r1.3"]);
    expect(v.get("r1.1")).toEqual({ decision: "accepted", note: "add tests/test_reach.py for where_is, reading REACH_BEDROCK_MODEL" });
    expect(v.get("r1.2")).toEqual({ decision: "rejected", note: "runner.start_fetch already retries" });
    expect(v.get("r1.3")).toEqual({ decision: "accepted", note: "wrapped `_ask_bedrock` in a timeout" });
  });
});

describe("#277 the fix round gets every finding", () => {
  it("low ones included, and the planner is told why", () => {
    const text = fixPrompt([{ id: "r2.1", agent: "codex", severity: "medium", text: "a" }, { id: "r2.2", agent: "codex", severity: "low", text: "the end-to-end test you accepted is missing" }]);
    expect(text).toContain("r2.2 [low]");
    expect(text).toMatch(/low ones included/);
  });
});

describe("#276 Proof runs the tests that work here, and can tell 'couldn't run' from 'failed'", () => {
  const ran = (command: string, ok = true, kind: Ran["kind"] = "tests"): Ran => ({ command, kind, exitCode: ok ? 0 : 1, ok, eventId: 1 });
  const project = "/Volumes/Extreme SSD/Projects/wave1/reach-amazon";

  it("uses the test command the turn ran and passed, without its cd into the project", () => {
    expect(ranTestCommand([ran(`cd "${project}" && .venv/bin/python -m pytest -q`)], project)).toBe(".venv/bin/python -m pytest -q");
    expect(ranTestCommand([ran("npm test"), ran("npm run lint", true, "lint")], project)).toBe("npm test");
    expect(ranTestCommand([ran("npm test", false)], project)).toBeNull();
    expect(ranTestCommand([ran("cd /elsewhere && npm test")], project)).toBeNull();
    // only the test segment: a pipe into tail would pass whatever the tests did; other steps and redirections go too
    expect(ranTestCommand([ran(`cd "${project}" && git status --short && .venv/bin/python -m pytest -q 2>&1 | tail -3`)], project)).toBe(".venv/bin/python -m pytest -q");
    expect(ranTestCommand([ran("CI=1 npx vitest run > out.txt; echo done")], project)).toBe("CI=1 npx vitest run");
    expect(ranTestCommand([ran("npm run build && npm test")], project)).toBe("npm test");
  });

  it("a guessed Python command uses the project's venv, else python3", () => {
    const dir = tmpDir("proof-py");
    fs.writeFileSync(path.join(dir, "pytest.ini"), "[pytest]\n");
    expect(detectTestCommand(dir)).toBe(process.platform === "win32" ? "python -m pytest -q" : "python3 -m pytest -q");
    fs.mkdirSync(path.join(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), "");
    expect(detectTestCommand(dir)).toBe(path.join(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python") + " -m pytest -q");
  });

  it("reads pytest -q's bare summary line", () => {
    expect(parseCounts("....\n52 passed in 24.43s\n")).toEqual({ passed: 52, failed: 0, skipped: 0 });
    expect(parseCounts("FF.\n2 failed, 1 passed, 3 warnings in 0.50s\n")).toEqual({ passed: 1, failed: 2, skipped: 0 });
  });

  it("command not found is unverified, never 'the tests fail'", () => {
    const missing = { command: "python -m pytest -q", exitCode: 127, ok: false, ms: 10, tail: "/bin/sh: python: command not found\n" };
    expect(couldNotRun(missing)).toBe(true);
    expect(couldNotRun({ ...missing, exitCode: 1, tail: "2 failed, 50 passed" })).toBe(false);
    // the turn ran its tests and they passed: the claim stands on that, and the headline says the re-run couldn't start
    const r = judge([{ kind: "tests", text: "52 tests pass", passed: 52 }], [{ ...ran(".venv/bin/python -m pytest -q"), counts: { passed: 52, failed: 0 } }], missing);
    expect(r.verdict).toBe("verified");
    expect(r.headline).toMatch(/couldn't run `python -m pytest -q` in a clean checkout \(\/bin\/sh: python: command not found\) — set proof.testCommand/);
    const alone = judge([], [], missing);
    expect(alone.verdict).toBe("unverified");
  });

  it("the council's Prove stage is a tick only when verified", () => {
    expect([proofStage("verified"), proofStage("contradicted"), proofStage("unverified")]).toEqual(["done", "failed", "unverified"]);
  });
});

describe("#274 Grok's sign-in", () => {
  const now = Date.parse("2026-10-17T16:00:00Z");
  it("a session expired weeks ago and never renewed is signed out, refresh token or not", () => {
    expect(grokAuth({ a: { refresh_token: "x", key: "k", expires_at: "2026-09-21T14:35:33Z" } }, now)).toEqual({ authed: false, detail: "grok's session expired 2026-09-21 and hasn't renewed" });
    expect(grokAuth({ a: { refresh_token: "x", expires_at: "2026-10-17T10:00:00Z" } }, now)).toEqual({ authed: true });
    expect(grokAuth({ a: { key: "k" } }, now)).toEqual({ authed: true }); // an API key doesn't expire
    expect(grokAuth({}, now)).toMatchObject({ authed: false });
  });

  it("doctor says so when a turn failed signed out though the file looks fine", () => {
    const c = (name: string, status: Check["status"], detail: string): Check => ({ name, status, detail });
    const facts = { node: "26", path: ["/x"], keys: [] };
    const out = compareWithDaemon({ checks: [c("grok-code", "ok", "Grok Code · signed in")], facts },
      { checks: [c("grok-code", "fail", "a turn by grok-code failed: “Not signed in.” — grok login")], facts });
    expect(out[0]).toEqual(c("daemon:grok-code", "fail", "looks signed in, but a turn by grok-code failed: “Not signed in.” — grok login"));
  });
});

describe("#280 a short question shouldn't re-read a cold session unannounced", () => {
  it("cold after the cache's life, priced when Loom knows the model", () => {
    const book = priceBookFrom([{ id: "anthropic/claude-opus-5.5", pricing: { prompt: "0.000015", completion: "0.000075" } }]);
    expect(coldResume({ tokens: 170_068, ageMs: 3 * 3_600_000, model: "claude-opus-5-5" }, book)).toEqual({ cold: true, estUsd: 170_068 * 0.000015 });
    expect(coldResume({ tokens: 170_068, ageMs: 60_000, model: "claude-opus-5-5" }, book)).toEqual({ cold: false });
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-council-fixes");
  process.env.LOOM_NO_NOTIFY = "1";
});

async function project(git = false) {
  const dir = tmpDir("council-fixes");
  if (git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: dir });
  }
  writeProjectConfig(dir, { name: "fixes", agents: [{ id: "lead", kind: "echo" }, { id: "codex", kind: "echo" }, { id: "grok", kind: "echo" }], defaultAgent: "lead", brain: { extractor: "off" } });
  const info = { id: `fixes-${path.basename(dir)}`, name: "fixes", dir };
  rt = await ProjectRuntime.open(info);
  return info;
}

describe("in a project", () => {
  it("#278 a reviewer that answers with nothing didn't review", async () => {
    await project();
    const r = await rt!.reviews.start({ agents: ["codex"], target: { kind: "text", text: "x" } });
    // swallow codex's reply as if it had said nothing: its message events are dropped before they land
    const done = () => rt!.log.list({ kinds: ["review"] }).find((e) => e.payload.phase === "done");
    await waitUntil(() => Boolean(done()), { timeoutMs: 20_000 });
    expect((done()!.payload.results as Array<{ status: string }>)[0]!.status).toBe("done"); // echo said something
    // the same review state, read with the reply blanked, is a failure
    const { ReviewRunner } = await import("../src/daemon/review.js");
    const host = { hasAgent: () => true, canReview: () => true, holder: () => undefined, createChat: () => ({ id: "c" }), maxReviewers: 4, decide: () => {},
      spawn: async (_p: string, o: { onSettled: (x: { ok: boolean }) => void }) => { setTimeout(() => o.onSettled({ ok: true }), 5); },
      list: () => [] as never[], append: (e: never) => { appended.push(e); return e; } };
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    await new ReviewRunner(host as never).start({ agents: ["openrouter"], target: { kind: "text", text: "x" } });
    await waitUntil(() => appended.some((e) => e.payload.phase === "done"));
    const res = appended.find((e) => e.payload.phase === "done")!.payload;
    expect(res.results).toEqual([{ agent: "openrouter", status: "failed", error: "it finished without a reply", reply: "" }]);
    expect(res.summary).toBe("1 reviewer (1 failed) · no findings");
    void r;
  }, 30_000);

  it("a reviewer that takes too long is stopped and left out; the others' findings still land", async () => {
    const { ReviewRunner } = await import("../src/daemon/review.js");
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    const stopped: string[] = [];
    const host = { hasAgent: () => true, canReview: () => true, holder: () => undefined, createChat: () => ({ id: "c" }), maxReviewers: 4, decide: () => {},
      reviewerTimeoutMs: () => 80, stopReviewer: async (a: string) => { stopped.push(a); },
      // codex answers at once; openrouter never does (and answers late, after it was left out)
      spawn: async (_p: string, o: { agentId: string; onSettled: (x: { ok: boolean }) => void }) => {
        setTimeout(() => o.onSettled({ ok: true }), o.agentId === "codex" ? 5 : 400);
      },
      list: (opts: { agentId?: string }) => (opts.agentId === "codex" ? [{ id: 1, ts: Date.now(), kind: "message", agentId: "codex", payload: { text: "- [high] a.ts:1 — bug" } }] : []) as never[],
      append: (e: never) => { appended.push(e); return e; } };
    await new ReviewRunner(host as never).start({ agents: ["codex", "openrouter"], target: { kind: "text", text: "x" } });
    await waitUntil(() => appended.some((e) => e.payload.phase === "done"));
    const res = appended.find((e) => e.payload.phase === "done")!.payload as { results: Array<{ agent: string; status: string; error?: string }>; findings: unknown[] };
    expect(res.results.map((r) => [r.agent, r.status])).toEqual([["codex", "done"], ["openrouter", "failed"]]);
    expect(res.results[1]!.error).toMatch(/took longer than 0s — left out/);
    expect(res.findings).toHaveLength(1);
    expect(stopped).toEqual(["openrouter"]);
    await new Promise((r) => setTimeout(r, 450)); // its late answer changes nothing
    expect(appended.filter((e) => e.payload.phase === "done")).toHaveLength(1);
  });

  it("#274 a sign-in failure is remembered across a restart, until a turn succeeds", async () => {
    const info = await project();
    rt!.log.append({ kind: "error", agentId: "grok", payload: { message: "Not signed in. To authenticate without a browser, run: grok login --device-code" } });
    await rt!.close();
    rt = await ProjectRuntime.open(info);
    expect(rt.learnedSignOuts()).toEqual([{ agentId: "grok", kind: "echo", message: "Not signed in. To authenticate without a browser, run: grok login --device-code" }]);
    rt.log.append({ kind: "run_complete", agentId: "grok", payload: {} });
    await rt.close();
    rt = await ProjectRuntime.open(info);
    expect(rt.learnedSignOuts()).toEqual([]);
  });

  it("#280 how heavy and how cold an agent's session is", async () => {
    await project();
    expect(rt!.sessionWeight("lead")).toBeNull();
    rt!.log.append({ kind: "run_complete", agentId: "lead", payload: { model: "claude-opus-5-5", inputTokens: 170_068 } });
    expect(rt!.sessionWeight("lead")).toMatchObject({ tokens: 170_068, model: "claude-opus-5-5", cold: false });
  });
});
