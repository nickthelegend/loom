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
import { overlap, zoneOf, type LeaseScope } from "./team-leases.js";

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

/** A goal's claim on part of a repo (Phase 2, D28–D36). */
export interface Lease extends LeaseScope {
  id: string;
  teamId: string;
  userId: string;
  github: string;
  deviceId: string;
  repo: string;
  runId: string;
  taskId: string;
  /** active while the task runs; landing after it finishes, until the goal's PR merges (D36). */
  state: "active" | "landing";
  /** Goal/task titles, sealed to the team (D2). */
  sealed?: Sealed;
  since: number;
  ts: number;
  /** Computed on read: no renewal within LEASE_TTL_MS (the owner's laptop is asleep — D12). */
  stale?: boolean;
}

export interface LeaseClaim extends LeaseScope {
  deviceId: string;
  repo: string;
  runId: string;
  taskId: string;
  /** The team policy's hard zones, as the claimer's reviewed loom.team.json says (D37). */
  hardZones: string[];
  sealed?: Sealed;
}

export interface ClaimResult {
  /** Null when refused (a hard zone is held — D31). */
  lease: Lease | null;
  /** Everyone else's live leases this one overlaps, with the colliding paths (D29: advisory). */
  overlaps: Array<{ lease: Lease; paths: string[] }>;
  blockedBy?: { lease: Lease; zone: string };
}

/**
 * A memory shared with the team (Phase 3, D40–D51). The hub holds its content
 * sealed; `hmac` (HMAC of the normalized text under the team key) lets it
 * merge exact duplicates as confirmations without reading them (D41).
 */
export interface TeamMemory {
  id: string;
  teamId: string;
  repo: string;
  authorId: string;
  author: string; // github login
  hmac: string;
  sealed: Sealed;
  /** live → in briefings; superseded → resolved against (D47); forgotten → its author withdrew it. */
  state: "live" | "superseded" | "forgotten";
  /** A correction points at what it corrects (D40). */
  supersedes?: string;
  supersededBy?: string;
  resolvedBy?: string;
  resolvedReason?: string;
  /** Members whose agents learned exactly this — the author first (D41). */
  confirmedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TeamMemoryIn {
  id: string;
  repo: string;
  hmac: string;
  sealed: Sealed;
  deviceId: string;
  supersedes?: string;
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
  | "review_submitted"
  | "lease_released"
  | "overlap_decided"
  | "drift"
  | "zone_waiting"
  | "conflict_predicted"
  | "memory_resolved"
  | "canon_proposed"
  // Phase 4: land safely
  | "goal_landed"
  | "goal_needs_someone"
  | "goal_adopted"
  | "goal_returned"
  | "check_flaky";

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
  | { type: "memory"; teamId: string; memory: TeamMemory }
  | { type: "lease"; teamId: string; lease: Lease }
  | { type: "lease_gone"; teamId: string; leaseIds: string[]; runId: string }
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
  // ── Phase 2: leases ──
  claimLease(teamId: string, c: LeaseClaim): Promise<ClaimResult>;
  /** Widen a lease to more paths (drift, D33). Same answer shape as a claim; a held hard zone refuses. */
  extendLease(teamId: string, leaseId: string, scope: LeaseScope, hardZones: string[]): Promise<ClaimResult>;
  /** Heartbeat for leases: keeps every lease of this device fresh (D12). */
  renewLeases(teamId: string, deviceId: string): Promise<number>;
  setRunLeaseState(teamId: string, runId: string, state: "active" | "landing"): Promise<number>;
  /** The goal merged or was abandoned (D36). Owners release their own; returns how many. */
  releaseLeases(teamId: string, runId: string, reason: string): Promise<number>;
  leases(teamId: string, repo?: string): Promise<Lease[]>;
  // ── Phase 3: the team brain ──
  /** Share a memory; an exact duplicate (same hmac) becomes a confirmation instead (D41). */
  publishMemory(teamId: string, m: TeamMemoryIn): Promise<{ memory: TeamMemory; merged: boolean }>;
  /** The author revises their own memory (D40). */
  updateTeamMemory(teamId: string, id: string, patch: { hmac: string; sealed: Sealed }): Promise<TeamMemory>;
  /** The author withdraws it (made private, or forgotten). */
  forgetTeamMemory(teamId: string, id: string, reason: string): Promise<void>;
  /** A human picks the winner of a contradiction or duplicate; the loser is superseded, kept (D47). */
  resolveMemories(teamId: string, winnerId: string, loserId: string, reason: string): Promise<TeamMemory>;
  /** Live memories (D50 snapshot); with history, superseded and forgotten ones too. */
  teamMemories(teamId: string, repo: string, opts?: { history?: boolean }): Promise<TeamMemory[]>;
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
/** A lease not renewed for this long is stale: its owner's machine is asleep or gone (D12). */
export const LEASE_TTL_MS = 10 * 60_000;
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
  private leasesByTeam = new Map<string, Map<string, Lease>>();
  private memoriesByTeam = new Map<string, Map<string, TeamMemory>>();
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
    for (const [k, l] of this.leasesByTeam.get(teamId) ?? []) if (l.userId === target) this.leasesByTeam.get(teamId)!.delete(k);
  }

