/**
 * Loom Teams — the hub protocol, and an in-memory hub that is its reference.
 *
 * The Team Hub is the thin coordination plane between members' daemons
 * (docs/teams-architecture.md). Three implementations speak `HubClient`:
 *
 *   - MemoryHub (here): in-process, authoritative for the rules. Tests and the
 *     local hub server both run it, so the rules are written once.
 *   - HttpHubClient (src/hub/client.ts): talks to `loom hub` — a self-hosted
 *     hub with no Supabase (D1), and the way two daemons meet in tests.
 *   - Supabase (supabase/migrations/0002_teams.sql): the hosted hub, the same
 *     rules as row-level security and SQL functions.
 *
 * Phase 1 ("see each other"): teams, members, devices, invites, key envelopes,
 * shared repos, presence heartbeats and a durable feed. What the hub stores is
 * plain metadata plus sealed content it cannot read (D2).
 */

import crypto from "node:crypto";

import type { Sealed } from "./team-crypto.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "member" | "viewer";

export interface HubUser {
  id: string;
  github: string; // D4: every member maps to a GitHub login
  name: string;
}

export interface Team {
  id: string;
  name: string;
  createdAt: number;
  /** Current team-key version; bumped by rotation (D6). */
  keyVersion: number;
}

export interface HubDevice {
  id: string;
  userId: string;
  label: string;
  sealPub: string;
  signPub: string;
  createdAt: number;
}

export interface MemberView {
  user: HubUser;
  role: TeamRole;
  joinedAt: number;
  devices: HubDevice[];
}

/** One live session on one member's machine (D24: intent, not transcripts). */
export interface PresenceIn {
  deviceId: string;
  repo: string; // "owner/name"
  runId?: string;
  taskId?: string;
  agent: string; // roster id
  kind: string; // adapter kind
  branch?: string;
  touches: string[]; // file globs — plain metadata (D2)
  state: "idle" | "planning" | "running" | "reviewing" | "waiting_human" | "ci";
  since: number;
  /** Goal title, task title, intent line — sealed to the team. */
  sealed?: Sealed;
  sig?: string;
}

export interface Presence extends PresenceIn {
  teamId: string;
  userId: string;
  github: string;
  ts: number;
}

export type FeedType =
  | "member_joined"
  | "member_left"
  | "key_rotated"
  | "repo_shared"
  | "goal_started"
  | "goal_finished"
  | "plan_written"
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "check_failed"
  | "check_passed"
  | "review_requested"
  | "review_submitted";

export interface FeedIn {
  repo?: string;
  type: FeedType;
  /** Plain metadata: ids, numbers, states, branch names, paths. */
  meta: Record<string, unknown>;
  /** Titles and free text, sealed to the team. */
  sealed?: Sealed;
  deviceId?: string;
  sig?: string;
  /** Idempotency: the same key twice appends once (GitHub events get polled repeatedly). */
  dedupeKey?: string;
}

export interface FeedEvent extends FeedIn {
  id: number;
  teamId: string;
  userId: string | null; // null = GitHub App / system
  github: string | null;
  ts: number;
}

export type HubEvent =
  | { type: "presence"; teamId: string; presence: Presence }
  | { type: "presence_gone"; teamId: string; userId: string; deviceId: string; agent: string; repo: string }
  | { type: "feed"; teamId: string; event: FeedEvent };

/** Everything a daemon (or phone) can do against a hub, as one signed-in user. */
export interface HubClient {
  me(): Promise<HubUser>;
  createTeam(name: string): Promise<Team>;
  teams(): Promise<Array<Team & { role: TeamRole }>>;
  registerDevice(input: { label: string; sealPub: string; signPub: string }): Promise<HubDevice>;
  createInvite(teamId: string, ttlMs?: number): Promise<{ invite: string; expiresAt: number }>;
  redeemInvite(invite: string): Promise<{ team: Team; role: TeamRole }>;
  members(teamId: string): Promise<MemberView[]>;
  removeMember(teamId: string, userId: string): Promise<void>;
  /** Store a new key version sealed to each device. Owners only; version must be current or next. */
  putKeyEnvelopes(teamId: string, version: number, envelopes: Array<{ deviceId: string; box: string }>): Promise<void>;
  keyEnvelopes(teamId: string, deviceId: string): Promise<Array<{ version: number; box: string }>>;
  shareRepo(teamId: string, repo: string): Promise<void>;
  repos(teamId: string): Promise<string[]>;
  heartbeat(teamId: string, p: PresenceIn): Promise<void>;
  /** Tell teammates a session ended now, rather than waiting for the TTL. */
  clearPresence(teamId: string, key: { deviceId: string; agent: string; repo: string }): Promise<void>;
  presence(teamId: string): Promise<Presence[]>;
  appendFeed(teamId: string, e: FeedIn): Promise<FeedEvent | null>;
  feed(teamId: string, opts?: { since?: number; limit?: number }): Promise<FeedEvent[]>;
  subscribe(teamId: string, cb: (e: HubEvent) => void): Promise<() => void>;
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HubError";
  }
}

