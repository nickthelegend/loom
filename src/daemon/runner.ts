/**
 * Runner — a member's always-on Loom daemon that takes goals from the team hub
 * (Loom Teams, Phase 5; docs/teams-architecture.md D67–D78).
 *
 * A runner is a normal Loom daemon in runner mode. It registers one of its
 * owner's devices as a runner (D74) and claims jobs from the hub (D71):
 *   start     a new goal on this machine
 *   continue  a goal moved here mid-run (its branches on refs/loom/run/<id>/*)
 *   fix       make the owner's goal PR green while they're away (D69)
 *   return    hand a goal back to the owner's laptop (D76 "Bring back")
 *   land      the owner clicked Land on a goal that lives here
 *
 * Each goal gets a fresh clone as its own project (D70). The runner process
 * runs with a scrubbed environment; with Docker, the claimed job runs in a
 * container instead (`loom runner exec`). A job stays claimed, heartbeating a
 * progress snapshot, until its goal lands, fails or moves on (D76).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeProjectConfig, loomHome } from "../core/registry.js";
import { logbook } from "../core/logbook.js";
import { isTerminal, taskSummary, type OrchestraRun } from "../core/orchestra.js";
import { openFromTeam, sealForTeam, type TeamKey } from "../core/team-crypto.js";
import type { FeedEvent, HubClient, Job, Presence, Runner as RunnerRecord } from "../core/team-hub.js";
import { loadPolicy } from "../core/team-policy.js";
import type { Landing } from "./landing.js";
import type { ProjectRuntime } from "./runtime.js";

// ── configuration ──

export interface RunnerConfig {
  enabled: boolean;
  /** Take teammates' goals too, when the repo's policy allows (D68). */
  shared: boolean;
  capacity: number;
  /** auto = Docker when it's running, else a fresh clone in this process (D70). */
  isolation: "auto" | "docker" | "inline";
  /** Agent kinds this runner offers; empty = whatever is installed. */
  kinds: string[];
  label?: string;
  image?: string;
}

export const DEFAULT_RUNNER: RunnerConfig = { enabled: false, shared: false, capacity: 1, isolation: "auto", kinds: [] };

export function runnerConfigPath(): string {
  return path.join(loomHome(), "runner.json");
}

export function readRunnerConfig(): RunnerConfig {
  try {
    return { ...DEFAULT_RUNNER, ...(JSON.parse(fs.readFileSync(runnerConfigPath(), "utf8")) as Partial<RunnerConfig>) };
  } catch {
    return { ...DEFAULT_RUNNER };
  }
}

