/**
 * Proof — is "done" true? (the "Proof Pack")
 *
 * Agents say "all tests pass" when three of fourteen ran, or when none did.
 * Proof reads what an agent *claimed* at the end of a turn, what it actually
 * *ran* during it (the shell tool calls and their exit codes, already in the
 * log), and — the part no vendor does for itself — what happens when Loom runs
 * the project's tests again in a clean checkout of the agent's changes. The
 * verdict is one of:
 *
 *   verified      the re-run passes, and nothing the agent claimed contradicts it
 *   contradicted  the re-run fails, or a claim doesn't match what happened
 *                 (it said 14 pass and 11 did; it said tests pass and never ran any)
 *   unverified    nothing to check against (no test command, no claims)
 *
 * This file is pure: claims, evidence, counts, the verdict. Running the tests
 * in a clean worktree is the daemon's (daemon/proof.ts).
 */

import fs from "node:fs";
import path from "node:path";
import type { LoomEvent } from "../types.js";

export type ClaimKind = "tests" | "build" | "lint" | "typecheck";

export interface Claim {
  kind: ClaimKind;
  /** The sentence it came from, trimmed. */
  text: string;
  /** "12 tests pass", "all 30 passed": how many it said passed (and of how many). */
  passed?: number;
  total?: number;
}

export interface Counts {
  passed: number;
  failed: number;
  skipped?: number;
  total?: number;
}

/** A command the agent ran during the turn. */
export interface Ran {
  command: string;
  kind: ClaimKind | "other";
  exitCode: number | null;
  ok: boolean;
  counts?: Counts;
  eventId: number;
}

export interface ClaimCheck extends Claim {
  status: "supported" | "contradicted" | "unchecked";
  why: string;
}

export interface Rerun {
  command: string;
  exitCode: number | null;
  ok: boolean;
  counts?: Counts;
  ms: number;
  /** The last lines of output. */
  tail: string;
  timedOut?: boolean;
  /** Run in a clean checkout of the changes (false: not a git checkout, so in place). */
  clean?: boolean;
}

export type Verdict = "verified" | "contradicted" | "unverified";

export interface ProofResult {
  verdict: Verdict;
  /** One sentence for a notification, a badge's title, a PR body. */
  headline: string;
  claims: ClaimCheck[];
  ran: Ran[];
  rerun: Rerun | null;
}

// ── claims ──

const NUM = String.raw`(\d{1,6})`;
const CLAIM_PATTERNS: Array<{ kind: ClaimKind; re: RegExp }> = [
  { kind: "tests", re: new RegExp(String.raw`\b(?:all\s+)?${NUM}?\s*(?:/\s*${NUM}\s*)?(?:unit\s+|e2e\s+|integration\s+)?(?:tests?|specs?|test cases?)\b[^.\n]{0,40}?\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok)\b`, "i") },
  { kind: "tests", re: /\b(?:all\s+)?(?:the\s+)?tests?\s+(?:are\s+|now\s+)*(?:pass(?:es|ed|ing)?|green)\b/i },
  { kind: "tests", re: new RegExp(String.raw`\b${NUM}\s+passed\b`, "i") },
  { kind: "build", re: /\b(?:the\s+)?build\s+(?:now\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|is\s+green|works|compiles)\b|\bbuilds?\s+(?:cleanly|successfully)\b/i },
  { kind: "typecheck", re: /\b(?:type[- ]?check(?:s|ing)?|tsc|types)\s+(?:(?:is|are)\s+)?(?:now\s+)?(?:pass(?:es|ed)?|clean|green|succeed(?:s|ed)?)\b|\bno\s+type\s+errors\b/i },
  { kind: "lint", re: /\b(?:lint(?:ing|er)?|eslint|ruff|clippy)\s+(?:(?:is|are)\s+)?(?:now\s+)?(?:pass(?:es|ed)?|clean|green)\b|\bno\s+lint\s+(?:errors|warnings)\b/i },
];