// ---------------------------------------------------------------------------
// Rules shared by every hub
// ---------------------------------------------------------------------------

/** A heartbeat older than this is a session that stopped (laptop closed, crash). */
export const PRESENCE_TTL_MS = 45_000;
export const INVITE_TTL_MS = 24 * 60 * 60_000;
export const FREE_SEATS = 3; // D21 — enforced by billing, surfaced by the hub
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeRepo(repo: string): string {
  const r = repo
    .trim()
    .replace(/^(git@github\.com:|https?:\/\/github\.com\/)/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!REPO_RE.test(r)) throw new HubError(`"${repo}" is not a GitHub repo (owner/name)`);
  return r.toLowerCase();
}

// ---------------------------------------------------------------------------
// MemoryHub — the reference implementation
// ---------------------------------------------------------------------------

interface Membership {
  role: TeamRole;
  joinedAt: number;
}

export class MemoryHub {
  private users = new Map<string, HubUser>();
  private tokens = new Map<string, string>(); // session token → user id
  private teamsById = new Map<string, Team>();
  private memberships = new Map<string, Map<string, Membership>>(); // team → user → membership
  private devices = new Map<string, HubDevice>();
  private invites = new Map<string, { teamId: string; createdBy: string; expiresAt: number; usedBy?: string }>();
  private envelopes = new Map<string, Array<{ version: number; box: string }>>(); // `${team}/${device}`
  private reposByTeam = new Map<string, Set<string>>();
  private presenceByTeam = new Map<string, Map<string, Presence>>();
  private feedByTeam = new Map<string, FeedEvent[]>();
  private dedupe = new Set<string>();
  private feedSeq = 0;
  private listeners = new Map<string, Set<(e: HubEvent) => void>>();
  constructor(private now: () => number = Date.now) {}

