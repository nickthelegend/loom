/**
 * Team Link — a member's daemon on a Loom Team Hub (docs/teams-architecture.md).
 *
 * Phase 1, "see each other". What it does, and the decision each part serves:
 *   - signs in (D4: a GitHub login), holds this device's keys, and the team
 *     keys it has been given (D5 via invite links, D6 via sealed envelopes)
 *   - shares projects opt-in, or by git remote matching a team repo (D8)
 *   - heartbeats every live session in shared projects: agent, state, branch,
 *     file globs in the clear; goal/task titles sealed (D2, D24 — intent, never
 *     prompts or transcripts)
 *   - publishes goal lifecycle to the team feed, and PR/check activity by
 *     polling `gh` when the team has no GitHub App (D7)
 *   - keeps a decrypted live view (members, presence, feed) for the UI
 *
 * State lives in ~/.loom/team.json (0600): hub session, device keys, team keys.
 * The hub never holds a readable team key.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loomHome } from "../core/registry.js";
import { logbook } from "../core/logbook.js";
import {
  newDeviceKeys,
  newTeamKey,
  openFromTeam,
  openTeamKey,
  packInvite,
  sealForTeam,
  sealTeamKey,
  signPayload,
  unpackInvite,
  type DeviceKeys,
  type TeamKey,
} from "../core/team-crypto.js";
import {
  LEASE_TTL_MS,
  normalizeRepo,
  type FeedEvent,
  type FeedIn,
  type HubClient,
  type HubEvent,
  type Lease,
  type MemberView,
  type Presence,
  type PresenceIn,
  type TeamRole,
} from "../core/team-hub.js";
import { HttpHubClient, hubSignIn } from "../hub/client.js";
import type { LoomEvent } from "../types.js";
import type { ProjectRuntime } from "./runtime.js";
import { TeamCoordinator } from "./team-coordinator.js";

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

interface TeamState {
  hub?: { url: string; token: string; github: string; userId: string };
  device?: DeviceKeys & { id?: string };
  teams: Record<string, { name: string; role: TeamRole; keys: TeamKey[] }>;
}

function defaultStateFile(): string {
  return path.join(loomHome(), "team.json");
}

function readState(file: string): TeamState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as TeamState;
    return { ...s, teams: s.teams ?? {} };
  } catch {
    return { teams: {} };
  }
}

function writeState(f: string, s: TeamState): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(f + ".tmp", f);
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

/**
 * The project's GitHub repo ("owner/name"): `git config loom.repo` when set (a
 * mirror, or a remote that isn't github.com), else its origin remote.
 */