  // ── leases (Phase 2) ──

  private withStale(l: Lease): Lease {
    return { ...l, stale: this.now() - l.ts > LEASE_TTL_MS };
  }

  /** Everyone's live (non-stale) leases in a repo, except those of one run. */
  private rivals(teamId: string, repo: string, exceptRun: string): Lease[] {
    return [...(this.leasesByTeam.get(teamId)?.values() ?? [])]
      .map((l) => this.withStale(l))
      .filter((l) => l.repo === repo && l.runId !== exceptRun && !l.stale);
  }

  private judge(teamId: string, repo: string, runId: string, scope: LeaseScope, hardZones: string[]): Omit<ClaimResult, "lease"> {
    const rivals = this.rivals(teamId, repo, runId);
    const overlaps = rivals
      .map((l) => ({ lease: l, paths: overlap(scope, l) }))
      .filter((o) => o.paths.length > 0);
    // D31: in a hard zone, any rival lease inside the same zone refuses the claim.
    const zone = zoneOf(scope, hardZones);
    if (zone) {
      const holder = rivals.find((l) => zoneOf(l, [zone]) === zone);
      if (holder) return { overlaps, blockedBy: { lease: holder, zone } };
    }
    return { overlaps };
  }

  claimLease(userId: string, teamId: string, c: LeaseClaim): ClaimResult {
    this.requireRole(teamId, userId, "member");
    this.device(c.deviceId, userId);
    const repo = normalizeRepo(c.repo);
    if (!this.reposByTeam.get(teamId)?.has(repo)) throw new HubError(`${repo} isn't shared with this team`, 403);
    const scope: LeaseScope = { globs: c.globs.slice(0, 50), files: c.files.slice(0, 500), prefixes: c.prefixes.slice(0, 50) };
    const verdict = this.judge(teamId, repo, c.runId, scope, c.hardZones);
    if (verdict.blockedBy) return { lease: null, ...verdict };
    const map = this.leasesByTeam.get(teamId) ?? new Map<string, Lease>();
    // one lease per (run, task): a re-claim replaces the old one
    const existing = [...map.values()].find((l) => l.userId === userId && l.runId === c.runId && l.taskId === c.taskId);
    const lease: Lease = {
      ...scope,
      id: existing?.id ?? id("l"),
      teamId,
      userId,
      github: this.user(userId).github,
      deviceId: c.deviceId,
      repo,
      runId: c.runId,
      taskId: c.taskId,
      state: "active",
      ...(c.sealed ? { sealed: c.sealed } : {}),
      since: existing?.since ?? this.now(),
      ts: this.now(),
    };
    map.set(lease.id, lease);
    this.leasesByTeam.set(teamId, map);
    this.emit(teamId, { type: "lease", teamId, lease: this.withStale(lease) });
    return { lease: this.withStale(lease), ...verdict };
  }

  private ownLease(userId: string, teamId: string, leaseId: string): Lease {
    this.requireRole(teamId, userId, "member");
    const l = this.leasesByTeam.get(teamId)?.get(leaseId);
    if (!l || l.userId !== userId) throw new HubError("that lease isn't yours", 403);
    return l;
  }

  extendLease(userId: string, teamId: string, leaseId: string, scope: LeaseScope, hardZones: string[]): ClaimResult {
    const l = this.ownLease(userId, teamId, leaseId);
    const wider: LeaseScope = {
      globs: [...new Set([...l.globs, ...scope.globs])].slice(0, 50),
      files: [...new Set([...l.files, ...scope.files])].slice(0, 500),
      prefixes: [...new Set([...l.prefixes, ...scope.prefixes])].slice(0, 50),
    };
    // only the NEW part is judged — what was already held stays held
    const verdict = this.judge(teamId, l.repo, l.runId, scope, hardZones);
    if (verdict.blockedBy) return { lease: null, ...verdict };
    Object.assign(l, wider, { ts: this.now() });
    this.emit(teamId, { type: "lease", teamId, lease: this.withStale(l) });
    return { lease: this.withStale(l), ...verdict };
  }

