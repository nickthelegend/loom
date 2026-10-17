/**
 * loom review (#253): several agents read the same change at once —
 * read-only, nobody takes the baton — and their findings land on one card to
 * accept (a project decision) or reject.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { collectFindings, decisionText, parseFindings, READ_ONLY_RULE, reviewPrompt, reviewSummary } from "../src/core/review.js";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { pushCategory, pushContent } from "../src/daemon/push.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir, waitUntil } from "./helpers.js";

describe("reading a reviewer's reply", () => {
  it("takes a finding however it's written, and skips what isn't one", () => {
    const reply = [
      "Looks mostly fine. Findings:",
      "- [high] src/auth.ts:42 — the token is compared with ==, use a constant-time compare",
      "2. **Medium** — `lib/cache.js:7-9`: never evicts",
      "* nit: rename `x` in utils/format.py",
      "- [low] README.md — typo in the install line",
      "- Summary: good work overall",
      "- the tests could be faster",
    ].join("\n");
    expect(parseFindings(reply, "codex")).toEqual([
      { id: "1", agent: "codex", severity: "high", file: "src/auth.ts", line: 42, text: "the token is compared with ==, use a constant-time compare" },
      { id: "2", agent: "codex", severity: "medium", file: "lib/cache.js", line: 7, text: "never evicts" },
      { id: "3", agent: "codex", severity: "low", file: "utils/format.py", text: "rename `x` in utils/format.py" },
      { id: "4", agent: "codex", severity: "low", file: "README.md", text: "typo in the install line" },
    ]);
  });

  it("two reviewers on the same line are one finding they agree on, at the worse severity", () => {
    const all = collectFindings("r2", [
      { agent: "codex", reply: "- [medium] src/a.ts:10 — races on reload\n- [low] src/b.ts:3 — naming" },
      { agent: "grok", reply: "- [high] src/a.ts:10 — two writers, no lock" },
    ]);
    expect(all[0]).toMatchObject({ id: "r2.1", agent: "grok", severity: "high", text: "two writers, no lock", agreed: [{ agent: "codex", text: "races on reload" }] });
    expect(all).toHaveLength(2);
    expect(decisionText(all[0]!)).toBe("Review finding accepted (grok + codex, high): src/a.ts:10 — two writers, no lock");
  });

  it("puts every reviewer's findings in one list, worst first, ids unique to the review", () => {
    const all = collectFindings("r1", [
      { agent: "a", reply: "- [low] a.ts:1 — nit\n- [high] b.ts:2 — bug" },
      { agent: "b", reply: "- [medium] c.ts:3 — meh" },
    ]);
    expect(all.map((f) => [f.id, f.agent, f.severity])).toEqual([["r1.1", "a", "high"], ["r1.2", "b", "medium"], ["r1.3", "a", "low"]]);
    expect(reviewSummary([{ status: "done" }, { status: "failed" }], all)).toBe("2 reviewers (1 failed) · 3 findings (1 high)");
    expect(reviewSummary([{ status: "done" }], [])).toBe("1 reviewer · no findings");
    expect(decisionText(all[0]!, "fix before release")).toBe("Review finding accepted (a, high): b.ts:2 — bug — fix before release");
  });

  it("the brief carries the diff when it fits, says read-only, and asks for one finding a line", () => {
    const small = reviewPrompt({ kind: "diff", diff: "diff --git a/x b/x\n+1", untracked: ["new.ts"] }, "error handling");
    expect(small).toContain("```diff\ndiff --git a/x b/x\n+1\n```");
    expect(small).toContain("New files, not yet in git: new.ts");
    expect(small).toContain("Focus on: error handling");
    expect(small).toContain(READ_ONLY_RULE);
    const big = reviewPrompt({ kind: "diff", diff: "+".repeat(20_000) });
    expect(big).toMatch(/run `git diff HEAD` to read them \(20k characters/);
    expect(big.length).toBeLessThan(10_000); // a subtask brief's limit
    expect(reviewPrompt({ kind: "file", file: "src/a.ts" })).toMatch(/^Review the file `src\/a.ts`/);
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-review");
  process.env.LOOM_NO_NOTIFY = "1";
});

async function project(opts: { git?: boolean } = {}) {
  const dir = tmpDir("review");
  if (opts.git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
    fs.writeFileSync(path.join(dir, "add.js"), "export const add = (a, b) => a + b;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: dir });
  }
  writeProjectConfig(dir, { name: "review", agents: [{ id: "lead", kind: "echo" }, { id: "codex", kind: "echo" }, { id: "grok", kind: "echo" }], defaultAgent: "lead", brain: { extractor: "off" } });
  rt = await ProjectRuntime.open({ id: `review-${path.basename(dir)}`, name: "review", dir });
  return dir;
}
const reviewEvents = (phase: string) => rt!.log.list({ kinds: ["review"] }).filter((e) => e.payload.phase === phase);

describe("a review in a project", () => {
  it("fans out read-only, keeps the baton where it was, and collects the findings on one card", async () => {
    await project();
    await rt!.sendMessage("hello");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    const holder = rt!.baton.holder();
    const handoffs = rt!.log.list({ kinds: ["handoff"] }).length;
    const r = await rt!.startReview({ agents: ["codex", "grok"], text: "the adder\n- [medium] src/add.js:1 — doesn't coerce strings" });
    expect(r).toMatchObject({ status: "running", agents: ["codex", "grok"] });
    await waitUntil(() => reviewEvents("done").length === 1, { timeoutMs: 20_000 });
    const done = reviewEvents("done")[0]!;
    expect(done.chat).toBe(r.chat); // in the review's own chat
    expect(rt!.baton.holder()).toBe(holder); // nobody took the baton
    expect(rt!.log.list({ kinds: ["handoff"] })).toHaveLength(handoffs);
    // each reviewer answered in the review's chat, told it's read-only
    const replies = rt!.log.list({ kinds: ["message"], chat: r.chat }).filter((m) => m.agentId);
    expect(replies.map((m) => m.agentId).sort()).toEqual(["codex", "grok"]);
    expect(replies.every((m) => String(m.payload.text).includes("READ-ONLY review"))).toBe(true);
    const findings = done.payload.findings as Array<{ id: string; agent: string; severity: string; file: string }>;
    // echo repeats its brief: the format line ([high]) and the seeded finding ([medium]) — both reviewers flag both, so each is one finding they agree on
    expect(findings.map((f) => [f.severity, f.file])).toEqual([["high", "path/to/file.ts"], ["medium", "src/add.js"]]);
    expect(findings.every((f) => (f as { agreed?: unknown[] }).agreed?.length === 1)).toBe(true);
    expect(done.payload.summary).toBe("2 reviewers · 2 findings (1 high) · 2 flagged by more than one");
    expect(pushCategory(done)).toBe("goals");
    expect(pushContent("review", done).title).toBe("🔍 Review done · review");

    // accept one: it's a decision, and a memory every briefing can carry; reject another
    const seeded = findings.find((f) => f.file === "src/add.js")!;
    rt!.reviews.decide(seeded.id, "accepted", "before release");
    rt!.reviews.decide(findings[0]!.id, "rejected");
    rt!.reviews.decide(seeded.id, "accepted"); // twice is still one decision
    const decisions = rt!.log.list({ kinds: ["decision"] });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload.text).toMatch(/^Review finding accepted \((codex \+ grok|grok \+ codex), medium\): src\/add\.js:1 — doesn't coerce strings — before release$/);
    expect(rt!.brain.list().some((m) => m.kind === "decision" && /doesn't coerce strings/.test(m.text))).toBe(true);
    const state = rt!.reviews.status(r.reviewId)!;
    expect(state.findings!.find((f) => f.id === seeded.id)).toMatchObject({ decision: "accepted" });
    expect(state.findings!.find((f) => f.id === findings[0]!.id)).toMatchObject({ decision: "rejected" });
    expect(() => rt!.reviews.decide("nope.1", "accepted")).toThrow(/no review finding/);
  }, 40_000);

  it("reviews the uncommitted changes by default, with the diff in the brief", async () => {
    const dir = await project({ git: true });
    fs.writeFileSync(path.join(dir, "add.js"), "export const add = (a, b) => a - b;\n");
    fs.writeFileSync(path.join(dir, "new.js"), "x\n");
    const r = await rt!.startReview({ agents: ["codex"] });
    expect(r.target).toEqual({ kind: "diff" });
    const task = String(rt!.log.list({ kinds: ["subtask_started"] })[0]!.payload.task);
    expect(task).toContain("-export const add = (a, b) => a + b;");
    expect(task).toContain("New files, not yet in git: new.js");
    await waitUntil(() => reviewEvents("done").length === 1, { timeoutMs: 20_000 });
  }, 30_000);

  it("refuses what it can't review", async () => {
    const dir = await project({ git: true });
    await expect(rt!.startReview({ agents: [] })).rejects.toThrow(/at least one agent/);
    await expect(rt!.startReview({ agents: ["ghost"], file: "add.js" })).rejects.toThrow(/no agent "ghost"/);
    await expect(rt!.startReview({ agents: ["codex"], file: "../etc/passwd" })).rejects.toThrow(/outside the project/);
    await expect(rt!.startReview({ agents: ["codex"], file: "missing.js" })).rejects.toThrow(/no file missing\.js/);
    await expect(rt!.startReview({ agents: ["codex"] })).rejects.toThrow(/no uncommitted changes/);
    await expect(rt!.startReview({ agents: ["a", "b", "c", "d", "e"], file: "add.js" })).rejects.toThrow(/4 at a time/);
    void dir;
  });

  it("a review the daemon restarted under is closed, saying so", async () => {
    const dir = await project();
    const info = { id: `review-${path.basename(dir)}`, name: "review", dir };
    rt!.log.append({ kind: "review", chat: "main", payload: { phase: "started", reviewId: "abc123", chat: "main", target: { kind: "text" }, agents: ["codex"] } });
    await rt!.close();
    rt = await ProjectRuntime.open(info);
    const done = reviewEvents("done")[0]!;
    expect(done.payload).toMatchObject({ reviewId: "abc123", summary: "1 reviewer (1 failed) · no findings", results: [{ agent: "codex", status: "failed", error: "Loom restarted before it answered" }] });
  });
});

describe("loom review, from the CLI", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let daemon: LoomDaemon;
  let dir: string;
  beforeAll(async () => {
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    dir = tmpDir("review-cli");
    writeProjectConfig(dir, { name: "rcli", agents: [{ id: "lead", kind: "echo" }, { id: "codex", kind: "echo" }], brain: { extractor: "off" } });
    await new DaemonClient(readDaemonConfig()!).addProject(dir);
  });
  afterAll(async () => { await daemon.close(); });
  const cli = (args: string[]) => new Promise<{ out: string; code: number }>((resolve) => {
    execFile(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "cli", "index.ts"), ...args],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ out: stdout + stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  });

  it("waits for the findings, prints them, and accepts one", async () => {
    const r = await cli(["review", "codex", "--text", "the adder\n- [medium] add.js:1 — subtracts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("codex reviewing “the adder” · read-only, nobody takes the baton");
    expect(r.out).toMatch(/1 reviewer · 2 findings \(1 high\)/);
    const id = r.out.match(/medium (\w+\.\d+)/)![1]!;
    const ok = await cli(["review:accept", id, "--note", "real bug"]);
    expect(ok.out).toContain(`✓ accepted ${id}`);
    expect((await cli(["reviews", id.split(".")[0]!])).out).toMatch(/add\.js:1 — subtracts ✓/);
  }, 60_000);
});
