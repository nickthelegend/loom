/**
 * Landing — one project's goal PRs on their way to main (Loom Teams, Phase 4,
 * "land safely"; docs/teams-architecture.md D52–D64).
 *
 * The owner's daemon watches its own goal PRs (D52) and, per PR:
 *   - reruns a failing required check once; a pass on rerun is a flake (D53)
 *   - hands a real failure's log tail to the goal's orchestrator, which reopens
 *     the goal and routes a fix; at most `autoFixAttempts` (D54, D55)
 *   - runs a cross-vendor review on open and after each fix, at most 3 times,
 *     posting a COMMENT review and the `loom/review` status (D60, D61)
 *   - when the owner clicks Land: fresh main in, fast tests, push, auto-merge
 *     (D56–D58); stacks land bottom-up (D59)
 *   - says when a goal needs someone, adopts a teammate's goal on request, and
 *     hands it back when green (D63)
 *
 * Everything outside git and the hub goes through `gh`, injectable for tests.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logbook } from "../core/logbook.js";
import { notify } from "../core/notify.js";
import { isTerminal, newLanding, type LandingState, type OrchestraRun } from "../core/orchestra.js";
import { sealForTeam, type TeamKey } from "../core/team-crypto.js";
import type { FeedEvent, FeedIn, HubClient, Presence } from "../core/team-hub.js";
import {
  addMergeGroupTrigger,
  doctor,
  failureVerdict,
  fixPrompt,
  logTail,
  parseReview,
  pickReviewer,
  renderReview,
  reviewFixPrompt,
  reviewPrompt,
  reviewState,
  runIdOf,
  summarizeChecks,
  triggersMergeGroup,
  triggersPullRequest,
  type CheckRow,
  type DoctorFinding,
} from "../core/team-landing.js";
import { zoneOf } from "../core/team-leases.js";
import type { TeamPolicy } from "../core/team-policy.js";
import type { ProjectRuntime } from "./runtime.js";

export interface Exec {
  (cmd: string, args: string[], cwd: string, opts?: { timeoutMs?: number; input?: string }): Promise<{ code: number; out: string; err: string }>;
}

export interface LandingDeps {
  hub(): HubClient | null;
  deviceId(): string | null;
  github(): string | null;
  share(rt: ProjectRuntime): Promise<{ teamId: string; repo: string } | null>;
  keys(teamId: string): TeamKey[];
  feed(teamId: string): FeedEvent[];
  presence(teamId: string): Presence[];
  policy(): Promise<TeamPolicy | null>;
  exec?: Exec;
  /** Tests shorten the rerun settle window. */
  rerunSettleMs?: number;
}

export const POLL_MS = 30_000;
/** D63: a teammate offline this long with a goal that needs someone can be adopted. */
export const ADOPT_AFTER_MS = 15 * 60_000;
/** How long after asking for a rerun a still-failing check is taken as the old result. */
export const RERUN_SETTLE_MS = 90_000;

const realExec: Exec = (cmd, args, cwd, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, out: String(out), err: String(errOut) }),
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

export class Landing {
  private busy = new Set<string>(); // runId → a step (fix, review, land) in flight
  private timer: ReturnType<typeof setInterval> | null = null;
  private alerted = new Set<string>();
  private rerunAt = new Map<string, number>(); // `${sha}:${check}` → when we asked for the rerun

  constructor(private rt: ProjectRuntime, private deps: LandingDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => logbook.warn("team", "landing tick failed", String(e))), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private exec(cmd: string, args: string[], cwd = this.rt.info.dir, opts?: { timeoutMs?: number; input?: string }) {
    return (this.deps.exec ?? realExec)(cmd, args, cwd, opts);
  }

  private async gh(args: string[], cwd = this.rt.info.dir): Promise<string> {
    const r = await this.exec("gh", args, cwd);
    if (r.code !== 0) throw new Error((r.err || r.out).trim().slice(0, 500) || `gh ${args[0]} failed`);
    return r.out;
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const r = await this.exec("git", args, cwd);
    if (r.code !== 0) throw new Error((r.err || r.out).trim().slice(0, 500));
    return r.out;
  }