/**
 * Sentences that only *talk about* tests claim nothing: a hope or a condition
 * ("should pass once CI…", "if the tests pass"), a negation ("haven't run"),
 * an instruction ("Run the tests to check").
 */
const HEDGE = /\b(?:should|would|could|might|may|will|once|until|if|unless|hopefully|expect(?:ed|s)?|to make sure|to verify|to confirm|supposed to)\b/i;
const NEGATED = /\b(?:not|never|no longer|not yet|haven'?t|hasn'?t|didn'?t|don'?t|doesn'?t|couldn'?t|can'?t|cannot|won'?t|unable|without)\b/i;
const INSTRUCTION = /^(?:please\s+)?(?:run|try|make sure|check|verify|ensure)\b/i;

/** What a turn's final message says is true. One claim per kind (the strongest sentence). */
export function extractClaims(text: string): Claim[] {
  const out = new Map<ClaimKind, Claim>();
  const prose = text.replace(/```[\s\S]*?```/g, " "); // code blocks show commands and output, not claims
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(/^[\s>*\-•✅✓☑️]+/, "").trim();
    if (!sentence || sentence.length > 400) continue;
    for (const { kind, re } of CLAIM_PATTERNS) {
      const m = re.exec(sentence);
      if (!m) continue;
      if (HEDGE.test(sentence) || NEGATED.test(sentence) || INSTRUCTION.test(sentence)) continue;
      if (/\b(?:fail(?:s|ed|ing|ures?)?|broken|red)\b/i.test(sentence) && !/\b0\s+fail/i.test(sentence)) continue;
      const nums = m.slice(1).filter((x) => x !== undefined).map(Number);
      const claim: Claim = { kind, text: sentence.slice(0, 240) };
      if (kind === "tests" && nums.length) {
        claim.passed = nums[0];
        if (nums.length > 1) claim.total = nums[1];
      }
      const prev = out.get(kind);
      if (!prev || (claim.passed !== undefined && prev.passed === undefined)) out.set(kind, claim);
    }
  }
  return [...out.values()];
}

// ── what ran ──

const KIND_OF: Array<{ kind: ClaimKind; re: RegExp }> = [
  { kind: "typecheck", re: /\b(?:tsc\b(?!.*--build)|vue-tsc|mypy|pyright|typecheck|type-check|check-types)\b/i },
  { kind: "lint", re: /\b(?:eslint|lint|ruff\s+check|flake8|pylint|clippy|golangci-lint|biome\s+(?:check|lint))\b/i },
  { kind: "tests", re: /\b(?:test|tests|vitest|jest|mocha|ava|pytest|py\.test|unittest|rspec|phpunit|go\s+test|cargo\s+test|cargo\s+nextest|dotnet\s+test|mvn\s+test|gradle\w*\s+test|swift\s+test|bun\s+test|deno\s+test|node\s+--test|playwright\s+test|cypress\s+run)\b/i },
  { kind: "build", re: /\b(?:build|compile|cargo\s+build|go\s+build|tsc\s+--build|make\b|webpack|vite\s+build|next\s+build|gradle\w*\s+assemble)\b/i },
];

export function commandKind(command: string): ClaimKind | "other" {
  for (const { kind, re } of KIND_OF) if (re.test(command)) return kind;
  return "other";
}

/**
 * Pass/fail counts from a test runner's output: vitest, jest, mocha, node:test,
 * pytest, go test, cargo test, rspec, phpunit. Null when it can't tell.
 */