export function writeRunnerConfig(c: RunnerConfig): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(runnerConfigPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

/** The runner's GitHub token lives beside its config, 0600, and never goes through the hub (D77). */
export function runnerTokenPath(): string {
  return path.join(loomHome(), "runner-token");
}

export function readRunnerToken(): string | null {
  try {
    return fs.readFileSync(runnerTokenPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeRunnerToken(token: string): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(runnerTokenPath(), token.trim() + "\n", { mode: 0o600 });
}

// ── the environment agents inherit (D70) ──

/** Variables agents need: model API keys, GitHub for pushing, Loom's own. */
const KEEP = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|XAI_API_KEY|OPENROUTER_API_KEY|GH_TOKEN|GITHUB_TOKEN|LOOM_[A-Z0-9_]+)$/;
const SECRETISH = /(SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|_KEY$|^KEY$|API_KEY|CREDENTIAL|DATABASE_URL|_DSN$|SESSION|COOKIE|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION)/i;

/**
 * What stays in a runner's environment: everything that isn't secret-shaped,
 * plus the agent keys and GitHub token it's meant to have. A box someone also
 * uses for production work doesn't hand its secrets to agents.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (KEEP.test(k) || !SECRETISH.test(k)) out[k] = v;
    else removed.push(k);
  }
  return { env: out, removed: removed.sort() };
}

/** The container a job runs in when Docker is available (D70). Agent logins mount read-only. */
export function dockerCommand(opts: { jobId: string; teamId: string; image: string; jobHome: string; home?: string }): string[] {
  const home = opts.home ?? os.homedir();
  const mounts = [".claude", ".codex", ".config/opencode", ".gemini", ".grok"]
    .filter((d) => fs.existsSync(path.join(home, d)))
    .flatMap((d) => ["-v", `${path.join(home, d)}:/home/loom/${d}:ro`]);
  return [
    "run", "--rm", "--name", `loom-job-${opts.jobId}`,
    "-v", `${opts.jobHome}:/loom`,
    ...mounts,
    "-e", "LOOM_HOME=/loom",
    ...["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "GH_TOKEN"].flatMap((k) => ["-e", k]),
    opts.image,
    "loom", "runner", "exec", "--job", opts.jobId, "--team", opts.teamId,
  ];
}

// ── the job payload ──

export interface JobPayload {
  goal?: string;
  orchestrator?: string;
  workers?: string[];
  plan?: boolean;
  /** continue: the moved run. */
  record?: OrchestraRun;
  /** return / land: the run it's about. */
  runId?: string;
  /** fix: the PR to make green. */
  pr?: number;
  url?: string;
  branch?: string;
  ownerRunId?: string;
  /** A human-readable "from" (the laptop's name). */
  from?: string;
}

export interface JobProgress {
  runId: string | null;
  goal: string;
  status: string;
  tasks: Array<Record<string, unknown>>;
  costUsd: number;
  landing: OrchestraRun["landing"] | null;
  question?: string;
  at: number;
}

export function progressOf(run: OrchestraRun | undefined, fallbackGoal = ""): JobProgress {
  return {
    runId: run?.id ?? null,
    goal: (run?.goal ?? fallbackGoal).split("\n")[0]!.slice(0, 200),
    status: run?.status ?? "preparing",
    tasks: run ? run.tasks.map(taskSummary) : [],
    costUsd: run ? Math.round(run.costUsd * 100) / 100 : 0,
    landing: run?.landing ?? null,
    ...(run?.question ? { question: run.question.slice(0, 300) } : {}),
    at: Date.now(),
  };
}

// ── the runner ──

export interface RunnerDeps {
  hub(): HubClient | null;
  deviceId(): string | null;
  userId(): string | null;
  github(): string | null;
  teams(): string[];
  keys(teamId: string): TeamKey[];
  feed(teamId: string): FeedEvent[];
  presence(teamId: string): Presence[];
  /** Open a directory as a project (registered, runtime attached to Team Link). */
  openProject(dir: string, name: string): Promise<ProjectRuntime>;
  closeProject(rt: ProjectRuntime): Promise<void>;
  share(rt: ProjectRuntime, teamId: string): Promise<void>;
  landing(rt: ProjectRuntime): Landing;
  /** Where to clone a repo from; defaults to GitHub. Tests point it at a bare repo. */
  cloneUrl?(repo: string): string;
  /** Agent kinds available here (config override, else installed). */
  kinds(): Promise<string[]>;
  config(): RunnerConfig;
  /** team.json, copied into a job's container home (Docker isolation). */
  statePath(): string;
  /** `loom runner exec`: run exactly this job, then call done (inside a container). */
  exec?: { teamId: string; jobId: string; done(ok: boolean): void };
  /** Tests: how long the owner must be away before the runner takes a CI fix (D69). */
  awayMs?: number;
}

interface Active {
  job: Job;
  teamId: string;
  payload: JobPayload;
  rt: ProjectRuntime | null;
  dir: string | null;
  runId: string | null;
  lastBeat: number;
  unsub?: () => void;
}

const TICK_MS = 15_000;
const BEAT_MS = 60_000;
/** A goal of the owner's needing a CI fix, owner offline this long: the runner takes it (D69). */
const OWNER_AWAY_MS = 15 * 60_000;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out)),
    );
  });
}

export class Runner {
  private active = new Map<string, Active>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private claiming = false;
  private registered: RunnerRecord | null = null;
  private autoFixed = new Set<string>();
  lastError: string | null = null;

  constructor(private deps: RunnerDeps) {}

