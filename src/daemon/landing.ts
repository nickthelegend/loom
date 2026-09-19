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
 *   - Phase 6, on a repo with no merge queue: the landing train (D20, D79–D82).
 *     Land queues the goal in its lanes (path scopes from `landing.lanes`); the
 *     slot is a hub lease on `.loom/landing/<lane>`, a hard zone, so one goal per
 *     lane holds it. The holder brings fresh base in, runs the fast tests,
 *     pushes, waits for green on that head, and merges; a red check gives the
 *     slot back and the goal requeues itself once it's green again.
 *   - Phase 6: a feed event about one of its PRs (a webhook's check result, a
 *     merge) polls that goal now, not at the next 30s tick (D84)
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
  actionsMinutes,
  triggersMergeGroup,
  triggersPullRequest,
  landingRoute,
  laneClaim,
  lanesFor,
  landRunId,
  MAIN_LANE,
  queuedReason,
  trainStep,
  type CheckRow,
  type CheckSummary,
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
  /** How long a freshly pushed turn with no checks reported yet waits before "no CI" (tests: 0). */
  trainSettleMs?: number;
}

export const POLL_MS = 30_000;
/** D63: a teammate offline this long with a goal that needs someone can be adopted. */
export const ADOPT_AFTER_MS = 15 * 60_000;
/** How long after asking for a rerun a still-failing check is taken as the old result. */
export const RERUN_SETTLE_MS = 90_000;
/** A turn's fresh push with no checks reported after this long has no CI to wait for. */
export const TRAIN_SETTLE_MS = 2 * 60_000;
/** How long a repo's branch rules (merge queue or not) are trusted (D80). */
export const RULES_TTL_MS = 10 * 60_000;

