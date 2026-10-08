/**
 * One link: a teammate, their agents and one repo, from an invite.
 *
 * Inviting (`inviteTeammate`) is one click on a project: Loom makes sure
 * you're on a team that shares this repo (creating and sharing as needed) and
 * mints a link carrying the team key, the repo and the project's crews. It
 * also remembers to give whoever redeems it push access, through your `gh`.
 *
 * Joining (`Onboarding.start`) is opening that link. Each step is shown as it
 * happens and is safe to run again:
 *   1. sign in      GitHub, on the hub the link names
 *   2. team         redeem the invite, keep the team key
 *   3. repo         use a clone you have, else clone it; a private repo
 *                   waits for the inviter's grant and accepts GitHub's
 *                   invitation itself
 *   4. project      open it in Loom with the agents installed on this machine
 *   5. share        publish presence to the team (who's on what, which files)
 *   6. crews        the inviter's crews, filled from your own agents
 *
 * Nothing here talks to GitHub or a hub directly — TeamLink and `gh`/`git` do.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CrewTeammate } from "../core/crew.js";
import { CREW_ROLES, type CrewRole } from "../core/crew-protocol.js";
import { inviteFragment, previewInvite } from "../core/invite-link.js";
import { logbook } from "../core/logbook.js";
import { unpackInvite, type InviteFragment } from "../core/team-crypto.js";
import type { AgentConfig, ProjectInfo } from "../types.js";
import type { ProjectRuntime } from "./runtime.js";
import { repoOf, type TeamLink } from "./team.js";

export type StepId = "signin" | "team" | "repo" | "project" | "share" | "crews";
export type StepState = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";

export interface OnboardStep {
  id: StepId;
  label: string;
  state: StepState;
  detail?: string;
}

export interface OnboardJob {
  id: string;
  state: "running" | "done" | "failed";
  team: string | null;
  repo: string | null;
  from: string | null;
  steps: OnboardStep[];
  project?: { id: string; name: string; dir: string };
  agents?: string[];
  crews?: string[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface OnboardHost {
  team: TeamLink;
  projects(): ProjectInfo[];
  /** Register a directory as a project (detecting this machine's agents when it has no config). */
  addProject(dir: string, name: string): Promise<ProjectInfo>;
  runtime(id: string): Promise<ProjectRuntime>;
  /** Fan job progress out to connected UIs. */
  broadcast?(frame: Record<string, unknown>): void;
  /** Where repos are cloned when you have none: ~/loom-projects by default. */
  projectsHome?: string;
  /** Tests: clone from a local origin instead of GitHub. */
  clone?: (repo: string, dir: string) => Promise<void>;
  /** Tests swap `gh`. */
  gh?: (args: string[]) => Promise<string>;
  /** How long a private repo waits for access, and how often it looks (ms). */
  accessWaitMs?: number;
  accessPollMs?: number;
}

const LABELS: Record<StepId, string> = {
  signin: "Sign in with GitHub",
  team: "Join the team",
  repo: "Get the repo",
  project: "Open it with your agents",
  share: "Show the team what you work on",
  crews: "Set up the crews",
};