  /** Goals with a PR this daemon is responsible for right now. */
  goals(): OrchestraRun[] {
    return this.rt.orchestra
      .list()
      .filter((r) => r.landing && r.landing.state !== "merged" && r.landing.state !== "closed");
  }

  private set(run: OrchestraRun, patch: Partial<LandingState>): LandingState {
    return this.rt.orchestra.setLanding(run.id, patch) ?? run.landing!;
  }

  // ── the poll (D52) ──

  async tick(): Promise<void> {
    const policy = await this.deps.policy().catch(() => null);
    for (const run of this.goals()) {
      if (this.busy.has(run.id)) continue;
      try {
        await this.poll(run, policy);
      } catch (e) {
        logbook.warn("team", `landing: couldn't check PR #${run.landing!.pr}`, String(e));
      }
    }
  }

  /** One look at one goal PR, and whatever it calls for. */
  async poll(run: OrchestraRun, policy: TeamPolicy | null = null): Promise<LandingState> {
    const l = run.landing!;
    if (l.adoptedBy) return l; // a teammate holds it (D63)
    if (l.stack?.length) return this.pollStack(run, policy);
    const view = JSON.parse(await this.gh(["pr", "view", String(l.pr), "--json", "state,headRefOid,url"])) as { state: string; headRefOid: string };
    if (view.state === "MERGED") return this.merged(run);
    if (view.state === "CLOSED") return this.set(run, { state: "closed" });
    const sha = view.headRefOid;
    if (sha !== l.headSha) this.set(run, { headSha: sha });
    // a goal back at work (a fix, a conflict) is the orchestrator's until it delivers
    if (!isTerminal(run.status) && run.status !== "waiting_human") return this.set(run, { state: "fixing" });

    const rows = await this.checks(l.pr);
    const sum = summarizeChecks(rows);
    const cur = this.set(run, {
      checks: { failing: sum.failing.map((c) => c.name), pending: sum.pending.map((c) => c.name), passing: sum.passing.length },
    });

    // flakes: failed at this commit, rerun, now passing (D53)
    for (const c of sum.passing) {
      const k = `${sha}:${c.name}`;
      if (cur.reruns.includes(k) && !cur.flaky.includes(k)) {
        this.set(run, { flaky: [...cur.flaky, k] });
        await this.flaky(run, c.name).catch(() => {});
      }
    }

    const maxFix = policy?.landing.autoFixAttempts ?? 2;
    for (const c of sum.failing) {
      const k = `${sha}:${c.name}`;
      const verdict = failureVerdict(c.name, sha, run.landing!.reruns);
      if (verdict === "rerun") {
        const id = runIdOf(c.link);
        this.set(run, { reruns: [...run.landing!.reruns, k], state: "failing" });
        this.rerunAt.set(k, Date.now());
        if (id) await this.gh(["run", "rerun", id, "--failed"]).catch((e) => logbook.warn("team", "rerun failed", String(e)));
        return run.landing!;
      }
      // GitHub takes a moment to show a requested rerun as queued: don't read the old failure as a second one
      if (Date.now() - (this.rerunAt.get(k) ?? 0) < (this.deps.rerunSettleMs ?? RERUN_SETTLE_MS)) return run.landing!;
      if (run.landing!.fixAttempts >= maxFix) return this.needsHuman(run, `required check "${c.name}" still fails after ${maxFix} fix attempts`);
      if (run.status !== "completed") return this.needsHuman(run, `required check "${c.name}" fails and the goal is waiting on you`);
      await this.fix(run, c, maxFix);
      return run.landing!;
    }

    // review on open and after each fix push (D60, D61)
    const rev = policy?.review ?? { enabled: true, maxRuns: 3 };
    if (rev.enabled && run.landing!.reviewedSha !== sha && run.landing!.reviews < rev.maxRuns && !sum.failing.length) {
      void this.review(run, sha, maxFix);
    }

    if (sum.pending.length) return this.set(run, { state: run.landing!.landRequested ? "landing" : "pending" });
    if (run.landing!.review?.state === "failure" && !run.landing!.review.overridden) return run.landing!;
    if (sum.green || !rows.length) {
      const st = this.set(run, { state: run.landing!.landRequested ? "landing" : "green", reason: undefined });
      if (run.from) await this.handBack(run).catch(() => {});
      return st;
    }
    return run.landing!;
  }

