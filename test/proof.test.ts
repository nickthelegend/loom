/**
 * Proof: is "done" true? Claims, evidence, runner counts and verdicts (pure),
 * then the clean re-run against a real git checkout — an agent's uncommitted
 * change that breaks the tests is caught even though the agent said they pass.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commandKind, detectTestCommand, evidenceFrom, extractClaims, isPlanRequest, judge, parseCounts } from "../src/core/proof.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { pushCategory, pushContent } from "../src/daemon/push.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-proof");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("claims", () => {
  it("reads what a reply says is true, and not what it only talks about", () => {
    expect(extractClaims("Fixed the parser. All 14 tests pass.")).toEqual([{ kind: "tests", text: "All 14 tests pass.", passed: 14 }]);
    expect(extractClaims("✅ tests are passing\n- the build succeeds")).toEqual([
      { kind: "tests", text: "tests are passing" },
      { kind: "build", text: "the build succeeds" },
    ]);
    expect(extractClaims("Typecheck passes and lint is clean.").map((c) => c.kind).sort()).toEqual(["lint", "typecheck"]);
    expect(extractClaims("12/14 tests pass now")).toEqual([{ kind: "tests", text: "12/14 tests pass now", passed: 12, total: 14 }]);
    // hedged, pending, or failing: no claim
    expect(extractClaims("Run the tests to make sure they pass.")).toEqual([]);
    expect(extractClaims("The tests should pass once CI picks it up.")).toEqual([]);
    expect(extractClaims("2 tests fail on main; I didn't touch them.")).toEqual([]);
    // a fenced block is output, not a claim
    expect(extractClaims("```\nTests  14 passed (14)\n```\nDone.")).toEqual([]);
  });
});

describe("runner counts", () => {
  it("parses the common runners' summaries", () => {
    expect(parseCounts(" Test Files  2 passed (2)\n      Tests  1 failed | 12 passed | 2 skipped (15)")).toEqual({ passed: 12, failed: 1, skipped: 2, total: 15 });
    expect(parseCounts("Tests:       1 failed, 12 passed, 13 total")).toEqual({ passed: 12, failed: 1, skipped: 0, total: 13 });
    expect(parseCounts("ℹ tests 3\nℹ pass 2\nℹ fail 1")).toEqual({ passed: 2, failed: 1, skipped: 0, total: 3 });
    expect(parseCounts("===== 3 passed, 1 failed, 2 skipped in 0.12s =====")).toEqual({ passed: 3, failed: 1, skipped: 2 });
    expect(parseCounts("test result: ok. 5 passed; 0 failed; 1 ignored")).toEqual({ passed: 5, failed: 0, skipped: 1 });
    expect(parseCounts("  12 passing (40ms)\n  1 failing")).toEqual({ passed: 12, failed: 1, skipped: 0 });
    expect(parseCounts("14 examples, 2 failures")).toEqual({ passed: 12, failed: 2, total: 14 });
    expect(parseCounts("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- PASS: TestC")).toEqual({ passed: 2, failed: 1 });
    expect(parseCounts("\x1b[32m Tests  3 passed (3)\x1b[0m")).toMatchObject({ passed: 3, failed: 0 });
    expect(parseCounts("compiled successfully")).toBeNull();
  });

  it("knows a test command from a build or a lint", () => {
    expect(commandKind("npm test")).toBe("tests");
    expect(commandKind("npx vitest run src")).toBe("tests");
    expect(commandKind("cargo test --workspace")).toBe("tests");
    expect(commandKind("npx tsc --noEmit")).toBe("typecheck");
    expect(commandKind("npm run lint")).toBe("lint");
    expect(commandKind("npm run build")).toBe("build");
    expect(commandKind("ls -la")).toBe("other");
  });
});

describe("what isn't evidence (#245)", () => {
  it("a command is classified by the program it runs, not by words in its paths", () => {
    expect(commandKind(`cd "/Volumes/Extreme SSD/x" && git ls-files | head -80 && wc -l reach/*.py tests/*.py`)).toBe("other");
    expect(commandKind("find tests -name '*.py'")).toBe("other");
    expect(commandKind("ls tests/ && cat test_plan.md")).toBe("other");
    expect(commandKind(".venv/bin/python -m pytest -q")).toBe("tests");
    expect(commandKind("./.venv/bin/pytest -q tests/test_tts.py")).toBe("tests");
    expect(commandKind("cd web && npm run test:unit")).toBe("tests");
    expect(commandKind("CI=1 npx vitest run")).toBe("tests");
    expect(commandKind("npm run build && npm test")).toBe("tests");
    expect(commandKind("uv run mypy src")).toBe("typecheck");
  });

  it("a refused command (no exit code, no output) is not a run at all", () => {
    const ev = (id: number, payload: Record<string, unknown>) => ({ id, ts: 0, kind: "tool_call", agentId: "a", payload }) as LoomEvent;
    expect(evidenceFrom([ev(1, { tool: "shell", command: ".venv/bin/pytest -q", exitCode: null, ok: false })])).toEqual([]);
    expect(evidenceFrom([ev(2, { tool: "shell", command: ".venv/bin/pytest -q", exitCode: 1, ok: false, preview: "1 failed" })])).toHaveLength(1);
  });

  it("a plan's sentence isn't a claim, and a plan request is recognised", () => {
    expect(extractClaims("A constructor argument `transport: httpx.AsyncBaseTransport | None = None`, so tests can pass `httpx.MockTransport`.")).toEqual([]);
    expect(isPlanRequest("PLAN ONLY, do not edit any files. Write the integration plan.")).toBe(true);
    expect(isPlanRequest("Review only: read the diff and list problems")).toBe(true);
    expect(isPlanRequest("Plan: add retries to the client")).toBe(true);
    expect(isPlanRequest("Implement the plan we agreed and run the tests")).toBe(false);
  });
});

describe("verdicts", () => {
  const ev = (id: number, payload: Record<string, unknown>): LoomEvent => ({ id, ts: 0, kind: "tool_call", agentId: "a", payload });

  it("a claim with no command behind it, or a failed one, doesn't hold", () => {
    const claims = extractClaims("All tests pass.");
    expect(judge(claims, [], null)).toMatchObject({ verdict: "contradicted", claims: [{ status: "contradicted", why: "no test command ran this turn" }] });
    const ranFail = evidenceFrom([ev(1, { tool: "shell", command: "npm test", exitCode: 1 })]);
    expect(judge(claims, ranFail, null).claims[0]).toMatchObject({ status: "contradicted", why: expect.stringMatching(/exit 1/) });
    const ranOk = evidenceFrom([ev(2, { tool: "shell", command: "npm test", exitCode: 0, preview: "Tests  3 passed (3)" })]);
    expect(judge(claims, ranOk, null)).toMatchObject({ verdict: "verified" });
    expect(judge(extractClaims("All 5 tests pass."), ranOk, null).claims[0]).toMatchObject({ status: "contradicted", why: "said 5 pass; the run showed 3" });
  });

  it("the clean re-run decides the tests", () => {
    const claims = extractClaims("All tests pass.");
    const green = { command: "npm test", exitCode: 0, ok: true, ms: 10, tail: "", counts: { passed: 4, failed: 0 } };
    const red = { ...green, exitCode: 1, ok: false, counts: { passed: 3, failed: 1 } };
    expect(judge(claims, [], green)).toMatchObject({ verdict: "verified", headline: "Verified: 4 tests pass in a clean checkout" });
    expect(judge(claims, [], red)).toMatchObject({ verdict: "contradicted", claims: [{ why: "the tests fail in a clean checkout (1 failed)" }] });
    expect(judge([], [], red)).toMatchObject({ verdict: "contradicted" });
    expect(judge([], [], null)).toMatchObject({ verdict: "unverified" });
  });
});

describe("the project's test command", () => {
  it("comes from what the project declares", () => {
    const d = tmpDir("proof-detect");
    expect(detectTestCommand(d)).toBeNull();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectTestCommand(d)).toBeNull();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(detectTestCommand(d)).toBe("npm test");
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "");
    expect(detectTestCommand(d)).toBe("pnpm test");
    const r = tmpDir("proof-rust");
    fs.writeFileSync(path.join(r, "Cargo.toml"), "[package]\n");
    expect(detectTestCommand(r)).toBe("cargo test");
  });
});

/** A git project whose tests are node:test files, with an echo agent. */
function project(testBody = "test('adds', () => { if (add(1, 2) !== 3) throw new Error('bad'); });") {
  const dir = tmpDir("proof-proj");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", private: true, scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "add.js"), "module.exports = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, "add.test.js"), `const test = require('node:test');\nconst add = require('./add.js');\n${testBody}\n`);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  writeProjectConfig(dir, { name: "proof", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } });
  return dir;
}