export const defaultExec: Exec = (cmd, args, cwd, opts) => realExec(cmd, args, cwd, opts);

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
  private rules = new Map<string, { at: number; rules: Array<{ type: string }> | null }>(); // `${repo}@${base}`
  private inflight = new Map<string, { p: Promise<LandingState>; again: boolean }>(); // runId → a poll in flight

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
      await this.pollNow(run, policy);
    }
  }

  /**
   * Poll one goal now, at most one poll per goal at a time: a poll asked for
   * while one runs makes that one go round again (a webhook's check result
   * mid-poll isn't lost), and both callers get its answer.
   */
  pollNow(run: OrchestraRun, policy?: TeamPolicy | null): Promise<LandingState> {
    const cur = this.inflight.get(run.id);
    if (cur) {
      cur.again = true;
      return cur.p;
    }
    const slot = { again: false, p: Promise.resolve(run.landing!) };
    slot.p = (async () => {
      try {
        const pol = policy === undefined ? await this.deps.policy().catch(() => null) : policy;
        let st = run.landing!;
        do {
          slot.again = false;
          const r = this.rt.orchestra.get(run.id) ?? run;
          if (!r.landing || r.landing.state === "merged" || r.landing.state === "closed") return r.landing ?? st;
          try {
            st = await this.poll(r, pol);
          } catch (e) {
            logbook.warn("team", `landing: couldn't check PR #${r.landing.pr}`, String(e));
            return r.landing;
          }
        } while (slot.again);
        return st;
      } finally {
        this.inflight.delete(run.id);
      }
    })();
    this.inflight.set(run.id, slot);
    return slot.p;
  }

  /** One look at one goal PR, and whatever it calls for. */
  async poll(run: OrchestraRun, policy: TeamPolicy | null = null): Promise<LandingState> {
    const l = run.landing!;
    if (l.adoptedBy) return l; // a teammate holds it (D63)
    if (l.stack?.length) return this.pollStack(run, policy);
    const view = JSON.parse(await this.gh(["pr", "view", String(l.pr), "--json", "state,headRefOid,url,reviewDecision"])) as { state: string; headRefOid: string; reviewDecision?: string };
    if (view.state === "MERGED") return this.merged(run);
    if (view.state === "CLOSED") {
      await this.releaseSlot(run, "PR closed");
      return this.set(run, { state: "closed" });
    }
    const sha = view.headRefOid;
    if (sha !== l.headSha) this.set(run, { headSha: sha });
    // a goal back at work (a fix, a conflict) is the orchestrator's until it delivers
    if (!isTerminal(run.status) && run.status !== "waiting_human") {
      await this.releaseSlot(run, "the goal is being fixed");
      return this.set(run, { state: "fixing" });
    }

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
    // a red check on its turn gives the lane back: the goal requeues once it's green (D82)
    if (sum.failing.length && run.landing!.slot) await this.releaseSlot(run, `"${sum.failing[0]!.name}" failed on its turn`);
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

    if (run.landing!.landRequested && run.landing!.train) return this.trainTurn(run, policy, sha, view.reviewDecision, rows, sum);

    // Waiting on a human (GitHub refused the merge, fixes ran out) stays so until
    // something changes — a new commit, or Land again. A later poll used to flip
    // it to "green" and drop the reason, hiding what the owner was alerted about.
    if (run.landing!.state === "needs_human" && !run.landing!.landRequested && run.landing!.needsHumanSha === sha) return run.landing!;

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
    const st = this.set(run, { state: "needs_human", needsHumanSha: run.landing!.headSha, reason });
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
    await this.releaseSlot(run, "merged");
    const mc = await this.exec("gh", ["pr", "view", String(run.landing!.pr), "--json", "mergeCommit"], this.rt.info.dir).catch(() => null);
    let mergeSha: string | undefined;
    try {
      mergeSha = mc?.code === 0 ? (JSON.parse(mc.out) as { mergeCommit?: { oid?: string } }).mergeCommit?.oid : undefined;
    } catch {
      mergeSha = undefined;
    }
    const ciMinutes = await this.ciMinutes(run).catch(() => null);
    const st = this.set(run, { state: "merged", landRequested: false, ...(mergeSha ? { mergeSha } : {}), ...(ciMinutes !== null ? { ciMinutes } : {}) });
    await this.post(
      run,
      "goal_landed",
      { runId: run.id, pr: st.pr, costUsd: Math.round(run.costUsd * 100) / 100, ...(ciMinutes !== null ? { ciMinutes } : {}) },
      `landed:${run.id}`,
    );
    if (run.from) await this.handBack(run).catch(() => {});
    return st;
  }

  /** Actions minutes the goal's branch used (§10: CI cost per goal, no App needed). */
  async ciMinutes(run: OrchestraRun): Promise<number | null> {
    const repo = await this.repo();
    if (!repo) return null;
    const branch = this.rt.orchestra.prBranch(run);
    const r = await this.exec("gh", ["api", `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`], this.rt.info.dir);
    if (r.code !== 0) return null;
    try {
      const runs = (JSON.parse(r.out) as { workflow_runs?: Array<Record<string, unknown>> }).workflow_runs ?? [];
      return actionsMinutes(runs);
    } catch {
      return null;
    }
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
      // the owner overrode this commit while the review ran: the findings go on the PR, the decision stands (D61)
      const prior = run.landing!.review;
      const kept = prior?.overridden && prior.overriddenSha === sha ? { overridden: prior.overridden, overriddenSha: sha } : null;
      if (repo && !kept) await this.postStatus(repo, sha, state, state === "failure" ? `${high} high-severity finding${high === 1 ? "" : "s"}` : "no high-severity findings");
      this.set(run, {
        reviews: run.landing!.reviews + 1,
        reviewedSha: sha,
        review: { state, reviewer, high, findings: parsed.findings.length, at: Date.now(), ...(kept ?? {}) },
      });
      await this.post(run, "review_submitted", { pr: l.pr, reviewer, state, high, findings: parsed.findings.length });
      if (state === "failure" && !kept) {
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
    return this.set(run, { review: { ...(l.review ?? { state: "failure", reviewer: null, high: 0, findings: 0, at: Date.now() }), overridden: reason, ...(l.headSha ? { overriddenSha: l.headSha } : {}) } });
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
    const policy = await this.deps.policy().catch(() => null);
    // D20, D80: no merge queue on a team repo → the train; Loom merges when the goal's lanes are its
    if (!run.landing!.stack?.length && (await this.route(run)) === "train") {
      this.set(run, { landRequested: true, train: true, state: "landing", reason: undefined });
      return this.pollNow(run, policy);
    }
    this.busy.add(run.id);
    try {
      this.set(run, { landRequested: true, train: false, state: "landing", reason: undefined });
      if (run.landing!.stack?.length) return await this.landStack(run);
      if (!(await this.pushrebase(run, policy))) return run.landing!;
      // 4. merge when GitHub's rules pass (the merge queue, or auto-merge)
      await this.autoMerge(run.landing!.pr, "--squash");
      return this.set(run, { state: "landing" });
    } finally {
      this.busy.delete(run.id);
    }
  }

  /**
   * Pushrebase-lite (D56–D58): fresh base merged into the goal (one agent
   * attempt at a conflict), the fast tests, push. False when it went to a fix
   * or a human instead of pushing.
   */
  private async pushrebase(run: OrchestraRun, policy: TeamPolicy | null): Promise<boolean> {
    const base = run.baseBranch ?? "main";
    // 1. fresh main (D56, D58)
    await this.git(["fetch", "-q", "origin", base], run.dir);
    const merge = await this.exec("git", ["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "merge", "--no-edit", "-q", `origin/${base}`], run.dir);
    if (merge.code !== 0) {
      const files = (await this.exec("git", ["diff", "--name-only", "--diff-filter=U"], run.dir)).out.split("\n").filter(Boolean);
      await this.exec("git", ["merge", "--abort"], run.dir);
      await this.conflict(run, base, files, policy);
      return false;
    }

    // 2. fast tests, if the team set any (D57)
    if (policy?.landing.fastTest) {
      const t = await this.exec("sh", ["-c", policy.landing.fastTest], run.dir, { timeoutMs: policy.landing.timeoutMin * 60_000 });
      if (t.code !== 0) {
        const max = policy.landing.autoFixAttempts;
        if (run.landing!.fixAttempts >= max) {
          await this.needsHuman(run, `the fast tests (\`${policy.landing.fastTest}\`) fail on fresh ${base}`);
          return false;
        }
        const attempt = run.landing!.fixAttempts + 1;
        this.set(run, { fixAttempts: attempt, state: "fixing" });
        await this.rt.orchestra.reopen(
          run.id,
          fixPrompt({ pr: run.landing!.pr, check: `fast tests: ${policy.landing.fastTest}`, log: logTail(`${t.out}\n${t.err}`), attempt, max }),
          "fast tests failed before landing",
        );
        return false;
      }
    }

    // 3. push
    await this.git(["push", "-q", "origin", `${run.branch}:${this.rt.orchestra.prBranch(run)}`], run.dir);
    return true;
  }

  // ── the landing train (Phase 6: D20's fallback, D79–D82) ──

  /** Merge queue, train or auto-merge, for this goal (D80). Branch rules are cached per repo for 10 minutes. */
  async route(run: OrchestraRun): Promise<"queue" | "train" | "auto"> {
    const share = await this.deps.share(this.rt);
    const team = Boolean(share && this.deps.hub() && this.deps.deviceId());
    if (!share) return "auto";
    const base = run.baseBranch ?? "main";
    const key = `${share.repo}@${base}`;
    let hit = this.rules.get(key);
    if (!hit || Date.now() - hit.at > RULES_TTL_MS) {
      const r = await this.exec("gh", ["api", `repos/${share.repo}/rules/branches/${base}`], this.rt.info.dir);
      let rules: Array<{ type: string }> | null = null;
      if (r.code === 0) {
        try {
          const v = JSON.parse(r.out) as unknown;
          rules = Array.isArray(v) ? (v as Array<{ type: string }>) : null;
        } catch {
          rules = null;
        }
      }
      hit = { at: Date.now(), rules };
      this.rules.set(key, hit);
    }
    return landingRoute({ rules: hit.rules, team, stack: Boolean(run.landing?.stack?.length) });
  }

  /** The lanes this goal's PR needs: path scopes matched against its diff (D81). */
  private async lanesOf(run: OrchestraRun, policy: TeamPolicy | null): Promise<string[]> {
    const lanes = policy?.landing.lanes ?? {};
    if (!Object.keys(lanes).length) return [MAIN_LANE];
    const pr = await this.exec("gh", ["pr", "diff", String(run.landing!.pr), "--name-only"], this.rt.info.dir);
    let files = pr.code === 0 ? pr.out.split("\n").map((f) => f.trim()).filter(Boolean) : null;
    if (!files) {
      const base = run.baseBranch ?? "main";
      const local = await this.exec("git", ["diff", "--name-only", `origin/${base}...${run.branch}`], run.dir);
      files = local.code === 0 ? local.out.split("\n").map((f) => f.trim()).filter(Boolean) : null;
    }
    // what it changes is unknown: it waits for every lane rather than guess one
    if (!files) return [...new Set([...Object.keys(lanes), MAIN_LANE])].sort();
    return lanesFor(files, lanes);
  }

  /**
   * One step of a goal in the train: claim its lanes (or queue behind their
   * holder), bring fresh base in and push on a new turn, wait for green on
   * that head, merge.
   */
  private async trainTurn(
    run: OrchestraRun,
    policy: TeamPolicy | null,
    sha: string,
    reviewDecision: string | undefined,
    rows: CheckRow[],
    sum: CheckSummary,
  ): Promise<LandingState> {
    const l = run.landing!;
    if (sum.failing.length) return l; // the fix loop has it; it requeues once green
    if (l.review?.state === "failure" && !l.review.overridden) {
      await this.releaseSlot(run, "the review blocks it");
      return run.landing!;
    }
    if (!l.slot) {
      // red at this commit and rerunning: it rejoins once the rerun says flake (it's green), not before
      if (sum.pending.length && l.reruns.some((k) => k.startsWith(`${sha}:`) && !l.flaky.includes(k))) {
        return this.set(run, { state: "pending", reason: "rerunning a failed check before it rejoins the landing train" });
      }
      // a turn is for a PR that can merge: one waiting on a human approval doesn't hold a lane
      if (/CHANGES_REQUESTED|REVIEW_REQUIRED/i.test(reviewDecision ?? "")) {
        return this.set(run, { state: "queued", reason: "waiting for a reviewer's approval before its turn to land" });
      }
      if (!(await this.claimSlot(run, policy))) return run.landing!;
    }
    let head = sha;
    let cur = { rows, sum };
    if (run.landing!.turnSha !== head) {
      if (!(await this.pushrebase(run, policy))) {
        await this.releaseSlot(run, "its turn found a conflict or failing fast tests");
        return run.landing!;
      }
      const pushed = (await this.git(["rev-parse", run.branch], run.dir)).trim();
      if (pushed && pushed !== head) {
        head = pushed;
        const fresh = await this.checks(l.pr);
        cur = { rows: fresh, sum: summarizeChecks(fresh) };
        this.set(run, { checks: { failing: cur.sum.failing.map((c) => c.name), pending: cur.sum.pending.map((c) => c.name), passing: cur.sum.passing.length } });
      }
      this.set(run, { headSha: head, turnSha: head, turnAt: Date.now() });
      if (cur.sum.failing.length) return this.set(run, { state: "landing" }); // the next poll's red path takes it
    }
    const step = trainStep({
      holding: true,
      turnSha: run.landing!.turnSha,
      headSha: head,
      checks: cur.sum,
      rows: cur.rows.length,
      reviewing: this.busy.has(`review:${run.id}`),
      sinceTurnMs: Date.now() - (run.landing!.turnAt ?? 0),
      settleMs: this.deps.trainSettleMs ?? TRAIN_SETTLE_MS,
    });
    if (step !== "merge") return this.set(run, { state: "landing", reason: undefined });
    return this.mergeNow(run);
  }

  /**
   * Take every lane the goal needs, in order, or none: a lane held by someone
   * else queues the goal behind them. The hub decides atomically — a lane's
   * slot is a hard zone (D31), so a second claimer is refused.
   */
  private async claimSlot(run: OrchestraRun, policy: TeamPolicy | null): Promise<boolean> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    const share = await this.deps.share(this.rt);
    if (!hub || !device || !share) {
      this.set(run, { state: "queued", reason: "waiting for the team hub" });
      return false;
    }
    const lanes = await this.lanesOf(run, policy);
    this.set(run, { lanes });
    const mine = landRunId(run.id);
    const queued = async (lane: string, who: string | null, holderRun: string | null): Promise<false> => {
      const reason = queuedReason(who, lane);
      const news = run.landing!.state !== "queued" || run.landing!.reason !== reason;
      this.set(run, { state: "queued", slot: false, reason });
      if (news) await this.post(run, "land_queued", { runId: run.id, pr: run.landing!.pr, lane, lanes, behind: who, behindRun: holderRun });
      return false;
    };
    // look before taking: a goal that would only get some of its lanes doesn't take any
    const held = (await hub.leases(share.teamId, share.repo).catch(() => [])).filter((x) => !x.stale && x.runId !== mine && x.runId.endsWith(":land"));
    for (const lane of lanes) {
      const h = held.find((x) => x.taskId === laneClaim(lane).taskId);
      if (h) return queued(lane, h.github, h.runId.replace(/:land$/, ""));
    }
    const keys = this.deps.keys(share.teamId);
    const key = keys[keys.length - 1];
    let got = 0;
    for (const lane of lanes) {
      const c = laneClaim(lane);
      const res = await hub.claimLease(share.teamId, {
        globs: c.globs,
        files: c.files,
        prefixes: c.prefixes,
        hardZones: c.hardZones,
        deviceId: device,
        repo: share.repo,
        runId: mine,
        taskId: c.taskId,
        ...(key ? { sealed: sealForTeam(key, { goal: run.goal.split("\n")[0]!.slice(0, 200), task: `landing in lane ${lane}` }) } : {}),
      });
      if (!res.lease) {
        // lost a race for a later lane: give back the earlier ones ("rollback" wakes nobody — ticks retry)
        if (got) await hub.releaseLeases(share.teamId, mine, `rollback: lane ${lane} is taken`).catch(() => 0);
        const b = res.blockedBy;
        return queued(lane, b?.lease.github ?? null, b ? b.lease.runId.replace(/:land$/, "") : null);
      }
      got++;
    }
    this.set(run, { slot: true, turnSha: undefined, turnAt: undefined, state: "landing", reason: undefined });
    await this.post(run, "land_turn", { runId: run.id, pr: run.landing!.pr, lanes });
    return true;
  }

  /** Give the goal's lanes back (and only them: its task leases stay until it lands, D36). */
  private async releaseSlot(run: OrchestraRun, reason: string): Promise<void> {
    if (!run.landing?.slot) return;
    this.set(run, { slot: false, turnSha: undefined, turnAt: undefined });
    const hub = this.deps.hub();
    const share = await this.deps.share(this.rt);
    if (!hub || !share) return;
    await hub.releaseLeases(share.teamId, landRunId(run.id), reason).catch((e) => logbook.warn("team", "couldn't release the landing slot", String(e)));
  }

  /** Still the holder of every lane? A slot that went stale (a long sleep) may be someone else's now. */
  private async stillHolding(run: OrchestraRun): Promise<boolean> {
    const hub = this.deps.hub();
    const share = await this.deps.share(this.rt);
    if (!hub || !share) return false;
    let leases;
    try {
      leases = await hub.leases(share.teamId, share.repo);
    } catch {
      return true; // a hub hiccup isn't a lost slot; GitHub's own rules still guard the merge
    }
    const mine = leases.filter((x) => x.runId === landRunId(run.id) && !x.stale && x.deviceId === this.deps.deviceId());
    return (run.landing!.lanes ?? [MAIN_LANE]).every((lane) => mine.some((x) => x.taskId === laneClaim(lane).taskId));
  }

  /** Its turn, green: merge now (not --auto — the train is the queue), then hand the lanes on. */
  private async mergeNow(run: OrchestraRun): Promise<LandingState> {
    if (!(await this.stillHolding(run))) {
      this.set(run, { slot: false, turnSha: undefined, turnAt: undefined });
      return this.set(run, { state: "queued", reason: "its landing slot lapsed — queuing again" });
    }
    const r = await this.exec("gh", ["pr", "merge", String(run.landing!.pr), "--squash"], this.rt.info.dir);
    if (r.code !== 0) {
      await this.releaseSlot(run, "GitHub refused the merge");
      this.set(run, { landRequested: false });
      return this.needsHuman(run, `GitHub refused the merge: ${(r.err || r.out).trim().slice(0, 200)}`);
    }
    return this.merged(run);
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
      const v = JSON.parse(await this.gh(["pr", "view", String(p.pr), "--json", "state,headRefOid"])) as { state: string; headRefOid?: string };
      stack[i] = { ...p, state: v.state };
      // A lower slice failing for real (rerun once already) can't be auto-fixed
      // in place — fixes land on the goal's own branch at the top. Fold the
      // stack into one PR and let the normal fix loop take it (D59, D55).
      const top = i === stack.length - 1;
      if (!top && v.state === "OPEN" && v.headRefOid) {
        const failing = summarizeChecks(await this.checks(p.pr)).failing;
        for (const c of failing) {
          const k = `${v.headRefOid}:${c.name}`;
          if (!run.landing!.reruns.includes(k)) {
            this.set(run, { reruns: [...run.landing!.reruns, k] });
            this.rerunAt.set(k, Date.now());
            const id = runIdOf(c.link);
            if (id) await this.gh(["run", "rerun", id, "--failed"]).catch(() => {});
            continue;
          }
          if (Date.now() - (this.rerunAt.get(k) ?? 0) < (this.deps.rerunSettleMs ?? RERUN_SETTLE_MS)) continue;
          return this.collapseStack(run, stack, `"${c.name}" fails on part ${i + 1} (#${p.pr})`);
        }
      }
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

  /**
   * Close the stack's unmerged lower PRs and point the top one at the base
   * branch: one PR again, carrying everything, that the fix loop can fix.
   */
  async collapseStack(run: OrchestraRun, stack: NonNullable<LandingState["stack"]>, why: string): Promise<LandingState> {
    const base = run.baseBranch ?? "main";
    const top = stack[stack.length - 1]!;
    for (const p of stack.slice(0, -1)) {
      if (p.state === "MERGED" || p.state === "CLOSED") continue;
      await this.gh(["pr", "close", String(p.pr), "--comment", `**Loom:** ${why}, which can't be fixed in place on a stacked slice. Folded into #${top.pr}, which now carries this part too.`]).catch(() => {});
    }
    await this.gh(["pr", "edit", String(top.pr), "--base", base]);
    await this.gh(["pr", "comment", String(top.pr), "--body", `**Loom:** the stack was folded into this PR (${why}). It now targets \`${base}\` and carries every part; fixes land here.`]).catch(() => {});
    return this.set(run, { stack: undefined, pr: top.pr, url: top.url, state: "failing" });
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
    // D82: a lane may have freed — queued goals try now, not at the next tick.
    // A partial claim's rollback wakes nobody (two goals would wake each other forever).
    if ((e.type === "lease_released" && !/^rollback/.test(String(e.meta.reason ?? ""))) || e.type === "goal_landed") {
      for (const run of this.goals()) if (run.landing!.state === "queued" && run.landing!.landRequested) void this.pollNow(run);
    }
    // D84: a check result or a merge on one of our PRs (a webhook, or polling) — look now
    if (e.type === "check_failed" || e.type === "check_passed" || e.type === "pr_merged") this.wakePr(e);
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

  private wakePr(e: FeedEvent): void {
    const n = Number(e.meta.number ?? e.meta.pr);
    if (!Number.isInteger(n) || n <= 0) return;
    const runs = this.goals().filter((r) => r.landing!.pr === n && !r.landing!.adoptedBy);
    if (!runs.length) return;
    void (async () => {
      const share = await this.deps.share(this.rt).catch(() => null);
      if (e.repo && share && e.repo !== share.repo) return; // same number, another repo
      for (const run of runs) if (!this.busy.has(run.id)) void this.pollNow(run);
    })();
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