  /** Required checks (D54), or every check when the repo requires none. */
  private async checks(pr: number): Promise<CheckRow[]> {
    const fields = "name,state,bucket,link,workflow";
    // exit 8 = checks pending, 1 = some failing: the JSON is still on stdout
    const req = await this.exec("gh", ["pr", "checks", String(pr), "--required", "--json", fields], this.rt.info.dir);
    const parse = (s: string) => {
      try {
        return JSON.parse(s) as CheckRow[];
      } catch {
        return null;
      }
    };
    const rows = parse(req.out);
    if (rows && rows.length) return rows;
    const all = await this.exec("gh", ["pr", "checks", String(pr), "--json", fields], this.rt.info.dir);
    return parse(all.out) ?? [];
  }

  private async fix(run: OrchestraRun, check: CheckRow, max: number): Promise<void> {
    if (this.busy.has(run.id)) return;
    this.busy.add(run.id);
    try {
      const id = runIdOf(check.link);
      const raw = id ? (await this.exec("gh", ["run", "view", id, "--log-failed"], this.rt.info.dir)).out : "";
      const attempt = run.landing!.fixAttempts + 1;
      this.set(run, { fixAttempts: attempt, state: "fixing", reason: undefined });
      await this.rt.orchestra.reopen(
        run.id,
        fixPrompt({ pr: run.landing!.pr, check: check.name, log: logTail(raw || `(no log available — see ${check.link ?? "the PR's checks"})`), attempt, max }),
        `check ${check.name} failed`,
      );
    } finally {
      this.busy.delete(run.id);
    }
  }

  private async flaky(run: OrchestraRun, check: string): Promise<void> {
    const l = run.landing!;
    await this.exec("gh", ["label", "create", "loom:flaky", "--color", "fbca04", "--description", "A check failed, then passed on rerun"], this.rt.info.dir);
    await this.exec("gh", ["pr", "edit", String(l.pr), "--add-label", "loom:flaky"], this.rt.info.dir);
    await this.gh(["pr", "comment", String(l.pr), "--body",
      `**Loom:** \`${check}\` failed, then passed when rerun on the same commit — likely flaky. No agent changed code for it.`]);
    await this.post(run, "check_flaky", { pr: l.pr, check });
  }

  private async needsHuman(run: OrchestraRun, reason: string): Promise<LandingState> {
    const st = this.set(run, { state: "needs_human", reason });
    const key = `${run.id}:${reason}`;
    if (!this.alerted.has(key)) {
      this.alerted.add(key);
      this.alert(run, `PR #${st.pr} needs you: ${reason}`);
      await this.post(run, "goal_needs_someone", { pr: st.pr, url: st.url, runId: run.id, branch: this.rt.orchestra.prBranch(run), reason: reason.slice(0, 200) });
    }
    return st;
  }

  /** D25: the owner's phone (and desktop) hears about what needs them. */
  private alert(run: OrchestraRun, text: string): void {
    this.rt.log.append({ kind: "orchestra", chat: run.chat, payload: { phase: "alert", runId: run.id, text } });
    notify({ title: `Loom · ${this.rt.info.name}`, body: text });
  }

  private async merged(run: OrchestraRun): Promise<LandingState> {
    const mc = await this.exec("gh", ["pr", "view", String(run.landing!.pr), "--json", "mergeCommit"], this.rt.info.dir).catch(() => null);
    let mergeSha: string | undefined;
    try {
      mergeSha = mc?.code === 0 ? (JSON.parse(mc.out) as { mergeCommit?: { oid?: string } }).mergeCommit?.oid : undefined;
    } catch {
      mergeSha = undefined;
    }
    const st = this.set(run, { state: "merged", landRequested: false, ...(mergeSha ? { mergeSha } : {}) });
    await this.post(run, "goal_landed", { runId: run.id, pr: st.pr, costUsd: Math.round(run.costUsd * 100) / 100 }, `landed:${run.id}`);
    if (run.from) await this.handBack(run).catch(() => {});
    return st;
  }

  // ── review (D60, D61) ──