export function parseCounts(output: string): Counts | null {
  const o = output.replace(/\x1b\[[0-9;]*m/g, "");
  let m: RegExpExecArray | null;
  // vitest: "Tests  1 failed | 12 passed | 2 skipped (15)"
  if ((m = /Tests\s+((?:\d+\s+\w+\s*\|?\s*)+)\((\d+)\)/.exec(o))) {
    const part = (w: string) => Number(new RegExp(String.raw`(\d+)\s+${w}`).exec(m![1]!)?.[1] ?? 0);
    return { passed: part("passed"), failed: part("failed"), skipped: part("skipped"), total: Number(m[2]) };
  }
  // jest: "Tests:       1 failed, 12 passed, 13 total"
  if ((m = /Tests:\s+(.*?)(\d+)\s+total/.exec(o))) {
    const part = (w: string) => Number(new RegExp(String.raw`(\d+)\s+${w}`).exec(m![1]!)?.[1] ?? 0);
    return { passed: part("passed"), failed: part("failed"), skipped: part("skipped"), total: Number(m[2]) };
  }
  // node:test: "# pass 12" / "# fail 1"   (also "ℹ pass 12")
  if (/(?:#|ℹ)\s+pass\s+\d+/.test(o)) {
    const n = (w: string) => Number(new RegExp(String.raw`(?:#|ℹ)\s+${w}\s+(\d+)`).exec(o)?.[1] ?? 0);
    return { passed: n("pass"), failed: n("fail"), skipped: n("skipped"), total: n("tests") || undefined };
  }
  // pytest: "=== 3 passed, 1 failed, 2 skipped in 0.12s ==="
  if ((m = /=+\s*((?:\d+\s+\w+(?:,\s*)?)+)\s+in\s+[\d.]+s/.exec(o))) {
    const part = (w: string) => Number(new RegExp(String.raw`(\d+)\s+${w}`).exec(m![1]!)?.[1] ?? 0);
    return { passed: part("passed"), failed: part("failed") + part("error"), skipped: part("skipped") };
  }
  // cargo: "test result: ok. 5 passed; 0 failed; 1 ignored"
  if ((m = /test result: \w+\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?/.exec(o))) {
    return { passed: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3] ?? 0) };
  }
  // mocha: "12 passing" / "1 failing"
  if ((m = /(\d+)\s+passing\b/.exec(o))) {
    return { passed: Number(m[1]), failed: Number(/(\d+)\s+failing\b/.exec(o)?.[1] ?? 0), skipped: Number(/(\d+)\s+pending\b/.exec(o)?.[1] ?? 0) };
  }
  // rspec: "14 examples, 1 failure"
  if ((m = /(\d+)\s+examples?,\s+(\d+)\s+failures?/.exec(o))) return { passed: Number(m[1]) - Number(m[2]), failed: Number(m[2]), total: Number(m[1]) };
  // phpunit: "OK (12 tests, 30 assertions)" / "Tests: 12, Assertions: 30, Failures: 1."
  if ((m = /OK \((\d+) tests?/.exec(o))) return { passed: Number(m[1]), failed: 0, total: Number(m[1]) };
  if ((m = /Tests: (\d+), Assertions: \d+(?:, Errors: (\d+))?(?:, Failures: (\d+))?/.exec(o))) {
    const failed = Number(m[2] ?? 0) + Number(m[3] ?? 0);
    return { passed: Number(m[1]) - failed, failed, total: Number(m[1]) };
  }
  // go: count "--- PASS" / "--- FAIL" lines, else a bare ok/FAIL package summary
  const goPass = (o.match(/^\s*--- PASS:/gm) ?? []).length, goFail = (o.match(/^\s*--- FAIL:/gm) ?? []).length;
  if (goPass || goFail) return { passed: goPass, failed: goFail };
  return null;
}

/** The commands a turn ran, from its tool_call events. */
export function evidenceFrom(events: LoomEvent[]): Ran[] {
  const out: Ran[] = [];
  for (const e of events) {
    if (e.kind !== "tool_call") continue;
    const p = e.payload as Record<string, unknown>;
    const command = typeof p.command === "string" ? p.command
      : String(p.tool ?? "").toLowerCase() === "shell" || String(p.tool ?? "").toLowerCase() === "bash"
        ? String((p.input as Record<string, unknown> | undefined)?.command ?? p.summary ?? "").replace(/^shell:\s*/, "") : "";
    if (!command.trim()) continue;
    const exitCode = typeof p.exitCode === "number" ? p.exitCode : null;
    const output = [p.output, p.preview].filter((x): x is string => typeof x === "string").join("\n");
    const counts = output ? parseCounts(output) : null;
    const ok = exitCode !== null ? exitCode === 0 : p.ok !== false && !(counts && counts.failed > 0);
    out.push({ command: command.slice(0, 500), kind: commandKind(command), exitCode, ok, ...(counts ? { counts } : {}), eventId: e.id });
  }
  return out;
}

// ── the project's test command ──

/** The command that tests this project, from what it declares. Null when it declares nothing runnable. */
export function detectTestCommand(dir: string): string | null {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      if (test && !/no test specified/i.test(test)) {
        const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
        return runner === "npm" ? "npm test" : `${runner} test`;
      }
    } catch { /* a package.json we can't read declares nothing */ }
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pytest.ini") || has("conftest.py") || (has("pyproject.toml") && /\[tool\.pytest/.test(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8")))) return "python -m pytest -q";
  if (has("Makefile") && /^test:/m.test(fs.readFileSync(path.join(dir, "Makefile"), "utf8"))) return "make test";
  return null;
}