export async function repoOf(dir: string): Promise<string | null> {
  const pinned = (await run("git", ["config", "--get", "loom.repo"], dir).catch(() => "")).trim();
  if (pinned) {
    try {
      return normalizeRepo(pinned);
    } catch {
      /* fall through to origin */
    }
  }
  try {
    return normalizeRepo((await run("git", ["remote", "get-url", "origin"], dir)).trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Team Link
// ---------------------------------------------------------------------------

export interface TeamLinkHost {
  /** Open project runtimes (only these can be shared/heartbeated). */
  runtimes(): ProjectRuntime[];
  /** Fan a team frame out to connected UIs. */
  broadcast(frame: Record<string, unknown>): void;
  /** Tests inject a hub; production builds an HttpHubClient from state. */
  hubFactory?: (url: string, token: string) => HubClient;
  /** Where team.json lives; defaults to ~/.loom/team.json. Tests run two members in one process. */
  statePath?: string;
}

interface TeamView {
  members: MemberView[];
  repos: string[];
  presence: Map<string, Presence>;
  feed: FeedEvent[];
  leases: Map<string, Lease>;
}

const HEARTBEAT_MS = 15_000;
const GH_POLL_MS = 60_000;

export class TeamLink {
  private file: string;
  private state: TeamState;
  private hubClient: HubClient | null = null;
  private views = new Map<string, TeamView>();
  private unsubs = new Map<string, () => void>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private live = new Map<string, Set<string>>(); // teamId → presence keys this device reported last beat
  private logSubs = new Map<string, () => void>(); // projectId → log unsubscribe
  private coordinators = new Map<string, TeamCoordinator>(); // projectId → coordinator (Phase 2)
  private started = false;

  constructor(private host: TeamLinkHost) {
    this.file = host.statePath ?? defaultStateFile();
    this.state = readState(this.file);
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.state.hub) await this.connect().catch((e) => logbook.warn("team", "couldn't reach the team hub", String(e)));
    this.timers.push(setInterval(() => void this.beat().catch(() => {}), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.pollGitHub().catch(() => {}), GH_POLL_MS));
    for (const t of this.timers) t.unref?.();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const u of this.unsubs.values()) u();
    this.unsubs.clear();
    for (const u of this.logSubs.values()) u();
    this.logSubs.clear();
    for (const c of this.coordinators.values()) c.stop();
    // Say goodbye rather than let teammates wait out the TTL.
    await this.clearAllPresence().catch(() => {});
    this.started = false;
  }

  private hub(): HubClient {
    if (!this.hubClient) throw new Error("not signed in to a team hub — `loom team signin <hub-url>`");
    return this.hubClient;
  }

  private makeClient(url: string, token: string): HubClient {
    return this.host.hubFactory ? this.host.hubFactory(url, token) : new HttpHubClient(url, token);
  }

  /** Sign in to a hub as a GitHub login (defaults to the local `gh` user). */
  async signIn(url: string, opts: { github?: string; secret?: string; token?: string } = {}): Promise<void> {
    const github = opts.github || (await run("gh", ["api", "user", "-q", ".login"]).then((s) => s.trim()).catch(() => ""));
    if (!github) throw new Error("which GitHub account? pass --github <login> (or sign in to gh)");
    let token = opts.token;
    let userId = "";
    if (!token) {
      const out = await hubSignIn(url, github, { ...(opts.secret ? { secret: opts.secret } : {}) });
      token = out.token;
      userId = out.user.id;
    }
    const client = this.makeClient(url, token);
    if (!userId) userId = (await client.me()).id;
    this.state = { ...this.state, hub: { url: url.replace(/\/$/, ""), token, github: github.toLowerCase(), userId } };
    writeState(this.file, this.state);
    this.hubClient = client;
    for (const rt of this.host.runtimes()) rt.memberLogin = this.state.hub!.github;
    await this.ensureDevice();
  }

  private async ensureDevice(): Promise<DeviceKeys & { id: string }> {
    const keys = this.state.device ?? newDeviceKeys();
    const d = await this.hub().registerDevice({ label: os.hostname().slice(0, 60), sealPub: keys.sealPub, signPub: keys.signPub });
    this.state.device = { ...keys, id: d.id };
    writeState(this.file, this.state);
    return this.state.device as DeviceKeys & { id: string };
  }

  private device(): DeviceKeys & { id: string } {
    const d = this.state.device;
    if (!d?.id) throw new Error("this device isn't registered with the hub yet");
    return d as DeviceKeys & { id: string };
  }

  /** (Re)attach to the hub: every team we know, live subscriptions, and shared projects. */
  async connect(): Promise<void> {
    const h = this.state.hub;
    if (!h) return;
    this.hubClient = this.makeClient(h.url, h.token);
    await this.ensureDevice();
    const teams = await this.hub().teams();
    // Forget teams we were removed from; learn roles and any new key versions.
    for (const id of Object.keys(this.state.teams)) {
      if (!teams.some((t) => t.id === id)) delete this.state.teams[id];
    }
    for (const t of teams) {
      const known = this.state.teams[t.id] ?? { name: t.name, role: t.role, keys: [] };
      this.state.teams[t.id] = { ...known, name: t.name, role: t.role };
      await this.pullKeys(t.id);
      await this.attach(t.id);
    }
    writeState(this.file, this.state);
    this.watchRuntimes();
  }

  /** Open any key envelopes sealed to this device we don't have yet (D6). */
  private async pullKeys(teamId: string): Promise<void> {
    const envs = await this.hub().keyEnvelopes(teamId, this.device().id);
    const team = this.state.teams[teamId]!;
    for (const e of envs) {
      if (team.keys.some((k) => k.version === e.version)) continue;
      const key = openTeamKey(this.device(), e.box);
      if (key) team.keys.push(key);
    }
    team.keys.sort((a, b) => a.version - b.version);
  }

  private currentKey(teamId: string): TeamKey {
    const keys = this.state.teams[teamId]?.keys ?? [];
    const k = keys[keys.length - 1];
    if (!k) throw new Error("no team key on this device — join through an invite link");
    return k;
  }

  private async attach(teamId: string): Promise<void> {
    if (this.unsubs.has(teamId)) return;
    const [members, repos, presence, feed, leases] = await Promise.all([
      this.hub().members(teamId),
      this.hub().repos(teamId),
      this.hub().presence(teamId),
      this.hub().feed(teamId, { limit: 200 }),
      this.hub().leases(teamId).catch(() => [] as Lease[]),
    ]);
    this.views.set(teamId, {
      members,
      repos,
      presence: new Map(presence.map((p) => [presenceKey(p), p])),
      feed,
      leases: new Map(leases.map((l) => [l.id, l])),
    });
    const unsub = await this.hub().subscribe(teamId, (e) => void this.onHubEvent(e));
    this.unsubs.set(teamId, unsub);
  }

  private async onHubEvent(e: HubEvent): Promise<void> {
    const v = this.views.get(e.teamId);
    if (!v) return;
    if (e.type === "lease") v.leases.set(e.lease.id, e.lease);
    else if (e.type === "lease_gone") for (const id of e.leaseIds) v.leases.delete(id);
    else if (e.type === "presence") v.presence.set(presenceKey(e.presence), e.presence);
    else if (e.type === "presence_gone") {
      for (const [k, p] of v.presence) {
        if (p.userId === e.userId && p.deviceId === e.deviceId && p.agent === e.agent && p.repo === e.repo) v.presence.delete(k);
      }
    } else if (e.type === "feed") {
      v.feed.push(e.event);
      for (const c of this.coordinators.values()) {
        try {
          c.onTeamEvent(e.event);
        } catch {
          /* one project's coordinator never breaks the feed */
        }
      }
      if (v.feed.length > 500) v.feed.splice(0, v.feed.length - 500);
      const t = e.event.type;
      if (t === "key_rotated") await this.pullKeys(e.teamId).then(() => writeState(this.file, this.state)).catch(() => {});
      if (t === "member_joined" || t === "member_left" || t === "key_rotated") v.members = await this.hub().members(e.teamId).catch(() => v.members);
      if (t === "repo_shared") v.repos = await this.hub().repos(e.teamId).catch(() => v.repos);
      if (t === "member_left" && e.event.meta.github === this.state.hub?.github) {
        // We were removed: drop the team and its keys.
        this.unsubs.get(e.teamId)?.();
        this.unsubs.delete(e.teamId);
        this.views.delete(e.teamId);
        delete this.state.teams[e.teamId];
        writeState(this.file, this.state);
      }
    }
    this.host.broadcast({ type: "team", teamId: e.teamId, event: this.decryptEvent(e) });
  }

  // ── teams, invites, membership ──

  async createTeam(name: string): Promise<{ id: string; name: string }> {
    const team = await this.hub().createTeam(name);
    const key = newTeamKey(1);
    await this.hub().putKeyEnvelopes(team.id, 1, [{ deviceId: this.device().id, box: sealTeamKey(this.device().sealPub, key) }]);
    this.state.teams[team.id] = { name: team.name, role: "owner", keys: [key] };
    writeState(this.file, this.state);
    await this.attach(team.id);
    return { id: team.id, name: team.name };
  }

  /** An invite link: the token and the current team key ride the #fragment (D5). */
  async invite(teamId = this.defaultTeam()): Promise<{ link: string; expiresAt: number }> {
    const { invite, expiresAt } = await this.hub().createInvite(teamId);
    const frag = packInvite({ invite, key: this.currentKey(teamId), hub: this.state.hub!.url });
    return { link: `loom://team/join#${frag}`, expiresAt };
  }

  async join(link: string, opts: { github?: string; secret?: string } = {}): Promise<{ id: string; name: string }> {
    const frag = link.includes("#") ? link.slice(link.indexOf("#") + 1) : link;
    const inv = unpackInvite(frag);
    if (!inv) throw new Error("that isn't a Loom team invite link");
    if (!this.state.hub || this.state.hub.url !== inv.hub.replace(/\/$/, "")) await this.signIn(inv.hub, opts);
    const { team, role } = await this.hub().redeemInvite(inv.invite);
    // Seal the key we were handed to our own device, so it survives a reinstall
    // of team.json from the hub, and so rotation has a device to seal to.
    await this.hub().putKeyEnvelopes(team.id, inv.key.version, [
      { deviceId: this.device().id, box: sealTeamKey(this.device().sealPub, inv.key) },
    ]);
    this.state.teams[team.id] = { name: team.name, role, keys: [inv.key] };
    writeState(this.file, this.state);
    await this.attach(team.id);
    this.watchRuntimes();
    return { id: team.id, name: team.name };
  }

  /**
   * Remove a member, then rotate the key forward (D6): a new key, sealed to
   * every remaining device. The removed member keeps what they already saw —
   * nothing new is readable to them.
   */
  async removeMember(userId: string, teamId = this.defaultTeam()): Promise<{ keyVersion: number }> {
    await this.hub().removeMember(teamId, userId);
    return this.rotate(teamId);
  }

  async rotate(teamId = this.defaultTeam()): Promise<{ keyVersion: number }> {
    const members = await this.hub().members(teamId);
    const next = newTeamKey(this.currentKey(teamId).version + 1);
    const envelopes = members.flatMap((m) => m.devices.map((d) => ({ deviceId: d.id, box: sealTeamKey(d.sealPub, next) })));
    await this.hub().putKeyEnvelopes(teamId, next.version, envelopes);
    this.state.teams[teamId]!.keys.push(next);
    writeState(this.file, this.state);
    return { keyVersion: next.version };
  }

  async leave(teamId = this.defaultTeam()): Promise<void> {
    await this.hub().removeMember(teamId, this.state.hub!.userId);
    this.unsubs.get(teamId)?.();
    this.unsubs.delete(teamId);
    this.views.delete(teamId);
    delete this.state.teams[teamId];
    writeState(this.file, this.state);
  }

  private defaultTeam(): string {
    const ids = Object.keys(this.state.teams);
    if (ids.length === 1) return ids[0]!;
    if (!ids.length) throw new Error("you aren't in a team yet — create one or join with an invite link");
    throw new Error("you're in several teams — say which one");
  }

  // ── projects ──

  /** Share a project's repo with a team (D8: explicit opt-in). */
  async share(rt: ProjectRuntime, teamId = this.defaultTeam()): Promise<{ repo: string; teamId: string }> {
    const repo = await repoOf(rt.info.dir);
    if (!repo) throw new Error("this project has no GitHub `origin` remote — teams work per GitHub repo");
    await this.hub().shareRepo(teamId, repo);
    rt.setTeam({ teamId, repo });
    this.watchRuntimes();
    return { repo, teamId };
  }

  unshare(rt: ProjectRuntime): void {
    rt.setTeam(null);
  }

  /** Which team a project publishes to: its explicit share, else a team whose repo matches its remote (D8). */
  private async teamFor(rt: ProjectRuntime): Promise<{ teamId: string; repo: string } | null> {
    const explicit = rt.config.team;
    if (explicit === null || explicit?.optOut) return null;
    if (explicit?.teamId && explicit.repo && this.state.teams[explicit.teamId]) {
      return { teamId: explicit.teamId, repo: explicit.repo };
    }
    const repo = await repoOf(rt.info.dir);
    if (!repo) return null;
    for (const [teamId, v] of this.views) if (v.repos.includes(repo)) return { teamId, repo };
    return null;
  }

  // ── presence ──

  /** One heartbeat for every live session in every shared project. */
  async beat(): Promise<number> {
    if (!this.hubClient || !this.state.device?.id) return 0;
    const seen = new Map<string, Set<string>>();
    let count = 0;
    for (const rt of this.host.runtimes()) {
      const share = await this.teamFor(rt);
      if (!share) continue;
      let key: TeamKey;
      try {
        key = this.currentKey(share.teamId);
      } catch {
        continue;
      }
      for (const p of sessionsOf(rt, share.repo)) {
        const sealed = sealForTeam(key, p.intent);
        const beat: PresenceIn = { ...p.presence, deviceId: this.device().id, sealed };
        beat.sig = signPayload(this.device(), { ...beat, sig: undefined });
        await this.hub().heartbeat(share.teamId, beat).catch((e) => logbook.warn("team", "heartbeat refused", String(e)));
        const set = seen.get(share.teamId) ?? new Set();
        set.add(`${beat.repo}/${beat.agent}`);
        seen.set(share.teamId, set);
        count++;
      }
    }
    // Sessions that ended since the last beat: say so now.
    for (const [teamId, prev] of this.live) {
      const now = seen.get(teamId) ?? new Set();
      for (const k of prev) {
        if (now.has(k)) continue;
        const [owner, name, ...agentParts] = k.split("/");
        await this.hub()
          .clearPresence(teamId, { deviceId: this.device().id, repo: `${owner}/${name}`, agent: agentParts.join("/") })
          .catch(() => {});
      }
    }
    this.live = seen;
    // Leases live as long as this device keeps saying so (D12).
    for (const teamId of Object.keys(this.state.teams)) {
      await this.hub().renewLeases(teamId, this.device().id).catch(() => 0);
    }
    return count;
  }

  private async clearAllPresence(): Promise<void> {
    if (!this.hubClient || !this.state.device?.id) return;
    for (const [teamId, keys] of this.live) {
      for (const k of keys) {
        const [owner, name, ...agentParts] = k.split("/");
        await this.hub().clearPresence(teamId, { deviceId: this.device().id, repo: `${owner}/${name}`, agent: agentParts.join("/") });
      }
    }
    this.live.clear();
  }

  // ── feed: goal lifecycle from each shared project's log ──

  private watchRuntimes(): void {
    for (const rt of this.host.runtimes()) {
      if (this.logSubs.has(rt.info.id)) continue;
      const unsub = rt.log.onEvent((e) => void this.onProjectEvent(rt, e).catch(() => {}));
      this.logSubs.set(rt.info.id, unsub);
    }
  }

  /** Called by the daemon when it opens a runtime. */
  attachRuntime(rt: ProjectRuntime): void {
    rt.memberLogin = this.state.hub?.github ?? null;
    this.coordinatorFor(rt);
    if (this.state.hub) this.watchRuntimes();
  }

  /** Phase 2: the project's team coordinator, created once and handed to its orchestra. */
  coordinatorFor(rt: ProjectRuntime): TeamCoordinator {
    let c = this.coordinators.get(rt.info.id);
    if (!c) {
      c = new TeamCoordinator(rt, {
        hub: () => this.hubClient,
        deviceId: () => this.state.device?.id ?? null,
        github: () => this.state.hub?.github ?? null,
        share: (r) => (this.hubClient ? this.teamFor(r) : Promise.resolve(null)),
        keys: (teamId) => this.state.teams[teamId]?.keys ?? [],
        feed: (teamId) => this.views.get(teamId)?.feed ?? [],
        presence: (teamId) => [...(this.views.get(teamId)?.presence.values() ?? [])],
      });
      this.coordinators.set(rt.info.id, c);
      rt.coordinator = c;
    }
    return c;
  }

  private async onProjectEvent(rt: ProjectRuntime, e: LoomEvent): Promise<void> {
    if (e.kind !== "orchestra" || !this.hubClient) return;
    const p = e.payload as Record<string, unknown>;
    const phase = String(p.phase ?? "");
    // D36: work that reached the base branch without a PR has landed too.
    if ((phase === "delivered" && (p.mode === "commit" || p.mode === "push")) || phase === "applied") {
      void this.coordinators.get(rt.info.id)?.release(String(p.runId), phase === "applied" ? "applied locally" : `delivered (${String(p.mode)})`);
    }
    const map: Record<string, FeedIn["type"]> = {
      started: "goal_started",
      completed: "goal_finished",
      failed: "goal_finished",
      aborted: "goal_finished",
      plan_written: "plan_written",
      delivered: "pr_opened",
    };
    const type = map[phase];
    if (!type || (phase === "delivered" && !p.prUrl)) return;
    if (phase === "plan_written" && p.final) return;
    const share = await this.teamFor(rt);
    if (!share) return;
    const run = rt.orchestra.get(String(p.runId));
    const meta: Record<string, unknown> = {
      runId: p.runId,
      status: p.status,
      ...(run ? { orchestrator: run.orchestrator.agent, workers: run.workers, tasks: run.tasks.length, branch: run.branch } : {}),
      ...(p.prUrl ? { prUrl: p.prUrl } : {}),
      ...(phase === "plan_written" ? { dir: p.dir } : {}),
    };
    const sealed = sealForTeam(this.currentKey(share.teamId), {
      goal: run?.goal.split("\n")[0]!.slice(0, 200) ?? "",
      ...(run?.summary ? { summary: run.summary.slice(0, 500) } : {}),
    });
    const fe: FeedIn = { repo: share.repo, type, meta, sealed, deviceId: this.device().id, dedupeKey: `${e.id}@${rt.info.id}` };
    fe.sig = signPayload(this.device(), { ...fe, sig: undefined });
    await this.hub().appendFeed(share.teamId, fe);
  }

  // ── GitHub, without an App (D7 fallback) ──

  async pollGitHub(): Promise<number> {
    if (!this.hubClient) return 0;
    let added = 0;
    const polled = new Set<string>();
    for (const rt of this.host.runtimes()) {
      const share = await this.teamFor(rt);
      if (!share || polled.has(share.repo)) continue;
      polled.add(share.repo);
      let prs: Array<Record<string, unknown>>;
      try {
        prs = JSON.parse(
          await run("gh", [
            "pr", "list", "--repo", share.repo, "--state", "all", "--limit", "20",
            "--json", "number,title,state,headRefName,author,url,mergedAt,statusCheckRollup",
          ]),
        ) as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
      for (const pr of prs) {
        for (const fe of githubFeedEvents(share.repo, pr)) {
          fe.sealed = sealForTeam(this.currentKey(share.teamId), { title: String(pr.title ?? "").slice(0, 200) });
          if (await this.hub().appendFeed(share.teamId, fe).catch(() => null)) added++;
        }
      }
    }
    return added;
  }

  // ── the view the UI reads ──

  status(): Record<string, unknown> {
    const h = this.state.hub;
    return {
      signedIn: Boolean(h),
      hub: h?.url ?? null,
      github: h?.github ?? null,
      device: this.state.device?.id ?? null,
      teams: Object.entries(this.state.teams).map(([id, t]) => {
        const v = this.views.get(id);
        const keys = t.keys;
        return {
          id,
          name: t.name,
          role: t.role,
          keyVersion: keys[keys.length - 1]?.version ?? null,
          members: v?.members.map((m) => ({ id: m.user.id, github: m.user.github, name: m.user.name, role: m.role, devices: m.devices.length })) ?? [],
          repos: v?.repos ?? [],
          presence: v ? [...v.presence.values()].filter((p) => Date.now() - p.ts < 45_000).map((p) => this.decryptPresence(id, p)) : [],
          feed: v ? v.feed.slice(-100).map((e) => this.decryptFeed(id, e)) : [],
          leases: v ? [...v.leases.values()].map((l) => this.decryptLease(id, l)) : [],
        };
      }),
    };
  }

  private decryptPresence(teamId: string, p: Presence): Record<string, unknown> {
    const { sealed, sig: _sig, ...rest } = p;
    return { ...rest, intent: openFromTeam(this.state.teams[teamId]?.keys ?? [], sealed) ?? null, mine: p.userId === this.state.hub?.userId };
  }

  /** A lease for the UI: who, which goal/task (decrypted), what it covers, and its state. */
  private decryptLease(teamId: string, l: Lease): Record<string, unknown> {
    const { sealed, files, ...rest } = l;
    return {
      ...rest,
      fileCount: files.length,
      files: files.slice(0, 20),
      // computed on every read: a flag frozen when the lease last changed would
      // show a sleeping teammate as active until something else happened (D12)
      stale: Date.now() - l.ts > LEASE_TTL_MS,
      intent: openFromTeam(this.state.teams[teamId]?.keys ?? [], sealed) ?? null,
      mine: l.userId === this.state.hub?.userId,
    };
  }

  private decryptFeed(teamId: string, e: FeedEvent): Record<string, unknown> {
    const { sealed, sig: _sig, ...rest } = e;
    return { ...rest, content: openFromTeam(this.state.teams[teamId]?.keys ?? [], sealed) ?? null };
  }

  private decryptEvent(e: HubEvent): Record<string, unknown> {
    if (e.type === "lease") return { type: e.type, lease: this.decryptLease(e.teamId, e.lease) };
    if (e.type === "presence") return { type: e.type, presence: this.decryptPresence(e.teamId, e.presence) };
    if (e.type === "feed") return { type: e.type, event: this.decryptFeed(e.teamId, e.event) };
    return { ...e };
  }
}

function presenceKey(p: { userId: string; deviceId: string; repo: string; agent: string }): string {
  return `${p.userId}/${p.deviceId}/${p.repo}/${p.agent}`;
}

/**
 * The live sessions in one project, as presence: busy roster agents and every
 * orchestra task that is running or queued. Titles go in `intent` (sealed);
 * everything in `presence` is plain metadata (D2, D24).
 */
export function sessionsOf(
  rt: ProjectRuntime,
  repo: string,
): Array<{ presence: Omit<PresenceIn, "deviceId">; intent: Record<string, unknown> }> {
  const out: Array<{ presence: Omit<PresenceIn, "deviceId">; intent: Record<string, unknown> }> = [];
  const act = rt.activity() as {
    agents: Array<{ id: string; kind: string; busy: boolean; since: number | null; chatTitle: string | null }>;
    orchestra: null | {
      id: string;
      goal: string;
      status: string;
      orchestrator: string;
      tasks: Array<{ id: string; title: string; agent: string; status: string }>;
    };
  };
  const run = act.orchestra;
  const runLive = run && !["completed", "failed", "aborted"].includes(run.status);
  const full = runLive ? rt.orchestra.get(run!.id) : undefined;
  if (runLive && full) {
    const orchState = run!.status === "reviewing" ? "reviewing" : run!.status === "waiting_human" ? "waiting_human" : run!.status === "planning" ? "planning" : "running";
    out.push({
      presence: {
        repo, runId: run!.id, agent: `${run!.orchestrator}#orch`, kind: full.orchestrator.kind, branch: full.branch,
        touches: [], state: orchState, since: full.createdAt,
      },
      intent: { goal: full.goal.split("\n")[0]!.slice(0, 200), role: "orchestrator" },
    });
    for (const t of full.tasks) {
      if (t.status !== "running" && t.status !== "pending") continue;
      out.push({
        presence: {
          repo, runId: full.id, taskId: t.id, agent: `${t.agent}#${t.id}`, kind: t.kind,
          ...(t.branch ? { branch: t.branch } : {}),
          touches: t.touches?.length ? t.touches : (t.files ?? []),
          state: t.status === "running" ? "running" : "planning",
          since: t.startedAt ?? full.createdAt,
        },
        intent: { goal: full.goal.split("\n")[0]!.slice(0, 200), task: t.title.slice(0, 200) },
      });
    }
  }
  for (const a of act.agents) {
    if (!a.busy) continue;
    out.push({
      presence: { repo, agent: a.id, kind: a.kind, touches: [], state: "running", since: a.since ?? Date.now() },
      // The thread's title, never its messages (D24).
      intent: { thread: a.chatTitle ?? "" },
    });
  }
  return out;
}

/** PR and check facts from one `gh pr list` row, as idempotent feed events. */
export function githubFeedEvents(repo: string, pr: Record<string, unknown>): FeedIn[] {
  const n = Number(pr.number);
  const state = String(pr.state ?? "").toUpperCase();
  const author = (pr.author as { login?: string } | undefined)?.login ?? null;
  const base = { number: n, url: pr.url, branch: pr.headRefName, author, loom: String(pr.headRefName ?? "").startsWith("loom/") };
  const out: FeedIn[] = [{ repo, type: "pr_opened", meta: base, dedupeKey: `gh:${repo}#${n}:opened` }];
  if (state === "MERGED") out.push({ repo, type: "pr_merged", meta: base, dedupeKey: `gh:${repo}#${n}:merged` });
  if (state === "CLOSED") out.push({ repo, type: "pr_closed", meta: base, dedupeKey: `gh:${repo}#${n}:closed` });
  const checks = Array.isArray(pr.statusCheckRollup) ? (pr.statusCheckRollup as Array<Record<string, unknown>>) : [];
  const failed = checks.filter((c) => /FAIL|ERROR|TIMED_OUT|CANCELLED/i.test(String(c.conclusion ?? c.state ?? "")));
  const done = checks.length > 0 && checks.every((c) => String(c.status ?? "COMPLETED").toUpperCase() === "COMPLETED" || c.state);
  if (failed.length) {
    const names = failed.map((c) => String(c.name ?? c.context ?? "check")).sort();
    out.push({ repo, type: "check_failed", meta: { ...base, checks: names }, dedupeKey: `gh:${repo}#${n}:failed:${names.join(",")}` });
  } else if (done && checks.every((c) => /SUCCESS|NEUTRAL|SKIPPED/i.test(String(c.conclusion ?? c.state ?? "")))) {
    out.push({ repo, type: "check_passed", meta: base, dedupeKey: `gh:${repo}#${n}:passed:${checks.length}` });
  }
  return out;
}