  async review(run: OrchestraRun, sha: string, maxFix = 2): Promise<void> {
    const key = `review:${run.id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    const l = run.landing!;
    try {
      const authors = [run.orchestrator.kind, ...run.tasks.map((t) => t.kind)];
      const reviewer = pickReviewer(authors, this.rt.usableKinds());
      const repo = await this.repo();
      if (!reviewer) {
        this.set(run, { reviews: l.reviews + 1, reviewedSha: sha, review: { state: "skipped", reviewer: null, high: 0, findings: 0, at: Date.now() } });
        if (repo) await this.postStatus(repo, sha, "success", "skipped: no agent from another vendor is installed");
        return;
      }
      // "reviewing…" is a courtesy; failing to post it mustn't cost the review
      if (repo) await this.postStatus(repo, sha, "pending", `${reviewer} is reviewing`).catch(() => {});
      const diff = await this.gh(["pr", "diff", String(l.pr)]);
      const planFile = path.join(run.dir, "plans", run.id, "PLAN.md");
      const plan = fs.existsSync(planFile) ? fs.readFileSync(planFile, "utf8") : undefined;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-review-"));
      let said = "";
      try {
        said = await this.rt.askAgent(reviewer, tmp, reviewPrompt({ goal: run.goal, ...(plan ? { plan } : {}), diff, pr: l.pr }));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      const parsed = parseReview(said) ?? { summary: "The reviewer's reply had no findings block; treated as no findings.", findings: [] };
      const state = reviewState(parsed.findings);
      const high = parsed.findings.filter((f) => f.severity === "high").length;
      await this.gh(["pr", "review", String(l.pr), "--comment", "--body", renderReview(parsed, reviewer)]);
      if (repo) await this.postStatus(repo, sha, state, state === "failure" ? `${high} high-severity finding${high === 1 ? "" : "s"}` : "no high-severity findings");
      this.set(run, {
        reviews: run.landing!.reviews + 1,
        reviewedSha: sha,
        review: { state, reviewer, high, findings: parsed.findings.length, at: Date.now() },
      });
      await this.post(run, "review_submitted", { pr: l.pr, reviewer, state, high, findings: parsed.findings.length });
      if (state === "failure") {
        // high findings share the fix budget with failing checks (D55, D61)
        if (run.landing!.fixAttempts >= maxFix) {
          await this.needsHuman(run, `the review found ${high} high-severity problem${high === 1 ? "" : "s"} and the fix budget is spent`);
        } else if (run.status === "completed") {
          const attempt = run.landing!.fixAttempts + 1;
          this.set(run, { fixAttempts: attempt, state: "fixing" });
          await this.rt.orchestra.reopen(run.id, reviewFixPrompt(parsed.findings, attempt, maxFix), "review found high-severity problems");
        }
      }
    } catch (e) {
      logbook.warn("team", `review of PR #${l.pr} failed`, String(e));
      this.set(run, { reviews: run.landing!.reviews + 1, reviewedSha: sha });
    } finally {
      this.busy.delete(key);
    }
  }

  /** The owner overrides a blocking review, with a reason on record (D61). */
  async overrideReview(runId: string, reason: string): Promise<LandingState> {
    const run = this.mustGoal(runId);
    const l = run.landing!;
    if (!reason.trim()) throw new Error("say why the review is wrong");
    const repo = await this.repo();
    if (repo && l.headSha) await this.postStatus(repo, l.headSha, "success", `overridden by ${this.deps.github() ?? "the owner"}: ${reason}`.slice(0, 140));
    await this.gh(["pr", "comment", String(l.pr), "--body", `**Loom review overridden** by @${this.deps.github() ?? "the owner"}: ${reason}`]);
    return this.set(run, { review: { ...(l.review ?? { state: "failure", reviewer: null, high: 0, findings: 0, at: Date.now() }), overridden: reason } });
  }

  private async postStatus(repo: string, sha: string, state: "success" | "failure" | "pending", description: string): Promise<void> {
    await this.gh(["api", "-X", "POST", `repos/${repo}/statuses/${sha}`,
      "-f", `state=${state}`, "-f", "context=loom/review", "-f", `description=${description.slice(0, 140)}`]);
  }

  // ── land (D56–D59) ──

  /**
   * The owner clicked Land. Bring fresh main in (one agent attempt at a
   * conflict), run the fast tests, push, and ask GitHub to merge when the
   * rules pass. It keeps going on later polls until the PR merges.
   */
  async land(runId: string): Promise<LandingState> {
    const run = this.mustGoal(runId);
    if (run.from) throw new Error("this goal is a teammate's — hand it back and let them land it");
    if (!isTerminal(run.status)) throw new Error(`the goal is still ${run.status} — land it once it's done`);
    if (this.busy.has(run.id)) throw new Error("a fix or land step is already running for this goal");
    this.busy.add(run.id);
    try {
      this.set(run, { landRequested: true, state: "landing", reason: undefined });
      const policy = await this.deps.policy().catch(() => null);
      const base = run.baseBranch ?? "main";
      if (run.landing!.stack?.length) return await this.landStack(run);

      // 1. fresh main (D56, D58)
      await this.git(["fetch", "-q", "origin", base], run.dir);
      const merge = await this.exec("git", ["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "merge", "--no-edit", "-q", `origin/${base}`], run.dir);
      if (merge.code !== 0) {
        const files = (await this.exec("git", ["diff", "--name-only", "--diff-filter=U"], run.dir)).out.split("\n").filter(Boolean);
        await this.exec("git", ["merge", "--abort"], run.dir);
        return await this.conflict(run, base, files, policy);
      }

      // 2. fast tests, if the team set any (D57)
      if (policy?.landing.fastTest) {
        const t = await this.exec("sh", ["-c", policy.landing.fastTest], run.dir, { timeoutMs: policy.landing.timeoutMin * 60_000 });
        if (t.code !== 0) {
          const max = policy.landing.autoFixAttempts;
          if (run.landing!.fixAttempts >= max) return await this.needsHuman(run, `the fast tests (\`${policy.landing.fastTest}\`) fail on fresh ${base}`);
          const attempt = run.landing!.fixAttempts + 1;
          this.set(run, { fixAttempts: attempt, state: "fixing" });
          await this.rt.orchestra.reopen(
            run.id,
            fixPrompt({ pr: run.landing!.pr, check: `fast tests: ${policy.landing.fastTest}`, log: logTail(`${t.out}\n${t.err}`), attempt, max }),
            "fast tests failed before landing",
          );
          return run.landing!;
        }
      }

      // 3. push, then 4. merge when GitHub's rules pass
      await this.git(["push", "-q", "origin", `${run.branch}:${this.rt.orchestra.prBranch(run)}`], run.dir);
      await this.autoMerge(run.landing!.pr, "--squash");
      return this.set(run, { state: "landing" });
    } finally {
      this.busy.delete(run.id);
    }
  }

  private async autoMerge(pr: number, method: "--squash" | "--merge"): Promise<void> {
    const r = await this.exec("gh", ["pr", "merge", String(pr), "--auto", method], this.rt.info.dir);
    if (r.code === 0) return;
    // Auto-merge off for the repo (and nothing pending): the human's click merges now, under GitHub's rules.
    if (/auto.?merge|clean status|not allowed/i.test(r.err + r.out)) {
      await this.gh(["pr", "merge", String(pr), method]);
      return;
    }
    throw new Error((r.err || r.out).trim().slice(0, 300));
  }

  private async conflict(run: OrchestraRun, base: string, files: string[], policy: TeamPolicy | null): Promise<LandingState> {
    const zone = policy ? zoneOf({ globs: files, files, prefixes: [] }, policy.hardZones) : null;
    if (zone) return this.needsHuman(run, `fresh ${base} conflicts in the hard zone ${zone} (${files.slice(0, 5).join(", ")}) — a human resolves those`);
    if (run.landing!.conflictTried) return this.needsHuman(run, `fresh ${base} still conflicts after one agent attempt: ${files.slice(0, 5).join(", ")}`);
    this.set(run, { conflictTried: true, state: "fixing" });
    await this.rt.orchestra.reopen(
      run.id,
      [
        `Landing this goal: ${base} moved on, and merging it into the goal conflicts in: ${files.join(", ") || "(unknown files)"}.`,
        `Spawn ONE task (id "fixmerge") for the worker that owns those files: in its worktree run \`git fetch origin ${base} && git merge origin/${base}\`, resolve the conflicts keeping both sides' intent, run the tests, and commit. Then review and finish with done.`,
        "If the two sides can't both be kept, don't guess — ask (the `ask` action).",
      ].join("\n"),
      `conflict with ${base}`,
    );
    return run.landing!;
  }

  // ── stacks (D59): land bottom-up with the merge method, retargeting the next PR ──

  private async pollStack(run: OrchestraRun, _policy: TeamPolicy | null): Promise<LandingState> {
    const l = run.landing!;
    const stack = [...l.stack!];
    for (let i = 0; i < stack.length; i++) {
      const p = stack[i]!;
      if (p.state === "MERGED") continue;
      const v = JSON.parse(await this.gh(["pr", "view", String(p.pr), "--json", "state"])) as { state: string };
      stack[i] = { ...p, state: v.state };
      if (v.state === "MERGED") {
        const next = stack[i + 1];
        if (next) {
          await this.gh(["pr", "edit", String(next.pr), "--base", run.baseBranch ?? "main"]);
          stack[i + 1] = { ...next, base: run.baseBranch ?? "main" };
          if (l.landRequested) await this.autoMerge(next.pr, "--merge").catch((e) => logbook.warn("team", "stack: couldn't queue the next PR", String(e)));
        }
      }
    }
    this.set(run, { stack });
    if (stack.every((p) => p.state === "MERGED")) return this.merged(run);
    return run.landing!;
  }

  private async landStack(run: OrchestraRun): Promise<LandingState> {
    const lowest = run.landing!.stack!.find((p) => p.state !== "MERGED");
    if (!lowest) return this.merged(run);
    await this.autoMerge(lowest.pr, "--merge");
    return this.set(run, { state: "landing" });
  }

  // ── adopt (D63) ──

  /**
   * Teammates' goal PRs that need someone: the owner said so (out of fix
   * attempts), or its checks fail and the owner has been offline 15+ minutes.
   */
  async adoptable(): Promise<Array<{ pr: number; url: string; branch: string; owner: string; ownerRunId?: string; reason: string }>> {
    const share = await this.deps.share(this.rt);
    const me = this.deps.github();
    if (!share || !me) return [];
    const feed = this.deps.feed(share.teamId).filter((e) => e.repo === share.repo);
    const presence = this.deps.presence(share.teamId);
    const lastSeen = (who: string) => Math.max(0, ...presence.filter((p) => p.github === who).map((p) => p.ts));
    const prs = new Map<number, { pr: number; url: string; branch: string; owner: string; ownerRunId?: string; reason: string; open: boolean; needs: boolean; failing: boolean }>();
    for (const e of feed) {
      const n = Number(e.meta.pr ?? e.meta.number);
      if (!n) continue;
      const cur = prs.get(n) ?? { pr: n, url: String(e.meta.url ?? ""), branch: String(e.meta.branch ?? ""), owner: String(e.meta.author ?? e.github ?? ""), reason: "", open: true, needs: false, failing: false };
      if (e.type === "pr_opened") Object.assign(cur, { url: String(e.meta.url ?? cur.url), branch: String(e.meta.branch ?? cur.branch), owner: String(e.meta.author ?? cur.owner) });
      if (e.type === "goal_needs_someone") Object.assign(cur, { needs: true, reason: String(e.meta.reason ?? "needs someone"), ownerRunId: String(e.meta.runId ?? ""), owner: e.github ?? cur.owner, branch: String(e.meta.branch ?? cur.branch) });
      if (e.type === "check_failed") Object.assign(cur, { failing: true });
      if (e.type === "check_passed") Object.assign(cur, { failing: false });
      if (e.type === "goal_adopted" || e.type === "goal_returned") Object.assign(cur, { needs: false, failing: false });
      if (e.type === "pr_merged" || e.type === "pr_closed" || e.type === "goal_landed") cur.open = false;
      prs.set(n, cur);
    }
    const now = Date.now();
    return [...prs.values()]
      .filter((p) => p.open && p.owner && p.owner !== me && p.branch.startsWith("loom/"))
      .filter((p) => p.needs || (p.failing && now - lastSeen(p.owner) > ADOPT_AFTER_MS))
      .map(({ open: _o, needs, failing: _f, ...p }) => ({ ...p, reason: needs ? p.reason : `checks failing and ${p.owner} has been offline 15+ min` }));
  }

  /** Take a teammate's goal: a small run on this machine that makes its PR green. */
  async adopt(pr: number, opts: { orchestrator?: string; workers?: string[] } = {}): Promise<OrchestraRun> {
    const pick = (await this.adoptable()).find((p) => p.pr === pr);
    if (!pick) throw new Error(`PR #${pr} isn't waiting on anyone — only a goal that needs someone can be adopted`);
    const ownerRunId = pick.ownerRunId || /^loom\/orchestra\/([^/]+)\//.exec(pick.branch)?.[1];
    const run = await this.rt.orchestra.start({
      goal: [
        `Make ${pick.owner}'s PR #${pr} green. ${pick.reason}.`,
        `You are working on their branch ${pick.branch}; your fixes are pushed back to it. Look at the failing checks (\`gh pr checks ${pr}\`, \`gh run view <id> --log-failed\`), fix the cause with the smallest change, and finish. Don't change what the goal does.`,
      ].join("\n"),
      ...(opts.orchestrator ? { orchestrator: opts.orchestrator } : {}),
      ...(opts.workers ? { workers: opts.workers } : {}),
      from: { branch: pick.branch, pr, url: pick.url, owner: pick.owner, ...(ownerRunId ? { ownerRunId } : {}) },
    });
    await this.post(run, "goal_adopted", { pr, runId: ownerRunId ?? null, by: this.deps.github(), owner: pick.owner, adopterRunId: run.id });
    return run;
  }

  /** The adopted PR is green (or merged): give the goal back (D63). */
  private async handBack(run: OrchestraRun): Promise<void> {
    if (!run.from || run.landing?.returned) return;
    this.set(run, { returned: true });
    await this.post(run, "goal_returned", { pr: run.from.pr, runId: run.from.ownerRunId ?? null, by: this.deps.github(), owner: run.from.owner });
  }

  /** The owner's side: a teammate took (or returned) one of our goals. */
  onTeamEvent(e: FeedEvent): void {
    if (e.type !== "goal_adopted" && e.type !== "goal_returned") return;
    if (e.github === this.deps.github()) return;
    const run = this.rt.orchestra.list().find((r) => r.landing && (r.id === e.meta.runId || r.landing.pr === Number(e.meta.pr)));
    if (!run) return;
    if (e.type === "goal_adopted") {
      this.set(run, { adoptedBy: e.github ?? "a teammate", state: "fixing" });
      this.alert(run, `${e.github ?? "A teammate"} adopted PR #${run.landing!.pr} to get it green`);
    } else {
      this.set(run, { adoptedBy: undefined, state: "open", reason: undefined });
      void this.rt.orchestra.pullPushed(run).catch(() => {});
      this.alert(run, `${e.github ?? "A teammate"} handed PR #${run.landing!.pr} back`);
    }
  }

  // ── repo doctor (D62) ──

  async doctor(): Promise<{ repo: string | null; branch: string; findings: DoctorFinding[]; fixable: string[] }> {
    const repo = await this.repo();
    const dir = this.rt.info.dir;
    const head = (await this.exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).out.trim() || "origin/main";
    const branch = head.replace(/^origin\//, "");
    let rules: Array<{ type: string; parameters?: Record<string, unknown> }> | null = null;
    if (repo) {
      const r = await this.exec("gh", ["api", `repos/${repo}/rules/branches/${branch}`], dir);
      if (r.code === 0) {
        try {
          rules = JSON.parse(r.out);
        } catch {
          rules = null;
        }
      }
    }
    const workflows = await this.workflows(head);
    const fixable = Object.entries(workflows).filter(([, y]) => triggersPullRequest(y) && !triggersMergeGroup(y) && addMergeGroupTrigger(y)).map(([p]) => p);
    return { repo, branch, findings: doctor({ branch, rules, workflows }), fixable };
  }

  private async workflows(head: string): Promise<Record<string, string>> {
    const dir = this.rt.info.dir;
    const ls = await this.exec("git", ["ls-tree", "--name-only", `${head}:.github/workflows`], dir);
    const out: Record<string, string> = {};
    for (const f of ls.out.split("\n").filter((x) => /\.ya?ml$/.test(x))) {
      const p = `.github/workflows/${f}`;
      const t = await this.exec("git", ["show", `${head}:${p}`], dir);
      if (t.code === 0) out[p] = t.out;
    }
    return out;
  }

  /** Open the PR adding `merge_group:` to every pull-request workflow missing it. Never touches settings. */
  async doctorFix(): Promise<{ prUrl: string | null; files: string[] }> {
    const d = await this.doctor();
    if (!d.fixable.length) return { prUrl: null, files: [] };
    const dir = this.rt.info.dir;
    await this.exec("git", ["fetch", "-q", "origin", d.branch], dir);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-doctor-"));
    const wt = path.join(tmp, "wt");
    const branch = "loom/doctor-merge-group";
    try {
      await this.git(["worktree", "add", "-q", "--detach", wt, `origin/${d.branch}`], dir);
      for (const f of d.fixable) {
        const abs = path.join(wt, f);
        const next = addMergeGroupTrigger(fs.readFileSync(abs, "utf8"));
        if (next) fs.writeFileSync(abs, next);
      }
      await this.git(["add", ...d.fixable], wt);
      await this.git(["-c", "user.name=Loom", "-c", "user.email=loom@users.noreply.github.com", "commit", "-q", "-m",
        "ci: run workflows in the merge queue (merge_group)", "-m", "Queued PRs wait forever for required checks that don't run on merge_group. Opened by `loom team doctor --fix`."], wt);
      await this.git(["push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`], wt);
      const out = await this.gh(["pr", "create", "--base", d.branch, "--head", branch, "--title", "ci: run workflows in the merge queue",
        "--body", `Adds \`merge_group:\` to ${d.fixable.map((f) => `\`${f}\``).join(", ")} so required checks also run for PRs in the merge queue.\n\nOpened by \`loom team doctor --fix\` (Loom Teams D62). It changes no repo settings.`], wt);
      return { prUrl: out.match(/https:\/\/\S+/)?.[0] ?? null, files: d.fixable };
    } finally {
      await this.exec("git", ["worktree", "remove", "--force", wt], dir);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── plumbing ──

  private mustGoal(runId: string): OrchestraRun {
    const run = this.rt.orchestra.get(runId);
    if (!run) throw new Error(`no goal "${runId}"`);
    if (!run.landing) {
      const url = run.delivered?.prUrl;
      const n = Number(/\/pull\/(\d+)/.exec(url ?? "")?.[1]);
      if (!url || !n) throw new Error(`goal ${runId} has no PR — deliver it as a PR first`);
      this.rt.orchestra.setLanding(run.id, newLanding(n, url));
    }
    return run;
  }

  private async repo(): Promise<string | null> {
    return (await this.deps.share(this.rt))?.repo ?? null;
  }

  private async post(run: OrchestraRun, type: FeedIn["type"], meta: Record<string, unknown>, dedupe?: string): Promise<void> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    const share = await this.deps.share(this.rt);
    if (!hub || !share || !device) return;
    const keys = this.deps.keys(share.teamId);
    const key = keys[keys.length - 1];
    await hub
      .appendFeed(share.teamId, {
        repo: share.repo,
        type,
        meta,
        deviceId: device,
        ...(key ? { sealed: sealForTeam(key, { goal: run.goal.split("\n")[0]!.slice(0, 200) }) } : {}),
        ...(dedupe ? { dedupeKey: dedupe } : {}),
      })
      .catch((e) => logbook.warn("team", `couldn't post ${type}`, String(e)));
  }

  status(): Array<Record<string, unknown>> {
    return this.rt.orchestra
      .list()
      .filter((r) => r.landing)
      .map((r) => ({ runId: r.id, goal: r.goal.split("\n")[0]!.slice(0, 120), status: r.status, costUsd: r.costUsd, ...(r.from ? { adopted: r.from } : {}), landing: r.landing }));
  }
}