  renewLeases(userId: string, teamId: string, deviceId: string): number {
    this.requireRole(teamId, userId, "member");
    this.device(deviceId, userId);
    let n = 0;
    for (const l of this.leasesByTeam.get(teamId)?.values() ?? []) {
      if (l.userId === userId && l.deviceId === deviceId) {
        l.ts = this.now();
        n++;
      }
    }
    return n;
  }

  setRunLeaseState(userId: string, teamId: string, runId: string, state: "active" | "landing"): number {
    this.requireRole(teamId, userId, "member");
    let n = 0;
    for (const l of this.leasesByTeam.get(teamId)?.values() ?? []) {
      if (l.userId === userId && l.runId === runId && l.state !== state) {
        l.state = state;
        l.ts = this.now();
        this.emit(teamId, { type: "lease", teamId, lease: this.withStale(l) });
        n++;
      }
    }
    return n;
  }

  releaseLeases(userId: string, teamId: string, runId: string, reason: string): number {
    this.requireRole(teamId, userId, "member");
    const map = this.leasesByTeam.get(teamId);
    const gone = [...(map?.values() ?? [])].filter((l) => l.userId === userId && l.runId === runId);
    if (!gone.length) return 0;
    for (const l of gone) map!.delete(l.id);
    this.emit(teamId, { type: "lease_gone", teamId, leaseIds: gone.map((l) => l.id), runId });
    this.appendFeedRaw(teamId, userId, {
      type: "lease_released",
      repo: gone[0]!.repo,
      meta: { runId, leases: gone.length, reason: reason.slice(0, 120) },
    });
    return gone.length;
  }

  // ── team memories (Phase 3) ──

  private mem(teamId: string): Map<string, TeamMemory> {
    let m = this.memoriesByTeam.get(teamId);
    if (!m) this.memoriesByTeam.set(teamId, (m = new Map()));
    return m;
  }

  publishMemory(userId: string, teamId: string, m: TeamMemoryIn): { memory: TeamMemory; merged: boolean } {
    this.requireRole(teamId, userId, "member");
    this.device(m.deviceId, userId);
    const repo = normalizeRepo(m.repo);
    if (!this.reposByTeam.get(teamId)?.has(repo)) throw new HubError(`${repo} isn't shared with this team`, 403);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(m.id)) throw new HubError("bad memory id");
    if (!m.hmac || !m.sealed?.c) throw new HubError("a team memory needs its hmac and sealed content");
    const github = this.user(userId).github;
    const map = this.mem(teamId);
    const own = map.get(m.id);
    if (own && own.authorId !== userId) throw new HubError("that memory id belongs to someone else", 403);
    const twin = [...map.values()].find((x) => x.repo === repo && x.hmac === m.hmac && x.state === "live" && x.id !== m.id);
    if (twin && !own) {
      if (!twin.confirmedBy.includes(github)) twin.confirmedBy.push(github);
      twin.updatedAt = this.now();
      this.emit(teamId, { type: "memory", teamId, memory: { ...twin } });
      return { memory: { ...twin }, merged: true };
    }
    if (m.supersedes && !map.has(m.supersedes)) throw new HubError(`no team memory "${m.supersedes}" to supersede`, 404);
    const tm: TeamMemory = {
      id: m.id,
      teamId,
      repo,
      authorId: userId,
      author: github,
      hmac: m.hmac,
      sealed: m.sealed,
      state: "live",
      ...(m.supersedes ? { supersedes: m.supersedes } : {}),
      confirmedBy: own?.confirmedBy ?? [github],
      createdAt: own?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    map.set(tm.id, tm);
    this.emit(teamId, { type: "memory", teamId, memory: { ...tm } });
    return { memory: { ...tm }, merged: false };
  }

  private ownMemory(userId: string, teamId: string, id: string): TeamMemory {
    this.requireRole(teamId, userId, "member");
    const m = this.mem(teamId).get(id);
    if (!m) throw new HubError(`no team memory "${id}"`, 404);
    if (m.authorId !== userId) throw new HubError("only its author can change a memory — record a correction instead", 403);
    return m;
  }