function run(cmd: string, args: string[], cwd?: string, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Onboarding {
  private jobs = new Map<string, OnboardJob>();

  constructor(private readonly host: OnboardHost) {}

  /** What a link would set up — the join page's "Join Acme?" — without redeeming it. */
  async preview(link: string) {
    const p = previewInvite(link);
    if (!p) throw new Error("that isn't a Loom invite link");
    const signedIn = this.host.team.signedInTo(p.hub);
    const member = Boolean(p.teamId && this.host.team.teams().some((t) => t.id === p.teamId));
    let have: ProjectInfo | undefined;
    if (p.repo) for (const pr of this.host.projects()) if ((await this.repoAt(pr.dir)) === p.repo) { have = pr; break; }
    return { ...p, signedIn, member, github: this.host.team.github(), ...(have ? { existing: { id: have.id, name: have.name, dir: have.dir } } : {}) };
  }

  get(id: string): OnboardJob | undefined {
    return this.jobs.get(id);
  }

  /** Start joining. Returns at once; the job reports each step (GET it, or watch `onboard` frames). */
  start(link: string, opts: { dir?: string; into?: string; github?: string; secret?: string; token?: string } = {}): OnboardJob {
    const inv = unpackInvite(inviteFragment(link));
    if (!inv) throw new Error("that isn't a Loom invite link");
    for (const j of this.jobs.values()) {
      if (j.state === "running" && j.team === (inv.team ?? null) && j.repo === (inv.repo ?? null)) return j;
    }
    const job: OnboardJob = {
      id: `ob${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      state: "running",
      team: inv.team ?? null,
      repo: inv.repo ?? null,
      from: inv.from ?? null,
      steps: (["signin", "team", "repo", "project", "share", "crews"] as StepId[]).map((id) => ({ id, label: LABELS[id], state: "pending" })),
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    void this.run(job, link, inv, opts);
    return job;
  }

  /** Start and wait — the CLI's `loom join`, and tests. */
  async join(link: string, opts: Parameters<Onboarding["start"]>[1] = {}): Promise<OnboardJob> {
    const job = this.start(link, opts);
    while (job.state === "running") await sleep(50);
    return job;
  }

  private repoCache = new Map<string, string | null>();

  private async run(job: OnboardJob, link: string, inv: InviteFragment, opts: Parameters<Onboarding["start"]>[1] = {}): Promise<void> {
    const auth = { ...(opts.github ? { github: opts.github } : {}), ...(opts.secret ? { secret: opts.secret } : {}), ...(opts.token ? { token: opts.token } : {}) };
    let step: OnboardStep | undefined;
    const begin = (id: StepId, detail?: string) => {
      step = job.steps.find((s) => s.id === id)!;
      step.state = "running";
      step.detail = detail;
      this.emit(job);
      return step;
    };
    const end = (state: StepState, detail?: string) => {
      step!.state = state;
      if (detail !== undefined) step!.detail = detail;
      this.emit(job);
    };
    try {
      // 1. sign in
      begin("signin");
      if (this.host.team.signedInTo(inv.hub)) end("skipped", `already signed in as @${this.host.team.github()}`);
      else {
        step!.detail = "a GitHub page opens in your browser";
        this.emit(job);
        await this.host.team.signIn(inv.hub, auth);
        end("done", `@${this.host.team.github()}`);
      }

      // 2. team
      begin("team");
      const team = await this.host.team.join(link, auth);
      job.team = team.name;
      end(team.alreadyMember ? "skipped" : "done", team.alreadyMember ? `you're already on ${team.name}` : `you're on ${team.name}`);

      if (!inv.repo) {
        for (const id of ["repo", "project", "share", "crews"] as StepId[]) job.steps.find((s) => s.id === id)!.state = "skipped";
        return this.finish(job);
      }

      // 3. repo
      begin("repo");
      const dir = await this.repoDir(job, inv, opts);

      // 4. project
      begin("project");
      const name = inv.project || inv.repo.split("/")[1]!;
      const info = this.host.projects().find((p) => samePath(p.dir, dir)) ?? (await this.host.addProject(dir, name));
      const rt = await this.host.runtime(info.id);
      job.project = { id: info.id, name: info.name, dir: info.dir };
      const agents = rt.config.agents.filter((a) => a.enabled !== false);
      job.agents = agents.map((a) => a.id);
      end("done", agents.length
        ? `${info.name} with ${agents.map((a) => a.id).join(", ")}`
        : `${info.name} — no agent CLIs found on this machine yet (install Codex, OpenCode or Claude Code, then add them)`);

      // 5. share
      begin("share");
      try {
        await this.host.team.share(rt, team.id);
        end("done", `${inv.repo} on ${team.name}`);
      } catch (err) {
        rt.setTeam({ teamId: team.id, repo: inv.repo });
        end("done", `${inv.repo} on ${team.name} (${(err as Error).message})`);
      }

      // 6. crews
      begin("crews");
      const made: string[] = [];
      for (const c of inv.crews ?? []) {
        if (rt.crews.list().some((x) => x.name === c.name)) continue;
        const teammates = fillCrew(c.teammates, rt.crews.roster());
        if (!teammates) continue;
        try {
          made.push(rt.crews.create({ name: c.name, teammates, ...(c.planApproval === false ? { planApproval: false } : {}) }).name);
        } catch (err) {
          logbook.warn("onboard", `couldn't set up crew ${c.name}`, String(err));
        }
      }
      job.crews = made;
      end(made.length ? "done" : "skipped", made.length ? made.join(", ") : inv.crews?.length ? "no agents here to fill them yet" : "none to set up");
      this.finish(job);
    } catch (err) {
      if (step) {
        step.state = "failed";
        step.detail = (err as Error).message;
      }
      job.error = (err as Error).message;
      job.state = "failed";
      job.finishedAt = Date.now();
      this.emit(job);
    }
  }

  private finish(job: OnboardJob): void {
    job.state = "done";
    job.finishedAt = Date.now();
    this.emit(job);
  }

  private emit(job: OnboardJob): void {
    this.host.broadcast?.({ type: "onboard", job });
  }

  /** A clone of the repo: one Loom already has, the directory you're in, or a fresh one. */
  private async repoDir(job: OnboardJob, inv: InviteFragment, opts: { dir?: string; into?: string }): Promise<string> {
    const repo = inv.repo!;
    const step = job.steps.find((s) => s.id === "repo")!;
    const done = (detail: string, dir: string) => {
      step.state = "done";
      step.detail = detail;
      this.emit(job);
      return dir;
    };
    for (const p of this.host.projects()) {
      if ((await this.repoAt(p.dir)) === repo) return done(`using ${p.dir}`, p.dir);
    }
    if (opts.dir && (await this.repoAt(opts.dir)) === repo) return done(`using ${opts.dir}`, opts.dir);
    const home = this.host.projectsHome ?? path.join(os.homedir(), "loom-projects");
    let target = opts.into ? path.resolve(opts.into) : path.join(home, repo.split("/")[1]!);
    if (fs.existsSync(target)) {
      if ((await this.repoAt(target)) === repo) return done(`using ${target}`, target);
      if (fs.readdirSync(target).length) {
        let n = 2;
        while (fs.existsSync(`${target}-${n}`)) n++;
        target = `${target}-${n}`;
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    step.detail = `cloning ${repo}`;
    this.emit(job);
    const waitMs = this.host.accessWaitMs ?? 10 * 60_000;
    const pollMs = this.host.accessPollMs ?? 8_000;
    const until = Date.now() + waitMs;
    let lastErr = "";
    for (;;) {
      try {
        await this.clone(repo, target);
        this.repoCache.set(target, repo);
        return done(`cloned into ${target}`, target);
      } catch (err) {
        lastErr = (err as Error).message;
        fs.rmSync(target, { recursive: true, force: true });
      }
      // A private repo: the inviter's Loom adds you when you join, and GitHub
      // asks you to accept. Accept it here, and keep trying while it lands.
      if (await this.acceptInvitation(repo)) continue;
      if (Date.now() >= until || !/not found|could not read|authentication|permission|denied|403|404|access/i.test(lastErr)) break;
      step.state = "waiting";
      step.detail = `waiting for ${inv.from ? `@${inv.from}` : "the inviter"} to give you access to ${repo} — their Loom does it when it's online`;
      this.emit(job);
      await sleep(pollMs);
    }
    throw new Error(`couldn't clone ${repo}: ${lastErr.split("\n")[0]}${inv.from ? ` — ask @${inv.from} to add you to the repo` : ""}`);
  }

  private async clone(repo: string, dir: string): Promise<void> {
    if (this.host.clone) return this.host.clone(repo, dir);
    // gh knows your credentials for private repos; plain git for public ones without gh
    try {
      await run("gh", ["repo", "clone", repo, dir, "--", "-q"]);
    } catch (err) {
      if (!/not found|ENOENT|auth login|not logged/i.test((err as Error).message)) throw err;
      await run("git", ["clone", "-q", `https://github.com/${repo}.git`, dir]);
    }
  }

  /** Accept a pending GitHub invitation to `repo`, if there is one. */
  private async acceptInvitation(repo: string): Promise<boolean> {
    const gh = this.host.gh ?? ((args: string[]) => run("gh", args, undefined, 20_000));
    try {
      const list = JSON.parse(await gh(["api", "user/repository_invitations"])) as Array<{ id: number; repository?: { full_name?: string } }>;
      const inv = list.find((i) => i.repository?.full_name?.toLowerCase() === repo);
      if (!inv) return false;
      await gh(["api", "-X", "PATCH", `user/repository_invitations/${inv.id}`]);
      logbook.info("onboard", `accepted GitHub's invitation to ${repo}`);
      return true;
    } catch {
      return false;
    }
  }

  private async repoAt(dir: string): Promise<string | null> {
    if (this.repoCache.has(dir)) return this.repoCache.get(dir)!;
    const r = fs.existsSync(dir) ? await repoOf(dir).catch(() => null) : null;
    this.repoCache.set(dir, r);
    return r;
  }
}

/**
 * The inviter's crew, with the joiner's agents: each teammate gets an agent of
 * the kind it had there, else whatever does the job here. Null when there's
 * nobody to put on it.
 */
export function fillCrew(blueprint: Array<{ id: string; role: string; kind?: string; charter?: string }>, roster: AgentConfig[]): CrewTeammate[] | null {
  if (!roster.length) return null;
  const out: CrewTeammate[] = [];
  for (const b of blueprint.slice(0, 8)) {
    const role = (CREW_ROLES as string[]).includes(b.role) ? (b.role as CrewRole) : "builder";
    const agent = roster.find((a) => a.kind === b.kind) ?? roster[out.length % roster.length]!;
    out.push({ id: b.id, agent: agent.id, role, ...(b.charter ? { charter: b.charter.slice(0, 600) } : {}) });
  }
  return out.length ? out : null;
}

/** The project's crews as a blueprint any machine can fill: roles and kinds, not this machine's agent ids. */
export function crewBlueprints(rt: ProjectRuntime): NonNullable<InviteFragment["crews"]> {
  const roster = rt.config.agents;
  return rt.crews.list().map((c) => ({
    name: c.name,
    ...(c.planApproval === false ? { planApproval: false } : {}),
    teammates: c.teammates.map((t) => ({
      id: t.id,
      role: t.role,
      ...(roster.find((a) => a.id === t.agent)?.kind ? { kind: roster.find((a) => a.id === t.agent)!.kind } : {}),
      ...(t.charter ? { charter: t.charter.slice(0, 300) } : {}),
    })),
  }));
}

/**
 * Invite a teammate to this project. Makes sure there's a team sharing its
 * repo (creating one named after the project if you have none), then mints a
 * one-time link. `grant` (default: when `gh` can) gives them push access when
 * they join.
 */
export async function inviteTeammate(
  team: TeamLink,
  rt: ProjectRuntime,
  opts: { teamId?: string; grant?: boolean; gh?: (args: string[]) => Promise<string> } = {},
): Promise<{ link: string; expiresAt: number; team: { id: string; name: string }; repo: string; grant: boolean; grantNote?: string; message: string }> {
  // the repo first: signing in can't help a project that isn't on GitHub
  const repo = await repoOf(rt.info.dir);
  if (!repo) throw new Error("this project has no GitHub `origin` remote — push it to GitHub first, then invite");
  if (!team.github()) {
    const err = new Error("sign in to a team hub first — Loom uses your GitHub account") as Error & { code?: string };
    err.code = "signin";
    throw err;
  }
  const teams = team.teams();
  let target =
    (opts.teamId && teams.find((t) => t.id === opts.teamId)) ||
    (rt.config.team?.teamId && teams.find((t) => t.id === rt.config.team!.teamId)) ||
    teams.find((t) => t.repos.includes(repo)) ||
    (teams.length === 1 ? teams[0] : undefined);
  if (!target) {
    if (teams.length > 1) throw new Error("you're in several teams — say which one this project's invite is for");
    const made = await team.createTeam(rt.info.name);
    target = { ...made, repos: [] };
  }
  if (!target.repos.includes(repo) || rt.config.team?.teamId !== target.id) await team.share(rt, target.id);
  const gh = opts.gh ?? ((args: string[]) => run("gh", args, undefined, 20_000));
  let grant = opts.grant ?? true;
  let grantNote: string | undefined;
  if (grant) {
    const canAdmin = await gh(["api", `repos/${repo}`, "-q", ".permissions.admin"]).then((s) => s.trim() === "true").catch(() => false);
    if (!canAdmin) {
      grant = false;
      grantNote = `you can't add collaborators to ${repo} from here (needs \`gh\` signed in as an admin) — add them on GitHub`;
    }
  }
  const out = await team.invite(target.id, { repo, project: rt.info.name, crews: crewBlueprints(rt), grant });
  const until = new Date(out.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const message = [
    `Join me on ${target.name} in Loom — we're working on ${repo}${team.github() ? ` (from @${team.github()})` : ""}.`,
    out.link,
    `One click sets up the repo, your agents and the team. Works once, until ${until}. It carries the team key — don't post it publicly.`,
  ].join("\n");
  return { link: out.link, expiresAt: out.expiresAt, team: { id: target.id, name: target.name }, repo, grant, ...(grantNote ? { grantNote } : {}), message };
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}