describe("proof against a real checkout", () => {
  it("an uncommitted change that breaks the tests is caught, though the agent said they pass", async () => {
    const dir = project();
    rt = await ProjectRuntime.open({ id: `proof-${path.basename(dir)}`, name: "proof", dir });
    // the agent's work, uncommitted: a broken add() and a new test file
    fs.writeFileSync(path.join(dir, "add.js"), "module.exports = (a, b) => a - b;\n");
    fs.writeFileSync(path.join(dir, "more.test.js"), "require('node:test')('more', () => {});\n");
    await rt.sendMessage("Done: All tests pass.");
    await waitUntil(() => rt!.log.list({ kinds: ["proof"] }).length === 1, { timeoutMs: 30_000 });
    const proof = rt.log.list({ kinds: ["proof"] })[0]!.payload as Record<string, any>;
    expect(proof).toMatchObject({ verdict: "contradicted", about: "echo", auto: true });
    expect(proof.rerun).toMatchObject({ command: "npm test", ok: false, clean: true, counts: { passed: 1, failed: 1 } });
    expect(proof.claims[0]).toMatchObject({ kind: "tests", status: "contradicted" });
    expect(proof.headline).toMatch(/clean checkout/);
    // the clean checkout was the agent's code: the real working tree is untouched, and the worktree is gone
    expect(fs.readFileSync(path.join(dir, "add.js"), "utf8")).toContain("a - b");
    expect(git(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
    // and the phone hears about it
    const e = rt.log.list({ kinds: ["proof"] })[0]!;
    expect(pushCategory(e)).toBe("done");
    expect(pushContent("proof", e).title).toMatch(/echo's “done” didn't hold/);
  });

  it("a claim that holds is verified with the real count; Check it works on demand", async () => {
    const dir = project("test('a', () => {}); test('b', () => {});");
    rt = await ProjectRuntime.open({ id: `proof-${path.basename(dir)}`, name: "proof", dir });
    await rt.sendMessage("All 2 tests pass.");
    await waitUntil(() => rt!.log.list({ kinds: ["proof"] }).length === 1, { timeoutMs: 30_000 });
    const auto = rt.log.list({ kinds: ["proof"] })[0]!.payload as Record<string, any>;
    expect(auto).toMatchObject({ verdict: "verified", rerun: { counts: { passed: 2, failed: 0 } } });
    expect(pushCategory(rt.log.list({ kinds: ["proof"] })[0]!)).toBeNull();
    // a reply that claims nothing isn't checked automatically, but can be checked when asked
    await rt.sendMessage("Looked around the code.");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(rt.log.list({ kinds: ["proof"] })).toHaveLength(1);
    const asked = await rt.proofs.prove();
    expect(asked).toMatchObject({ verdict: "verified", headline: "Verified: 2 tests pass in a clean checkout" });
    expect(rt.log.list({ kinds: ["proof"] })).toHaveLength(2);
  });

  it("a plan-only turn isn't checked automatically, and on demand it says it's a plan (#245)", async () => {
    const dir = project();
    rt = await ProjectRuntime.open({ id: `proof-${path.basename(dir)}`, name: "proof", dir });
    await rt.sendMessage("PLAN ONLY, do not edit any files. All tests pass once we add retries.");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(rt.log.list({ kinds: ["proof"] })).toHaveLength(0);
    const asked = await rt.proofs.prove();
    expect(asked).toMatchObject({ verdict: "unverified", headline: "A plan, not a change — nothing to check until it's built", rerun: null });
  });

  it("is off when the project says so, and uses the project's own test command", async () => {
    const dir = project();
    writeProjectConfig(dir, { name: "proof", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" }, proof: { auto: "off", testCommand: "node -e \"process.exit(3)\"" } });
    rt = await ProjectRuntime.open({ id: `proof-${path.basename(dir)}`, name: "proof", dir });
    await rt.sendMessage("All tests pass.");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(rt.log.list({ kinds: ["proof"] })).toHaveLength(0);
    const asked = await rt.proofs.prove();
    expect(asked?.rerun).toMatchObject({ command: 'node -e "process.exit(3)"', exitCode: 3, ok: false });
  });
});