  updateTeamMemory(userId: string, teamId: string, id: string, patch: { hmac: string; sealed: Sealed }): TeamMemory {
    const m = this.ownMemory(userId, teamId, id);
    m.hmac = patch.hmac;
    m.sealed = patch.sealed;
    m.updatedAt = this.now();
    this.emit(teamId, { type: "memory", teamId, memory: { ...m } });
    return { ...m };
  }

  forgetTeamMemory(userId: string, teamId: string, id: string, reason: string): void {
    const m = this.ownMemory(userId, teamId, id);
    m.state = "forgotten";
    m.resolvedReason = reason.slice(0, 200);
    m.updatedAt = this.now();
    this.emit(teamId, { type: "memory", teamId, memory: { ...m } });
  }

  resolveMemories(userId: string, teamId: string, winnerId: string, loserId: string, reason: string): TeamMemory {
    this.requireRole(teamId, userId, "member");
    const map = this.mem(teamId);
    const winner = map.get(winnerId);
    const loser = map.get(loserId);
    if (!winner || !loser) throw new HubError("both memories must exist", 404);
    if (winnerId === loserId) throw new HubError("a memory can't supersede itself");
    loser.state = "superseded";
    loser.supersededBy = winnerId;
    loser.resolvedBy = this.user(userId).github;
    loser.resolvedReason = reason.slice(0, 200);
    loser.updatedAt = this.now();
    // the winner inherits the loser's confirmations: they agreed on the topic
    for (const g of loser.confirmedBy) if (!winner.confirmedBy.includes(g)) winner.confirmedBy.push(g);
    winner.updatedAt = this.now();
    this.emit(teamId, { type: "memory", teamId, memory: { ...loser } });
    this.emit(teamId, { type: "memory", teamId, memory: { ...winner } });
    this.appendFeedRaw(teamId, userId, {
      type: "memory_resolved",
      repo: loser.repo,
      meta: { winner: winnerId, loser: loserId, reason: reason.slice(0, 200) },
    });
    return { ...loser };
  }

  teamMemories(userId: string, teamId: string, repo: string, opts: { history?: boolean } = {}): TeamMemory[] {
    this.requireRole(teamId, userId, "viewer");
    const r = normalizeRepo(repo);
    return [...this.mem(teamId).values()]
      .filter((m) => m.repo === r && (opts.history || m.state === "live"))
      .map((m) => ({ ...m, confirmedBy: [...m.confirmedBy] }));
  }

  leases(userId: string, teamId: string, repo?: string): Lease[] {
    this.requireRole(teamId, userId, "viewer");
    const r = repo ? normalizeRepo(repo) : null;
    return [...(this.leasesByTeam.get(teamId)?.values() ?? [])]
      .filter((l) => !r || l.repo === r)
      .map((l) => this.withStale(l));
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
  claimLease(teamId: string, c: LeaseClaim) {
    return this.run(() => this.hub.claimLease(this.userId, teamId, c));
  }
  extendLease(teamId: string, leaseId: string, scope: LeaseScope, hardZones: string[]) {
    return this.run(() => this.hub.extendLease(this.userId, teamId, leaseId, scope, hardZones));
  }
  renewLeases(teamId: string, deviceId: string) {
    return this.run(() => this.hub.renewLeases(this.userId, teamId, deviceId));
  }
  setRunLeaseState(teamId: string, runId: string, state: "active" | "landing") {
    return this.run(() => this.hub.setRunLeaseState(this.userId, teamId, runId, state));
  }
  releaseLeases(teamId: string, runId: string, reason: string) {
    return this.run(() => this.hub.releaseLeases(this.userId, teamId, runId, reason));
  }
  leases(teamId: string, repo?: string) {
    return this.run(() => this.hub.leases(this.userId, teamId, repo));
  }
  publishMemory(teamId: string, m: TeamMemoryIn) {
    return this.run(() => this.hub.publishMemory(this.userId, teamId, m));
  }
  updateTeamMemory(teamId: string, id: string, patch: { hmac: string; sealed: Sealed }) {
    return this.run(() => this.hub.updateTeamMemory(this.userId, teamId, id, patch));
  }
  forgetTeamMemory(teamId: string, id: string, reason: string) {
    return this.run(() => this.hub.forgetTeamMemory(this.userId, teamId, id, reason));
  }
  resolveMemories(teamId: string, winnerId: string, loserId: string, reason: string) {
    return this.run(() => this.hub.resolveMemories(this.userId, teamId, winnerId, loserId, reason));
  }
  teamMemories(teamId: string, repo: string, opts?: { history?: boolean }) {
    return this.run(() => this.hub.teamMemories(this.userId, teamId, repo, opts));
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}