  /**
   * Dev/self-host sign-in: a claimed GitHub login gets a session token.
   * The hosted hub (Supabase) replaces this with real GitHub OAuth; the local
   * hub server gates it behind its own admin secret.
   */
  signIn(github: string, name?: string): { token: string; user: HubUser } {
    const login = github.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)) throw new HubError(`"${github}" is not a GitHub login`);
    let user = [...this.users.values()].find((u) => u.github === login);
    if (!user) {
      user = { id: id("u"), github: login, name: name?.trim() || login };
      this.users.set(user.id, user);
    }
    const token = crypto.randomBytes(24).toString("hex");
    this.tokens.set(token, user.id);
    return { token, user };
  }

  /** A client bound to one session — the only way to act on the hub. */
  client(token: string): HubClient {
    const userId = this.tokens.get(token);
    if (!userId) throw new HubError("not signed in to this hub", 401);
    return new MemoryHubClient(this, userId);
  }

  // ── internals used by MemoryHubClient ──

  user(id: string): HubUser {
    const u = this.users.get(id);
    if (!u) throw new HubError("no such user", 404);
    return u;
  }

  role(teamId: string, userId: string): TeamRole | null {
    return this.memberships.get(teamId)?.get(userId)?.role ?? null;
  }

  requireRole(teamId: string, userId: string, atLeast: TeamRole): TeamRole {
    const r = this.role(teamId, userId);
    const rank = { viewer: 0, member: 1, owner: 2 } as const;
    if (!r) throw new HubError("not a member of this team", 403);
    if (rank[r] < rank[atLeast]) throw new HubError(`needs ${atLeast} rights`, 403);
    return r;
  }

  team(teamId: string): Team {
    const t = this.teamsById.get(teamId);
    if (!t) throw new HubError("no such team", 404);
    return t;
  }

  createTeam(userId: string, name: string): Team {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new HubError("a team needs a name");
    const team: Team = { id: id("t"), name: clean, createdAt: this.now(), keyVersion: 1 };
    this.teamsById.set(team.id, team);
    this.memberships.set(team.id, new Map([[userId, { role: "owner", joinedAt: this.now() }]]));
    return team;
  }

  teamsOf(userId: string): Array<Team & { role: TeamRole }> {
    const out: Array<Team & { role: TeamRole }> = [];
    for (const [teamId, m] of this.memberships) {
      const mine = m.get(userId);
      if (mine) out.push({ ...this.team(teamId), role: mine.role });
    }
    return out;
  }

  registerDevice(userId: string, input: { label: string; sealPub: string; signPub: string }): HubDevice {
    if (!input.sealPub || !input.signPub) throw new HubError("a device needs both public keys");
    const existing = [...this.devices.values()].find((d) => d.userId === userId && d.signPub === input.signPub);
    if (existing) return existing;
    const d: HubDevice = {
      id: id("d"),
      userId,
      label: input.label.slice(0, 60) || "device",
      sealPub: input.sealPub,
      signPub: input.signPub,
      createdAt: this.now(),
    };
    this.devices.set(d.id, d);
    return d;
  }

  device(deviceId: string, userId: string): HubDevice {
    const d = this.devices.get(deviceId);
    if (!d || d.userId !== userId) throw new HubError("that device isn't yours", 403);
    return d;
  }

  createInvite(userId: string, teamId: string, ttlMs?: number | null): { invite: string; expiresAt: number } {
    this.requireRole(teamId, userId, "member");
    // null / NaN arrive from JSON callers; either means "the default", never the floor.
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) ttlMs = INVITE_TTL_MS;
    const invite = crypto.randomBytes(18).toString("base64url");
    const expiresAt = this.now() + Math.min(Math.max(ttlMs, 60_000), 7 * INVITE_TTL_MS);
    this.invites.set(invite, { teamId, createdBy: userId, expiresAt });
    return { invite, expiresAt };
  }

  redeemInvite(userId: string, invite: string): { team: Team; role: TeamRole } {
    const inv = this.invites.get(invite);
    if (!inv || inv.usedBy || inv.expiresAt < this.now()) throw new HubError("this invite is invalid, used or expired", 403);
    inv.usedBy = userId;
    const m = this.memberships.get(inv.teamId)!;
    if (!m.has(userId)) {
      m.set(userId, { role: "member", joinedAt: this.now() });
      this.appendFeedRaw(inv.teamId, null, { type: "member_joined", meta: { github: this.user(userId).github } });
    }
    return { team: this.team(inv.teamId), role: m.get(userId)!.role };
  }

  members(userId: string, teamId: string): MemberView[] {
    this.requireRole(teamId, userId, "viewer");
    return [...this.memberships.get(teamId)!.entries()].map(([uid, m]) => ({
      user: this.user(uid),
      role: m.role,
      joinedAt: m.joinedAt,
      devices: [...this.devices.values()].filter((d) => d.userId === uid),
    }));
  }

  removeMember(userId: string, teamId: string, target: string): void {
    const self = target === userId;
    if (!self) this.requireRole(teamId, userId, "owner");
    const m = this.memberships.get(teamId);
    if (!m?.has(target)) throw new HubError("not a member", 404);
    const owners = [...m.values()].filter((x) => x.role === "owner").length;
    if (m.get(target)!.role === "owner" && owners === 1) throw new HubError("the last owner can't leave — hand ownership over first");
    // Announce first, while the leaver can still hear it — otherwise their
    // daemon never learns it was removed and keeps showing a team it's not in.
    this.appendFeedRaw(teamId, null, { type: "member_left", meta: { github: this.user(target).github, rotateKey: true } });
    m.delete(target);
    // Their devices lose every envelope in this team; rotation (D6) is the
    // owner's next step, and the feed says so.
    for (const d of this.devices.values()) if (d.userId === target) this.envelopes.delete(`${teamId}/${d.id}`);
    for (const [k, p] of this.presenceByTeam.get(teamId) ?? []) if (p.userId === target) this.presenceByTeam.get(teamId)!.delete(k);
  }

  putKeyEnvelopes(userId: string, teamId: string, version: number, envs: Array<{ deviceId: string; box: string }>): void {
    const team = this.team(teamId);
    this.requireRole(teamId, userId, "member");
    if (version !== team.keyVersion && version !== team.keyVersion + 1) {
      throw new HubError(`key version ${version} is stale (current ${team.keyVersion})`, 409);
    }
    // Rotation is an owner act; re-sealing the current key for a new device
    // (a teammate's second laptop) is any member's.
    if (version === team.keyVersion + 1) this.requireRole(teamId, userId, "owner");
    const members = this.memberships.get(teamId)!;
    for (const e of envs) {
      const d = this.devices.get(e.deviceId);
      if (!d || !members.has(d.userId)) throw new HubError(`device ${e.deviceId} isn't on this team`, 400);
      const k = `${teamId}/${e.deviceId}`;
      const list = (this.envelopes.get(k) ?? []).filter((x) => x.version !== version);
      list.push({ version, box: e.box });
      this.envelopes.set(k, list);
    }
    if (version === team.keyVersion + 1) {
      team.keyVersion = version;
      this.appendFeedRaw(teamId, userId, { type: "key_rotated", meta: { version } });
    }
  }

  keyEnvelopes(userId: string, teamId: string, deviceId: string): Array<{ version: number; box: string }> {
    this.requireRole(teamId, userId, "viewer");
    this.device(deviceId, userId);
    return this.envelopes.get(`${teamId}/${deviceId}`) ?? [];
  }

  shareRepo(userId: string, teamId: string, repo: string): void {
    this.requireRole(teamId, userId, "member");
    const r = normalizeRepo(repo);
    const set = this.reposByTeam.get(teamId) ?? new Set();
    if (set.has(r)) return;
    set.add(r);
    this.reposByTeam.set(teamId, set);
    this.appendFeedRaw(teamId, userId, { type: "repo_shared", repo: r, meta: { repo: r } });
  }

  repos(userId: string, teamId: string): string[] {
    this.requireRole(teamId, userId, "viewer");
    return [...(this.reposByTeam.get(teamId) ?? [])].sort();
  }

  private presenceKey(p: { userId: string; deviceId: string; agent: string; repo: string }): string {
    return `${p.userId}/${p.deviceId}/${p.repo}/${p.agent}`;
  }

  heartbeat(userId: string, teamId: string, p: PresenceIn): void {
    this.requireRole(teamId, userId, "member");
    this.device(p.deviceId, userId);
    const repo = normalizeRepo(p.repo);
    if (!this.reposByTeam.get(teamId)?.has(repo)) throw new HubError(`${repo} isn't shared with this team`, 403);
    const u = this.user(userId);
    const full: Presence = {
      ...p,
      repo,
      touches: (p.touches ?? []).slice(0, 50).map((t) => String(t).slice(0, 200)),
      teamId,
      userId,
      github: u.github,
      ts: this.now(),
    };
    const map = this.presenceByTeam.get(teamId) ?? new Map();
    map.set(this.presenceKey(full), full);
    this.presenceByTeam.set(teamId, map);
    this.emit(teamId, { type: "presence", teamId, presence: full });
  }

  clearPresence(userId: string, teamId: string, key: { deviceId: string; agent: string; repo: string }): void {
    this.requireRole(teamId, userId, "member");
    const repo = normalizeRepo(key.repo);
    const k = this.presenceKey({ userId, deviceId: key.deviceId, agent: key.agent, repo });
    if (this.presenceByTeam.get(teamId)?.delete(k)) {
      this.emit(teamId, { type: "presence_gone", teamId, userId, deviceId: key.deviceId, agent: key.agent, repo });
    }
  }

  presence(userId: string, teamId: string): Presence[] {
    this.requireRole(teamId, userId, "viewer");
    const cutoff = this.now() - PRESENCE_TTL_MS;
    return [...(this.presenceByTeam.get(teamId)?.values() ?? [])].filter((p) => p.ts >= cutoff);
  }

  appendFeed(userId: string, teamId: string, e: FeedIn): FeedEvent | null {
    this.requireRole(teamId, userId, "member");
    if (e.deviceId) this.device(e.deviceId, userId);
    return this.appendFeedRaw(teamId, userId, e);
  }

  appendFeedRaw(teamId: string, userId: string | null, e: FeedIn): FeedEvent | null {
    if (e.dedupeKey) {
      const k = `${teamId}/${e.dedupeKey}`;
      if (this.dedupe.has(k)) return null;
      this.dedupe.add(k);
    }
    const ev: FeedEvent = {
      ...e,
      ...(e.repo ? { repo: normalizeRepo(e.repo) } : {}),
      id: ++this.feedSeq,
      teamId,
      userId,
      github: userId ? this.user(userId).github : null,
      ts: this.now(),
    };
    const list = this.feedByTeam.get(teamId) ?? [];
    list.push(ev);
    if (list.length > 5000) list.splice(0, list.length - 5000);
    this.feedByTeam.set(teamId, list);
    this.emit(teamId, { type: "feed", teamId, event: ev });
    return ev;
  }

  feed(userId: string, teamId: string, opts: { since?: number; limit?: number } = {}): FeedEvent[] {
    this.requireRole(teamId, userId, "viewer");
    const list = (this.feedByTeam.get(teamId) ?? []).filter((e) => e.id > (opts.since ?? 0));
    return list.slice(-Math.min(opts.limit ?? 200, 1000));
  }

  subscribe(userId: string, teamId: string, cb: (e: HubEvent) => void): () => void {
    this.requireRole(teamId, userId, "viewer");
    const set = this.listeners.get(teamId) ?? new Set();
    // A removed member stops hearing the team the moment they're removed.
    const guarded = (e: HubEvent) => {
      if (this.role(teamId, userId)) cb(e);
    };
    set.add(guarded);
    this.listeners.set(teamId, set);
    return () => set.delete(guarded);
  }

  private emit(teamId: string, e: HubEvent): void {
    for (const l of this.listeners.get(teamId) ?? []) {
      try {
        l(e);
      } catch {
        /* one bad listener never breaks the hub */
      }
    }
  }
}