  get running(): boolean {
    return Boolean(this.timer);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    if (this.deps.exec) return this.execOne(this.deps.exec);
    await this.register();
    this.timer = setInterval(() => void this.tick().catch((e) => this.fail(e)), TICK_MS);
    this.timer.unref?.();
    void this.tick().catch((e) => this.fail(e));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    logbook.warn("runner", "runner tick failed", this.lastError);
  }

  async register(): Promise<RunnerRecord | null> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    if (!hub || !device) return null;
    const c = this.deps.config();
    this.registered = await hub.registerRunner({ deviceId: device, kinds: await this.deps.kinds(), shared: c.shared, capacity: c.capacity });
    return this.registered;
  }

  /** A hub event: a job appeared, changed, or was cancelled. */
  onJob(teamId: string, job: Job): void {
    const mine = this.active.get(job.id);
    if (mine && job.state === "cancelled") void this.cancel(mine);
    if (job.state === "queued") void this.tick().catch((e) => this.fail(e));
    void teamId;
  }

  /** Claim what we can, beat for what we hold, finish what's done, look for goals to rescue. */
  async tick(): Promise<void> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    if (!hub || !device) return;
    if (!this.registered) await this.register();
    for (const a of [...this.active.values()]) await this.checkDone(a).catch((e) => this.fail(e));
    for (const a of this.active.values()) {
      if (Date.now() - a.lastBeat > BEAT_MS) await this.beat(a).catch(() => {});
    }
    await this.rescueOwnGoals().catch((e) => this.fail(e));
    if (this.claiming) return;
    this.claiming = true;
    try {
      const cap = this.deps.config().capacity;
      for (const teamId of this.deps.teams()) {
        while (this.goalCount() < cap || this.hasInstant()) {
          const job = await hub.claimJob(teamId, device);
          if (!job) break;
          await this.execute(teamId, job);
          if (this.goalCount() >= cap) break;
        }
      }
    } finally {
      this.claiming = false;
    }
  }

  /** Goals being worked on (return/land jobs are instant and don't count). */
  private goalCount(): number {
    return [...this.active.values()].filter((a) => a.job.kind === "start" || a.job.kind === "continue" || a.job.kind === "fix").length;
  }

  private hasInstant(): boolean {
    return false;
  }

  /** Inside a container: the dispatcher claimed this job; run it here, then exit (D70). */
  private async execOne(x: { teamId: string; jobId: string; done(ok: boolean): void }): Promise<void> {
    const hub = this.deps.hub();
    if (!hub) throw new Error("runner exec: not signed in");
    const job = (await hub.jobs(x.teamId)).find((j) => j.id === x.jobId);
    if (!job || job.state !== "claimed") throw new Error(`runner exec: job ${x.jobId} isn't claimed`);
    await this.execute(x.teamId, job, { inline: true });
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.fail(e));
      if (!this.active.has(x.jobId)) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        x.done(true);
      }
    }, TICK_MS);
  }

  private dockerOk: { ok: boolean; at: number } | null = null;

  /** D70: Docker per goal when it's running (auto), always (docker), or never (inline). */
  async useDocker(): Promise<boolean> {
    const mode = this.deps.config().isolation;
    if (mode === "inline") return false;
    if (!this.dockerOk || Date.now() - this.dockerOk.at > 5 * 60_000) {
      const ok = await new Promise<boolean>((resolve) => execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 }, (err) => resolve(!err)));
      this.dockerOk = { ok, at: Date.now() };
    }
    if (mode === "docker" && !this.dockerOk.ok) throw new Error("isolation is docker, but Docker isn't running on this runner");
    return this.dockerOk.ok;
  }

  /** Hand a claimed goal to its own container; it heartbeats and finishes the job itself. */
  private async dispatchDocker(teamId: string, job: Job): Promise<void> {
    const jobHome = path.join(loomHome(), "runner", "jobs", job.id);
    fs.mkdirSync(jobHome, { recursive: true, mode: 0o700 });
    fs.copyFileSync(this.deps.statePath(), path.join(jobHome, "team.json"));
    if (readRunnerToken()) fs.copyFileSync(runnerTokenPath(), path.join(jobHome, "runner-token"));
    fs.writeFileSync(path.join(jobHome, "runner.json"), JSON.stringify({ ...this.deps.config(), enabled: false, isolation: "inline" }));
    const args = dockerCommand({ jobId: job.id, teamId, image: this.deps.config().image ?? "loom-runner", jobHome });
    const a: Active = { job, teamId, payload: {}, rt: null, dir: jobHome, runId: null, lastBeat: Date.now() };
    this.active.set(job.id, a);
    execFile("docker", args, { maxBuffer: 64 * 1024 * 1024 }, (err) => {
      this.active.delete(job.id);
      fs.rmSync(jobHome, { recursive: true, force: true });
      if (err) {
        const hub = this.deps.hub();
        const device = this.deps.deviceId();
        if (hub && device) void hub.finishJob(teamId, job.id, device, { state: "failed", error: `container: ${err.message.slice(0, 300)}` }).catch(() => {});
      }
    });
  }

  /** Run one claimed job. */
  async execute(teamId: string, job: Job, opts: { inline?: boolean } = {}): Promise<void> {
    const payload = (openFromTeam(this.deps.keys(teamId), job.sealed) ?? {}) as JobPayload;
    const a: Active = { job, teamId, payload, rt: null, dir: null, runId: null, lastBeat: 0 };
    try {
      if (job.kind === "return" || job.kind === "land") return await this.instant(a);
      if (!opts.inline && (await this.useDocker())) return await this.dispatchDocker(teamId, job);
      this.active.set(job.id, a);
      await this.beat(a);
      await this.prepare(a);
      const rt = a.rt!;
      // Someone else's goal: only when the repo's reviewed policy allows shared runners (D68).
      if (job.userId !== this.deps.userId()) {
        const policy = await loadPolicy(rt.info.dir);
        if (!policy.runners.shared) throw new Error(`${job.repo}'s loom.team.json doesn't allow shared runners (runners.shared)`);
      }
      let run: OrchestraRun;
      if (job.kind === "continue") {
        if (!a.payload.record) throw new Error("a continue job needs the run record");
        run = await rt.orchestra.importRun(a.payload.record, { from: a.payload.from ?? job.github });
      } else if (job.kind === "fix") {
        if (!a.payload.pr || !a.payload.branch) throw new Error("a fix job needs the PR and its branch");
        run = await rt.orchestra.start({
          goal: a.payload.goal ?? `Make PR #${a.payload.pr} green: its required checks are failing. Find the cause in \`gh pr checks ${a.payload.pr}\` / \`gh run view <id> --log-failed\`, fix it with the smallest change, and finish.`,
          ...(a.payload.orchestrator ? { orchestrator: a.payload.orchestrator } : {}),
          ...(a.payload.workers?.length ? { workers: a.payload.workers } : {}),
          from: { branch: a.payload.branch, pr: a.payload.pr, url: a.payload.url ?? "", owner: job.github, ...(a.payload.ownerRunId ? { ownerRunId: a.payload.ownerRunId } : {}) },
        });
      } else {
        if (!a.payload.goal) throw new Error("a start job needs a goal");
        run = await rt.orchestra.start({
          goal: a.payload.goal,
          ...(a.payload.orchestrator ? { orchestrator: a.payload.orchestrator } : {}),
          ...(a.payload.workers?.length ? { workers: a.payload.workers } : {}),
          ...(a.payload.plan ? { plan: true } : {}),
        });
      }
      a.runId = run.id;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      a.unsub = rt.log.onEvent((e) => {
        if (e.kind !== "orchestra" || (e.payload as { runId?: string }).runId !== run.id) return;
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          void this.beat(a).then(() => this.checkDone(a)).catch(() => {});
        }, 1000);
        debounce.unref?.();
      });
      await this.beat(a);
    } catch (e) {
      await this.finish(a, "failed", undefined, e instanceof Error ? e.message : String(e));
    }
  }

  /** return and land: act on a goal this runner holds, answer at once. */
  private async instant(a: Active): Promise<void> {
    const hub = this.deps.hub()!;
    const device = this.deps.deviceId()!;
    const holder = [...this.active.values()].find((x) => x.runId && x.runId === a.payload.runId);
    try {
      if (!holder?.rt || !holder.runId) throw new Error(`this runner doesn't hold goal ${a.payload.runId ?? "?"}`);
      if (a.job.kind === "land") {
        const l = await this.deps.landing(holder.rt).land(holder.runId);
        await hub.finishJob(a.teamId, a.job.id, device, { state: "done", result: this.seal(a.teamId, { landing: l }) });
        await this.beat(holder);
        return;
      }
      const { record } = await holder.rt.orchestra.moveOut(holder.runId, a.payload.from ?? `${a.job.github}'s laptop`);
      await hub.finishJob(a.teamId, a.job.id, device, { state: "done", result: this.seal(a.teamId, { record }) });
      await this.finish(holder, "done", { moved: true, to: a.payload.from ?? "the owner's laptop" });
    } catch (e) {
      await hub.finishJob(a.teamId, a.job.id, device, { state: "failed", error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    }
  }

  /** A fresh clone of the job's repo, opened as its own project (D70). */
  private async prepare(a: Active): Promise<void> {
    const base = path.join(loomHome(), "runner", "work", a.job.id);
    const name = a.job.repo.split("/")[1]!;
    const dir = path.join(base, name);
    fs.mkdirSync(base, { recursive: true });
    const url = this.deps.cloneUrl?.(a.job.repo) ?? `https://github.com/${a.job.repo}.git`;
    await git(["clone", "-q", url, dir], base);
    await git(["config", "loom.repo", a.job.repo], dir);
    await git(["config", "user.name", `${this.deps.github() ?? "loom"} (runner)`], dir);
    await git(["config", "user.email", `${this.deps.github() ?? "loom"}@users.noreply.github.com`], dir);
    await git(["remote", "set-head", "origin", "--auto"], dir).catch(() => {});
    if (readRunnerToken()) {
      // push with the runner's own fine-grained token (D77), never baked into the remote URL
      await git(["config", "credential.helper", `!f() { echo username=x-access-token; echo "password=$(cat '${runnerTokenPath()}')"; }; f`], dir);
    }
    const kinds = await this.deps.kinds();
    const c = this.deps.config();
    writeProjectConfig(dir, {
      name: `${name} · runner`,
      agents: kinds.map((k, i) => ({ id: k, kind: k, role: i === 0 ? "orchestrator" : "worker" })),
      brain: { extractor: "off" },
      git: { delivery: "pr" },
      ...({ runner: { job: a.job.id, owner: a.job.github, label: c.label ?? os.hostname() } } as Record<string, unknown>),
    } as Parameters<typeof writeProjectConfig>[1]);
    a.dir = base;
    a.rt = await this.deps.openProject(dir, `${name} (runner · ${a.job.github})`);
    a.rt.runnerMode = true;
    await this.deps.share(a.rt, a.teamId);
  }

  private seal(teamId: string, value: unknown) {
    const keys = this.deps.keys(teamId);
    return sealForTeam(keys[keys.length - 1]!, value);
  }

  /** Heartbeat the job with a progress snapshot. */
  private async beat(a: Active): Promise<void> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    if (!hub || !device) return;
    const run = a.runId ? a.rt?.orchestra.get(a.runId) : undefined;
    await hub.heartbeatJob(a.teamId, a.job.id, device, this.seal(a.teamId, progressOf(run, a.payload.goal ?? a.payload.record?.goal)));
    a.lastBeat = Date.now();
  }

  /** D76: a job is done when its goal lands, fails, or moves on. */
  private async checkDone(a: Active): Promise<void> {
    if (!a.rt || !a.runId) return;
    const run = a.rt.orchestra.get(a.runId);
    if (!run) return;
    const l = run.landing;
    if (run.status === "moved") return this.finish(a, "done", { moved: true });
    if (run.status === "failed" || run.status === "aborted") return this.finish(a, "failed", progressOf(run), run.error ?? run.status);
    if (!isTerminal(run.status)) return;
    if (run.from && l?.returned) return this.finish(a, "done", progressOf(run)); // a fix, handed back
    if (!l && run.delivered && !run.delivered.prUrl) return this.finish(a, "done", progressOf(run)); // delivered without a PR
    if (!l && run.deliveryError) return this.finish(a, "failed", progressOf(run), run.deliveryError);
    if (l && (l.state === "merged" || l.state === "closed")) return this.finish(a, "done", progressOf(run));
  }

  private async finish(a: Active, state: "done" | "failed", result?: unknown, error?: string): Promise<void> {
    const hub = this.deps.hub();
    const device = this.deps.deviceId();
    this.active.delete(a.job.id);
    a.unsub?.();
    if (hub && device) {
      await hub
        .finishJob(a.teamId, a.job.id, device, { state, ...(result ? { result: this.seal(a.teamId, result) } : {}), ...(error ? { error } : {}) })
        .catch((e) => logbook.warn("runner", `couldn't finish job ${a.job.id}`, String(e)));
    }
    await this.cleanup(a);
  }

  /** The goal is over here: its branches are pushed; the clone goes (D70). */
  private async cleanup(a: Active): Promise<void> {
    const run = a.runId ? a.rt?.orchestra.get(a.runId) : undefined;
    if (run && a.rt && run.status === "failed" && !run.delivered) {
      // a failed goal's work isn't thrown away: keep it on its hidden ref for whoever looks next
      await git(["push", "-q", "-f", "origin", `${run.branch}:refs/loom/run/${run.id}/main`], run.dir).catch(() => {});
    }
    if (a.rt) await this.deps.closeProject(a.rt).catch(() => {});
    if (a.dir) fs.rmSync(a.dir, { recursive: true, force: true });
  }

  private async cancel(a: Active): Promise<void> {
    if (a.rt && a.runId) await a.rt.orchestra.abort(a.runId, "the job was cancelled").catch(() => {});
    this.active.delete(a.job.id);
    a.unsub?.();
    await this.cleanup(a);
  }

  /**
   * D69: the owner's goal needs a CI fix and the owner has been away 15+
   * minutes — ask for it as a job for this runner, like an Adopt.
   */
  private async rescueOwnGoals(): Promise<void> {
    const hub = this.deps.hub();
    const me = this.deps.github();
    const device = this.deps.deviceId();
    if (!hub || !me || !device) return;
    for (const teamId of this.deps.teams()) {
      const feed = this.deps.feed(teamId);
      const presence = this.deps.presence(teamId);
      const lastSeen = Math.max(0, ...presence.filter((p) => p.github === me && p.deviceId !== device).map((p) => p.ts));
      for (const e of feed) {
        if (e.type !== "goal_needs_someone" || e.github !== me || e.deviceId === device) continue;
        const pr = Number(e.meta.pr);
        const key = `${teamId}:${e.repo}#${pr}`;
        if (!pr || this.autoFixed.has(key)) continue;
        const later = feed.filter((x) => x.id > e.id && Number(x.meta.pr ?? x.meta.number) === pr);
        if (later.some((x) => ["goal_adopted", "goal_returned", "goal_landed", "pr_merged", "pr_closed"].includes(x.type))) continue;
        if (Date.now() - Math.max(lastSeen, e.ts) < (this.deps.awayMs ?? OWNER_AWAY_MS)) continue;
        this.autoFixed.add(key);
        await hub.createJob(teamId, {
          repo: e.repo!,
          kind: "fix",
          target: device,
          deviceId: device,
          sealed: this.seal(teamId, {
            pr,
            url: String(e.meta.url ?? ""),
            branch: String(e.meta.branch ?? ""),
            ownerRunId: String(e.meta.runId ?? ""),
            from: "your runner (you were away)",
          } satisfies JobPayload),
        });
        logbook.info("runner", `taking PR #${pr} while ${me} is away`);
      }
    }
  }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      registered: this.registered,
      config: this.deps.config(),
      token: Boolean(readRunnerToken()),
      active: [...this.active.values()].map((a) => ({
        jobId: a.job.id,
        kind: a.job.kind,
        repo: a.job.repo,
        owner: a.job.github,
        runId: a.runId,
        project: a.rt?.info.id ?? null,
      })),
      lastError: this.lastError,
    };
  }
}