// ── the verdict ──

/** Weigh what was claimed against what ran and what the clean re-run showed. */
export function judge(claims: Claim[], ran: Ran[], rerun: Rerun | null): ProofResult {
  const checks: ClaimCheck[] = claims.map((c) => {
    const same = ran.filter((r) => r.kind === c.kind);
    const last = same.at(-1);
    if (c.kind === "tests" && rerun) {
      if (!rerun.ok) return { ...c, status: "contradicted", why: `the tests fail in a clean checkout${rerun.counts ? ` (${rerun.counts.failed} failed)` : ""}` };
      if (c.passed !== undefined && rerun.counts && rerun.counts.passed < c.passed)
        return { ...c, status: "contradicted", why: `said ${c.passed} pass; ${rerun.counts.passed} did` };
      return { ...c, status: "supported", why: rerun.counts ? `${rerun.counts.passed} passed in a clean checkout` : "the tests pass in a clean checkout" };
    }
    if (!last) return { ...c, status: "contradicted", why: `no ${c.kind === "tests" ? "test" : c.kind} command ran this turn` };
    if (!last.ok) return { ...c, status: "contradicted", why: `the last ${c.kind} command failed${last.exitCode !== null ? ` (exit ${last.exitCode})` : ""}: ${last.command.slice(0, 80)}` };
    if (c.kind === "tests" && c.passed !== undefined && last.counts && last.counts.passed < c.passed)
      return { ...c, status: "contradicted", why: `said ${c.passed} pass; the run showed ${last.counts.passed}` };
    return { ...c, status: "supported", why: `${last.command.slice(0, 80)} succeeded` };
  });

  const contradicted = checks.filter((c) => c.status === "contradicted");
  let verdict: Verdict;
  if (contradicted.length || (rerun && !rerun.ok)) verdict = "contradicted";
  else if (rerun?.ok) verdict = "verified";
  else if (checks.length && checks.every((c) => c.status === "supported")) verdict = "verified";
  else verdict = "unverified";

  const headline = verdict === "contradicted"
    ? contradicted[0] ? `Claimed “${contradicted[0].text.slice(0, 60)}” — ${contradicted[0].why}` : `The tests fail in a clean checkout${rerun?.counts ? `: ${rerun.counts.failed} failed` : ""}`
    : verdict === "verified"
      ? rerun?.ok ? `Verified: ${rerun.counts ? `${rerun.counts.passed} tests pass` : "the tests pass"} in a clean checkout` : "Verified against the commands it ran"
      : rerun === null && !claims.length ? "Nothing to verify: no claims and no test command" : "Unverified: no test command to check it against";
  return { verdict, headline, claims: checks, ran, rerun };
}