class MemoryHubClient implements HubClient {
  constructor(
    private hub: MemoryHub,
    private userId: string,
  ) {}
  private run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }
  me() {
    return this.run(() => this.hub.user(this.userId));
  }
  createTeam(name: string) {
    return this.run(() => this.hub.createTeam(this.userId, name));
  }
  teams() {
    return this.run(() => this.hub.teamsOf(this.userId));
  }
  registerDevice(input: { label: string; sealPub: string; signPub: string }) {
    return this.run(() => this.hub.registerDevice(this.userId, input));
  }
  createInvite(teamId: string, ttlMs?: number) {
    return this.run(() => this.hub.createInvite(this.userId, teamId, ttlMs));
  }
  redeemInvite(invite: string) {
    return this.run(() => this.hub.redeemInvite(this.userId, invite));
  }
  members(teamId: string) {
    return this.run(() => this.hub.members(this.userId, teamId));
  }
  removeMember(teamId: string, userId: string) {
    return this.run(() => this.hub.removeMember(this.userId, teamId, userId));
  }
  putKeyEnvelopes(teamId: string, version: number, envelopes: Array<{ deviceId: string; box: string }>) {
    return this.run(() => this.hub.putKeyEnvelopes(this.userId, teamId, version, envelopes));
  }
  keyEnvelopes(teamId: string, deviceId: string) {
    return this.run(() => this.hub.keyEnvelopes(this.userId, teamId, deviceId));
  }
  shareRepo(teamId: string, repo: string) {
    return this.run(() => this.hub.shareRepo(this.userId, teamId, repo));
  }
  repos(teamId: string) {
    return this.run(() => this.hub.repos(this.userId, teamId));
  }
  heartbeat(teamId: string, p: PresenceIn) {
    return this.run(() => this.hub.heartbeat(this.userId, teamId, p));
  }
  clearPresence(teamId: string, key: { deviceId: string; agent: string; repo: string }) {
    return this.run(() => this.hub.clearPresence(this.userId, teamId, key));
  }
  presence(teamId: string) {
    return this.run(() => this.hub.presence(this.userId, teamId));
  }
  appendFeed(teamId: string, e: FeedIn) {
    return this.run(() => this.hub.appendFeed(this.userId, teamId, e));
  }
  feed(teamId: string, opts?: { since?: number; limit?: number }) {
    return this.run(() => this.hub.feed(this.userId, teamId, opts));
  }
  subscribe(teamId: string, cb: (e: HubEvent) => void) {
    return this.run(() => this.hub.subscribe(this.userId, teamId, cb));
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}
