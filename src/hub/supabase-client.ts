/**
 * SupabaseHubClient — a daemon's connection to the hosted Loom Team Hub.
 *
 * Same `HubClient` contract as MemoryHub (the reference) and HttpHubClient
 * (a self-hosted `loom hub`), against the Supabase schema in
 * supabase/migrations/0002–0007: reads are RLS-guarded selects, writes are the
 * SECURITY DEFINER rule functions called through `rpc`, and live events are
 * Realtime `postgres_changes` (RLS decides who hears what).
 *
 * Sessions: the client holds a Supabase session (access + refresh token) and
 * supabase-js refreshes it on its own. Refresh tokens rotate — the one that
 * was just used is dead — so whoever persists the session (Team Link, in
 * team.json) must listen with `onSession` and store every new one.
 *
 * Sign-in (D65) is GitHub OAuth through Supabase, PKCE with a loopback
 * redirect: `hostedSignIn`.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { RealtimeChannel, Session, SupabaseClient } from "@supabase/supabase-js";

import {
  HubError,
  LEASE_TTL_MS,
  normalizeRepo,
  type ClaimResult,
  type FeedEvent,
  type FeedIn,
  type HubClient,
  type HubDevice,
  type HubEvent,
  type HubUser,
  type Job,
  type JobIn,
  type Lease,
  type LeaseClaim,
  type MemberView,
  type Presence,
  type PresenceIn,
  type Runner,
  type Team,
  type TeamMemory,
  type TeamMemoryIn,
  type TeamRole,
} from "../core/team-hub.js";
import type { Sealed } from "../core/team-crypto.js";
import type { LeaseScope } from "../core/team-leases.js";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** What a caller needs to keep to come back later — the refresh token is the one that matters. */
export interface HostedSession {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, epoch ms. */
  expiresAt: number;
  userId: string;
}

function toHostedSession(s: Session): HostedSession {
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: (s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600)) * 1000,
    userId: s.user.id,
  };
}

/** supabase-js wants somewhere to keep its session (and the PKCE verifier); memory is right for a daemon. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

async function newSupabase(supabaseUrl: string, publishableKey: string): Promise<SupabaseClient> {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(supabaseUrl, publishableKey, {
    auth: {
      persistSession: true,
      storage: memoryStorage(),
      storageKey: "loom-team-hub",
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
    realtime: { params: { eventsPerSecond: 20 } },
  });
}

// ---------------------------------------------------------------------------
// Errors and row mapping (snake_case rows → the camelCase types MemoryHub returns)
// ---------------------------------------------------------------------------

interface PgError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** A Postgres / PostgREST error as the HubError MemoryHub would have thrown. */
export function hubErrorFrom(err: PgError | null | undefined, httpStatus?: number): HubError {
  const code = err?.code ?? "";
  const message = err?.message || `hosted hub request failed${httpStatus ? ` (${httpStatus})` : ""}`;
  let status = 400;
  if (code === "42501") status = 403;
  else if (code === "P0002") status = 404;
  else if (code === "40001") status = 409;
  else if (/^PT[45]\d\d$/.test(code)) status = Number(code.slice(2)); // PostgREST's "PTxyz" = HTTP xyz
  else if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303" || httpStatus === 401) status = 401;
  return new HubError(message, status);
}

type Row = Record<string, unknown>;

/** Postgres timestamps (PostgREST's ISO, or the text form Realtime sends) → epoch ms. */
export function ms(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v) return 0;
  const iso = v
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d\d)$/, "$1:00");
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
/** Only the optional fields that are set, the way MemoryHub spreads its input. */
function opt<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) (out as Row)[k] = v;
  return out;
}

export function mapTeam(r: Row): Team {
  return { id: str(r.id), name: str(r.name), createdAt: ms(r.created_at), keyVersion: Number(r.key_version ?? 1) };
}

export function mapDevice(r: Row): HubDevice {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    label: str(r.label),
    sealPub: str(r.seal_pub),
    signPub: str(r.sign_pub),
    createdAt: ms(r.created_at),
  };
}

export function mapPresence(r: Row, github: string): Presence {
  return {
    deviceId: str(r.device_id),
    repo: str(r.repo),
    ...opt({ runId: r.run_id as string | undefined, taskId: r.task_id as string | undefined }),
    agent: str(r.agent),
    kind: str(r.kind),
    ...opt({ branch: r.branch as string | undefined }),
    touches: arr(r.touches),
    state: str(r.state) as Presence["state"],
    since: ms(r.since),
    ...opt({ sealed: r.sealed as Sealed | undefined, sig: r.sig as string | undefined }),
    teamId: str(r.team_id),
    userId: str(r.user_id),
    github,
    ts: ms(r.ts),
  };
}

export function mapLease(r: Row, github: string, now = Date.now()): Lease {
  const ts = ms(r.ts);
  return {
    globs: arr(r.globs),
    files: arr(r.files),
    prefixes: arr(r.prefixes),
    id: str(r.id),
    teamId: str(r.team_id),
    userId: str(r.user_id),
    github,
    deviceId: str(r.device_id),
    repo: str(r.repo),
    runId: str(r.run_id),
    taskId: str(r.task_id),
    state: (str(r.state) || "active") as Lease["state"],
    ...opt({ sealed: r.sealed as Sealed | undefined }),
    since: ms(r.since),
    ts,
    stale: now - ts > LEASE_TTL_MS,
  };
}

export function mapMemory(r: Row): TeamMemory {
  return {
    id: str(r.id),
    teamId: str(r.team_id),
    repo: str(r.repo),
    authorId: str(r.author_id),
    author: str(r.author),
    hmac: str(r.hmac),
    sealed: r.sealed as Sealed,
    state: str(r.state) as TeamMemory["state"],
    ...opt({
      supersedes: r.supersedes as string | undefined,
      supersededBy: r.superseded_by as string | undefined,
      resolvedBy: r.resolved_by as string | undefined,
      resolvedReason: r.resolved_reason as string | undefined,
    }),
    confirmedBy: arr(r.confirmed_by),
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

export function mapFeed(r: Row, github: string | null): FeedEvent {
  return {
    ...opt({ repo: r.repo as string | undefined }),
    type: str(r.type) as FeedEvent["type"],
    meta: (r.meta as Record<string, unknown>) ?? {},
    ...opt({
      sealed: r.sealed as Sealed | undefined,
      deviceId: r.device_id as string | undefined,
      sig: r.sig as string | undefined,
      dedupeKey: r.dedupe_key as string | undefined,
    }),
    id: Number(r.id),
    teamId: str(r.team_id),
    userId: (r.user_id as string | null) ?? null,
    github,
    ts: ms(r.ts),
  };
}

/** A `jobs` row (PostgREST or Realtime) → the Job MemoryHub returns. */
export function mapJob(r: Row): Job {
  return {
    id: str(r.id),
    teamId: str(r.team_id),
    repo: str(r.repo),
    kind: str(r.kind) as Job["kind"],
    userId: str(r.user_id),
    github: str(r.github),
    ...opt({ target: r.target as string | undefined }),
    state: str(r.state) as Job["state"],
    ...opt({
      runnerId: r.runner_id as string | undefined,
      runnerGithub: r.runner_github as string | undefined,
      claimedAt: r.claimed_at == null ? undefined : ms(r.claimed_at),
      heartbeatAt: r.heartbeat_at == null ? undefined : ms(r.heartbeat_at),
    }),
    sealed: r.sealed as Sealed,
    ...opt({
      progress: r.progress as Sealed | undefined,
      result: r.result as Sealed | undefined,
      error: r.error as string | undefined,
    }),
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

/** team_runners / register_runner JSON (already camelCase) → Runner. */
export function mapRunner(r: Row): Runner {
  return {
    deviceId: str(r.deviceId),
    userId: str(r.userId),
    github: str(r.github),
    label: str(r.label),
    kinds: arr(r.kinds),
    shared: Boolean(r.shared),
    capacity: Number(r.capacity ?? 1),
    lastSeen: ms(r.lastSeen),
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface SupabaseHubOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** A session fresh from `hostedSignIn`… */
  session?: HostedSession;
  /** …or a refresh token kept from an earlier one (team.json). */
  refreshToken?: string;
  /** Called with every new session (sign-in, each refresh). Persist its refreshToken. */
  onSession?: (s: HostedSession) => void;
}

type SessionListener = (s: HostedSession) => void;

export class SupabaseHubClient implements HubClient {
  private sbP: Promise<SupabaseClient> | null = null;
  private current: HostedSession | null;
  private listeners = new Set<SessionListener>();
  private githubs = new Map<string, string>(); // user id → GitHub login
  private closed = false;

  constructor(private opts: SupabaseHubOptions) {
    if (!opts.session && !opts.refreshToken) throw new HubError("the hosted hub needs a session — sign in again", 401);
    this.current = opts.session ?? null;
    if (opts.onSession) this.listeners.add(opts.onSession);
  }

  /** Hear every new session (refreshes rotate the refresh token). Returns an unsubscribe. */
  onSession(cb: SessionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The session in effect right now (null until the first call has restored it). */
  session(): HostedSession | null {
    return this.current;
  }

  get supabaseUrl(): string {
    return this.opts.supabaseUrl;
  }

  /** Stop refreshing and drop every live subscription. */
  async close(): Promise<void> {
    this.closed = true;
    const p = this.sbP;
    this.sbP = null;
    if (!p) return;
    const sb = await p.catch(() => null);
    if (!sb) return;
    await sb.auth.stopAutoRefresh().catch(() => {});
    await sb.removeAllChannels().catch(() => {});
    sb.realtime.disconnect();
  }

  private emitSession(s: Session): void {
    const hs = toHostedSession(s);
    const changed = !this.current || this.current.refreshToken !== hs.refreshToken || this.current.accessToken !== hs.accessToken;
    this.current = hs;
    if (!changed) return;
    for (const l of this.listeners) {
      try {
        l(hs);
      } catch {
        /* a listener's failure never breaks the session */
      }
    }
  }

  /** The supabase-js client, with the session restored (once). */
  private sb(): Promise<SupabaseClient> {
    if (this.closed) return Promise.reject(new HubError("this hub connection is closed", 400));
    if (!this.sbP) {
      this.sbP = (async () => {
        const sb = await newSupabase(this.opts.supabaseUrl, this.opts.publishableKey);
        sb.auth.onAuthStateChange((event, session) => {
          // Synchronous on purpose: awaiting auth calls in here deadlocks supabase-js.
          if (session && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED")) {
            this.emitSession(session);
            void sb.realtime.setAuth(session.access_token);
          }
        });
        const s = this.current;
        const { data, error } = s
          ? await sb.auth.setSession({ access_token: s.accessToken, refresh_token: s.refreshToken })
          : await sb.auth.refreshSession({ refresh_token: this.opts.refreshToken! });
        if (error || !data.session) {
          const status = (error as { status?: number } | null)?.status;
          // 4xx: the refresh token is spent or revoked — only a new sign-in helps
          if (status && status < 500) throw new HubError(`the hosted hub session expired — sign in again (${error!.message})`, 401);
          throw new HubError(error?.message ?? "couldn't restore the hosted hub session", 503);
        }
        this.emitSession(data.session);
        await sb.realtime.setAuth(data.session.access_token);
        return sb;
      })();
      // a failed restore can be retried (network); a spent token will just fail again with 401
      this.sbP.catch(() => {
        this.sbP = null;
      });
    }
    return this.sbP;
  }

  private uid(): string {
    if (!this.current) throw new HubError("not signed in to the hosted hub", 401);
    return this.current.userId;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const sb = await this.sb();
    const res = await sb.rpc(fn, args);
    if (res.error) throw hubErrorFrom(res.error, res.status);
    return res.data as T;
  }

  private async select<T = Row>(build: (sb: SupabaseClient) => PromiseLike<{ data: unknown; error: PgError | null; status: number }>): Promise<T[]> {
    const sb = await this.sb();
    const res = await build(sb);
    if (res.error) throw hubErrorFrom(res.error, res.status);
    return (res.data as T[] | null) ?? [];
  }

  /** GitHub logins for user ids, cached (profiles are readable for self and teammates). */
  private async logins(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const missing = [...new Set(ids.filter((x): x is string => Boolean(x) && !this.githubs.has(x!)))];
    if (missing.length) {
      const rows = await this.select((sb) => sb.from("profiles").select("user_id, github").in("user_id", missing));
      for (const r of rows) this.githubs.set(str(r.user_id), str(r.github));
    }
    return this.githubs;
  }

  private async login(id: string | null | undefined): Promise<string> {
    if (!id) return "";
    return (await this.logins([id])).get(id) ?? "";
  }

  private async leasesOf(rows: Row[]): Promise<Lease[]> {
    const g = await this.logins(rows.map((r) => r.user_id as string));
    const now = Date.now();
    return rows.map((r) => mapLease(r, g.get(str(r.user_id)) ?? "", now));
  }

  private async claimResult(raw: { lease: Row | null; overlaps?: Array<{ lease: Row; paths: string[] }>; blockedBy?: { lease: Row; zone: string } }): Promise<ClaimResult> {
    const rows = [raw.lease, ...(raw.overlaps ?? []).map((o) => o.lease), raw.blockedBy?.lease].filter((x): x is Row => Boolean(x));
    const g = await this.logins(rows.map((r) => r.user_id as string));
    const now = Date.now();
    const lease = (r: Row) => mapLease(r, g.get(str(r.user_id)) ?? "", now);
    return {
      lease: raw.lease ? lease(raw.lease) : null,
      overlaps: (raw.overlaps ?? []).map((o) => ({ lease: lease(o.lease), paths: arr(o.paths) })),
      ...(raw.blockedBy ? { blockedBy: { lease: lease(raw.blockedBy.lease), zone: raw.blockedBy.zone } } : {}),
    };
  }

  // ── Phase 1 ──

  async me(): Promise<HubUser> {
    await this.sb();
    const rows = await this.select((sb) => sb.from("profiles").select("user_id, github, name").eq("user_id", this.uid()));
    const r = rows[0];
    if (!r) throw new HubError("no such user", 404);
    this.githubs.set(str(r.user_id), str(r.github));
    return { id: str(r.user_id), github: str(r.github), name: str(r.name) || str(r.github) };
  }

  async createTeam(name: string): Promise<Team> {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new HubError("a team needs a name");
    return mapTeam(await this.rpc<Row>("create_team", { p_name: clean }));
  }

  async teams(): Promise<Array<Team & { role: TeamRole }>> {
    await this.sb();
    const rows = await this.select((sb) => sb.from("team_members").select("role, teams(*)").eq("user_id", this.uid()));
    return rows.filter((r) => r.teams).map((r) => ({ ...mapTeam(r.teams as Row), role: str(r.role) as TeamRole }));
  }

  async registerDevice(input: { label: string; sealPub: string; signPub: string }): Promise<HubDevice> {
    if (!input.sealPub || !input.signPub) throw new HubError("a device needs both public keys");
    return mapDevice(await this.rpc<Row>("register_device", { p_label: input.label, p_seal_pub: input.sealPub, p_sign_pub: input.signPub }));
  }

  async createInvite(teamId: string, ttlMs?: number): Promise<{ invite: string; expiresAt: number }> {
    const args: Record<string, unknown> = { p_team: teamId };
    if (typeof ttlMs === "number" && Number.isFinite(ttlMs)) args.p_ttl_seconds = Math.round(ttlMs / 1000);
    const out = await this.rpc<{ invite: string; expiresAt: number }>("create_invite", args);
    return { invite: out.invite, expiresAt: Number(out.expiresAt) };
  }

  async redeemInvite(invite: string): Promise<{ team: Team; role: TeamRole }> {
    const out = await this.rpc<{ team: Row; role: TeamRole }>("redeem_invite", { p_invite: invite });
    return { team: mapTeam(out.team), role: out.role };
  }

  async members(teamId: string): Promise<MemberView[]> {
    const list = await this.rpc<MemberView[]>("team_member_list", { p_team: teamId });
    for (const m of list) this.githubs.set(m.user.id, m.user.github);
    return list.map((m) => ({ ...m, user: { ...m.user, name: m.user.name || m.user.github } }));
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.rpc("remove_member", { p_team: teamId, p_user: userId });
  }

  async putKeyEnvelopes(teamId: string, version: number, envelopes: Array<{ deviceId: string; box: string }>): Promise<void> {
    await this.rpc("put_key_envelopes", { p_team: teamId, p_version: version, p_envelopes: envelopes });
  }

  async keyEnvelopes(teamId: string, deviceId: string): Promise<Array<{ version: number; box: string }>> {
    const rows = await this.select((sb) =>
      sb.from("key_envelopes").select("version, box").eq("team_id", teamId).eq("device_id", deviceId).order("version"),
    );
    return rows.map((r) => ({ version: Number(r.version), box: str(r.box) }));
  }

  async shareRepo(teamId: string, repo: string): Promise<void> {
    await this.rpc("share_repo", { p_team: teamId, p_repo: normalizeRepo(repo) });
  }

  async repos(teamId: string): Promise<string[]> {
    const rows = await this.select((sb) => sb.from("team_repos").select("repo").eq("team_id", teamId).order("repo"));
    return rows.map((r) => str(r.repo));
  }

  async heartbeat(teamId: string, p: PresenceIn): Promise<void> {
    await this.rpc("heartbeat", { p_team: teamId, p });
  }

  async clearPresence(teamId: string, key: { deviceId: string; agent: string; repo: string }): Promise<void> {
    await this.rpc("clear_presence", { p_team: teamId, p_device: key.deviceId, p_repo: key.repo, p_agent: key.agent });
  }

  async presence(teamId: string): Promise<Presence[]> {
    const rows = await this.select((sb) => sb.from("presence").select("*").eq("team_id", teamId));
    const g = await this.logins(rows.map((r) => r.user_id as string));
    return rows.map((r) => mapPresence(r, g.get(str(r.user_id)) ?? ""));
  }

  async appendFeed(teamId: string, e: FeedIn): Promise<FeedEvent | null> {
    const row = await this.rpc<Row | null>("append_feed", { p_team: teamId, e });
    if (!row || row.id == null) return null; // deduped
    return mapFeed(row, await this.login(row.user_id as string));
  }

  async feed(teamId: string, opts: { since?: number; limit?: number } = {}): Promise<FeedEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = await this.select((sb) =>
      sb
        .from("feed")
        .select("*")
        .eq("team_id", teamId)
        .gt("id", opts.since ?? 0)
        .order("id", { ascending: false })
        .limit(limit),
    );
    const g = await this.logins(rows.map((r) => r.user_id as string | null));
    return rows.reverse().map((r) => mapFeed(r, r.user_id ? (g.get(str(r.user_id)) ?? null) : null));
  }

  // ── Phase 2: leases ──

  async claimLease(teamId: string, c: LeaseClaim): Promise<ClaimResult> {
    return this.claimResult(await this.rpc("claim_lease", { p_team: teamId, c }));
  }

  async extendLease(teamId: string, leaseId: string, scope: LeaseScope, hardZones: string[]): Promise<ClaimResult> {
    const s = { globs: scope.globs, files: scope.files, prefixes: scope.prefixes };
    return this.claimResult(await this.rpc("extend_lease", { p_team: teamId, p_lease: leaseId, scope: s, hard_zones: hardZones }));
  }

  async renewLeases(teamId: string, deviceId: string): Promise<number> {
    return Number(await this.rpc("renew_leases", { p_team: teamId, p_device: deviceId }));
  }

  async setRunLeaseState(teamId: string, runId: string, state: "active" | "landing"): Promise<number> {
    return Number(await this.rpc("set_run_lease_state", { p_team: teamId, p_run: runId, p_state: state }));
  }

  async releaseLeases(teamId: string, runId: string, reason: string): Promise<number> {
    return Number(await this.rpc("release_leases", { p_team: teamId, p_run: runId, p_reason: reason }));
  }

  async leases(teamId: string, repo?: string): Promise<Lease[]> {
    const r = repo ? normalizeRepo(repo) : null;
    const rows = await this.select((sb) => {
      const q = sb.from("leases").select("*").eq("team_id", teamId);
      return r ? q.eq("repo", r) : q;
    });
    return this.leasesOf(rows);
  }

  // ── Phase 3: the team brain ──

  async publishMemory(teamId: string, m: TeamMemoryIn): Promise<{ memory: TeamMemory; merged: boolean }> {
    const out = await this.rpc<{ memory: Row; merged: boolean }>("publish_memory", { p_team: teamId, m });
    return { memory: mapMemory(out.memory), merged: Boolean(out.merged) };
  }

  async updateTeamMemory(teamId: string, id: string, patch: { hmac: string; sealed: Sealed }): Promise<TeamMemory> {
    return mapMemory(await this.rpc<Row>("update_team_memory", { p_team: teamId, p_id: id, p_hmac: patch.hmac, p_sealed: patch.sealed }));
  }

  async forgetTeamMemory(teamId: string, id: string, reason: string): Promise<void> {
    await this.rpc("forget_team_memory", { p_team: teamId, p_id: id, p_reason: reason });
  }

  async resolveMemories(teamId: string, winnerId: string, loserId: string, reason: string): Promise<TeamMemory> {
    return mapMemory(await this.rpc<Row>("resolve_memories", { p_team: teamId, p_winner: winnerId, p_loser: loserId, p_reason: reason }));
  }

  async teamMemories(teamId: string, repo: string, opts: { history?: boolean } = {}): Promise<TeamMemory[]> {
    const r = normalizeRepo(repo);
    const rows = await this.select((sb) => {
      const q = sb.from("team_memories").select("*").eq("team_id", teamId).eq("repo", r).order("created_at");
      return opts.history ? q : q.eq("state", "live");
    });
    return rows.map(mapMemory);
  }

  // ── Phase 5: runners and jobs ──

  async registerRunner(input: { deviceId: string; kinds: string[]; shared: boolean; capacity?: number }): Promise<Runner> {
    return mapRunner(
      await this.rpc<Row>("register_runner", {
        p_device: input.deviceId,
        p_kinds: input.kinds.map(String),
        p_shared: Boolean(input.shared),
        p_capacity: Math.floor(input.capacity ?? 1),
      }),
    );
  }

  async runners(teamId: string): Promise<Runner[]> {
    return ((await this.rpc<Row[] | null>("team_runners", { p_team: teamId })) ?? []).map(mapRunner);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.rpc("revoke_device", { p_device: deviceId });
  }

  async createJob(teamId: string, j: JobIn): Promise<Job> {
    return mapJob(await this.rpc<Row>("create_job", { p_team: teamId, j }));
  }

  async claimJob(teamId: string, runnerDeviceId: string): Promise<Job | null> {
    const row = await this.rpc<Row | null>("claim_job", { p_team: teamId, p_runner: runnerDeviceId });
    // a composite-returning function answers "none" as a row of nulls
    return !row || row.id == null ? null : mapJob(row);
  }

  async heartbeatJob(teamId: string, jobId: string, runnerDeviceId: string, progress?: Sealed): Promise<Job> {
    return mapJob(
      await this.rpc<Row>("heartbeat_job", { p_team: teamId, p_job: jobId, p_runner: runnerDeviceId, ...(progress ? { p_progress: progress } : {}) }),
    );
  }

  async finishJob(
    teamId: string,
    jobId: string,
    runnerDeviceId: string,
    outcome: { state: "done" | "failed"; result?: Sealed; error?: string },
  ): Promise<Job> {
    return mapJob(
      await this.rpc<Row>("finish_job", {
        p_team: teamId,
        p_job: jobId,
        p_runner: runnerDeviceId,
        p_state: outcome.state,
        ...(outcome.result ? { p_result: outcome.result } : {}),
        ...(outcome.error ? { p_error: outcome.error } : {}),
      }),
    );
  }

  async cancelJob(teamId: string, jobId: string): Promise<Job> {
    return mapJob(await this.rpc<Row>("cancel_job", { p_team: teamId, p_job: jobId }));
  }

  async jobs(teamId: string, opts: { active?: boolean } = {}): Promise<Job[]> {
    const rows = await this.select((sb) => {
      const q = sb.from("jobs").select("*").eq("team_id", teamId).order("created_at").order("id");
      return opts.active ? q.in("state", ["queued", "claimed"]) : q;
    });
    return rows.map(mapJob);
  }

  // ── live events ──

  /**
   * Realtime `postgres_changes` on feed, presence, leases, team_memories and jobs,
   * as the HubEvents MemoryHub emits. Inserts and updates are filtered to the
   * team and RLS-checked per member. Deletes can't be filtered and carry only
   * the primary key, so: presence's key includes the team, and lease ids are
   * matched against the leases this subscription has seen.
   */
  async subscribe(teamId: string, cb: (e: HubEvent) => void): Promise<() => void> {
    const sb = await this.sb();
    // MemoryHub refuses non-members; RLS would just stay silent.
    const mine = await this.select((s) => s.from("team_members").select("role").eq("team_id", teamId).eq("user_id", this.uid()));
    if (!mine.length) throw new HubError("not a member of this team", 403);

    const runOf = new Map<string, string>(); // lease id → run id
    for (const l of await this.leases(teamId).catch(() => [] as Lease[])) runOf.set(l.id, l.runId);

    // one event at a time, in arrival order, even when a login lookup has to wait
    let chain = Promise.resolve();
    let closed = false;
    const emit = (make: () => Promise<HubEvent | null>) => {
      chain = chain
        .then(async () => {
          const e = await make();
          if (e && !closed) cb(e);
        })
        .catch(() => {
          /* one bad event never breaks the stream */
        });
    };

    const filter = `team_id=eq.${teamId}`;
    type Change = { eventType: "INSERT" | "UPDATE" | "DELETE"; new: Row; old: Row };
    const ch: RealtimeChannel = sb.channel(`loom-team:${teamId}:${Math.random().toString(36).slice(2, 10)}`);
    const on = (table: string, event: "INSERT" | "UPDATE" | "DELETE", fn: (p: Change) => void) =>
      ch.on(
        "postgres_changes" as never,
        { event, schema: "public", table, ...(event === "DELETE" ? {} : { filter }) } as never,
        ((p: Change) => fn(p)) as never,
      );

    on("feed", "INSERT", (p) =>
      emit(async () => ({ type: "feed", teamId, event: mapFeed(p.new, p.new.user_id ? await this.login(str(p.new.user_id)) : null) })),
    );
    const presence = (p: Change) =>
      emit(async () => ({ type: "presence", teamId, presence: mapPresence(p.new, await this.login(str(p.new.user_id))) }));
    on("presence", "INSERT", presence);
    on("presence", "UPDATE", presence);
    on("presence", "DELETE", (p) => {
      if (str(p.old.team_id) !== teamId) return;
      emit(async () => ({
        type: "presence_gone",
        teamId,
        userId: str(p.old.user_id),
        deviceId: str(p.old.device_id),
        agent: str(p.old.agent),
        repo: str(p.old.repo),
      }));
    });
    const lease = (p: Change) => {
      runOf.set(str(p.new.id), str(p.new.run_id));
      emit(async () => ({ type: "lease", teamId, lease: mapLease(p.new, await this.login(str(p.new.user_id))) }));
    };
    on("leases", "INSERT", lease);
    on("leases", "UPDATE", lease);
    on("leases", "DELETE", (p) => {
      const id = str(p.old.id);
      const runId = runOf.get(id);
      if (runId === undefined) return; // another team's lease
      runOf.delete(id);
      emit(async () => ({ type: "lease_gone", teamId, leaseIds: [id], runId }));
    });
    const memory = (p: Change) => emit(async () => ({ type: "memory", teamId, memory: mapMemory(p.new) }));
    on("team_memories", "INSERT", memory);
    on("team_memories", "UPDATE", memory);
    const job = (p: Change) => emit(async () => ({ type: "job", teamId, job: mapJob(p.new) }));
    on("jobs", "INSERT", job);
    on("jobs", "UPDATE", job);

    // Ready means both: the channel joined (SUBSCRIBED) *and* Realtime says the
    // Postgres subscription is live — that system message comes later, and a
    // change in between would be lost.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let joined = false;
      let pgReady = false;
      const ready = () => {
        if (settled || !joined || !pgReady) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ch.on("system" as never, {} as never, ((m: { extension?: string; status?: string; message?: string }) => {
        if (m?.extension !== "postgres_changes" || settled) return;
        if (m.status === "ok") {
          pgReady = true;
          ready();
        } else {
          settled = true;
          clearTimeout(timer);
          reject(new HubError(`hosted hub realtime: ${m.message ?? "postgres changes unavailable"}`, 503));
        }
      }) as never);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new HubError("the hosted hub's realtime didn't answer", 503));
      }, 20_000);
      timer.unref?.();
      ch.subscribe((status: string, err?: Error) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          joined = true;
          ready();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          settled = true;
          clearTimeout(timer);
          reject(new HubError(`hosted hub realtime: ${err?.message ?? status.toLowerCase()}`, 503));
        }
      });
    }).catch(async (err) => {
      await sb.removeChannel(ch).catch(() => {});
      throw err;
    });
    // After the initial join, realtime-js rejoins on its own after a drop.

    return () => {
      closed = true;
      void sb.removeChannel(ch).catch(() => {});
    };
  }
}

// ---------------------------------------------------------------------------
// Sign-in: GitHub OAuth through Supabase, PKCE, loopback redirect (D65)
// ---------------------------------------------------------------------------

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f5;color:#1a1a1a}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}}main{max-width:28rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/**
 * The loopback half of an OAuth sign-in: listen on 127.0.0.1 (random port),
 * hand the redirect URL to `start` (build the authorize URL, open a browser),
 * wait for `/callback?code=…`, trade the code with `exchange`, and tell the
 * browser tab it can close. Rejects on an OAuth error, or after `timeoutMs`.
 */
export async function loopbackSignIn<T>(opts: {
  start: (redirectTo: string) => Promise<void> | void;
  exchange: (code: string) => Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectTo = `http://127.0.0.1:${port}/callback`;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (err: Error | null, value?: T) => {
      if (finished) return;
      finished = true;
      if (err) reject(err);
      else resolve(value as T);
    };
    timer = setTimeout(
      () => finish(new HubError("sign-in timed out — nothing came back from the browser in 5 minutes", 408)),
      opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    );
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectTo);
      const reply = (status: number, title: string, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
        res.end(page(title, body));
      };
      if (url.pathname !== "/callback") return reply(404, "Not found", "This is Loom's sign-in listener.");
      if (finished) return reply(410, "Already done", "This sign-in has finished. You can close this tab.");
      const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error");
      if (oauthError) {
        reply(400, "Sign-in failed", `${oauthError}. You can close this tab and try again.`);
        return finish(new HubError(`sign-in failed: ${oauthError}`, 401));
      }
      const code = url.searchParams.get("code");
      if (!code) return reply(400, "No sign-in code", "The redirect didn't carry a code. Try signing in again.");
      opts.exchange(code).then(
        (value) => {
          reply(200, "Signed in to Loom", "You can close this tab and go back to your terminal.");
          finish(null, value);
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          reply(400, "Sign-in failed", `${msg}. You can close this tab and try again.`);
          finish(err instanceof HubError ? err : new HubError(`sign-in failed: ${msg}`, 401));
        },
      );
    });
  });

  try {
    await opts.start(redirectTo);
    return await done;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  }
}

/** Open a URL in the user's browser. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the caller also prints the URL */
  }
}

/**
 * Sign in to the hosted hub with GitHub: PKCE through Supabase Auth, the
 * redirect landing on a loopback listener. Returns the new session.
 */
export async function hostedSignIn(opts: {
  supabaseUrl: string;
  publishableKey: string;
  openBrowser?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<HostedSession> {
  const sb = await newSupabase(opts.supabaseUrl, opts.publishableKey);
  try {
    return await loopbackSignIn({
      timeoutMs: opts.timeoutMs,
      start: async (redirectTo) => {
        const { data, error } = await sb.auth.signInWithOAuth({
          provider: "github",
          options: { redirectTo, skipBrowserRedirect: true },
        });
        if (error || !data?.url) throw hubErrorFrom(error as PgError, 400);
        await (opts.openBrowser ?? openInBrowser)(data.url);
      },
      exchange: async (code) => {
        const { data, error } = await sb.auth.exchangeCodeForSession(code);
        if (error || !data.session) throw new HubError(error?.message ?? "no session came back", 401);
        return toHostedSession(data.session);
      },
    });
  } finally {
    // This client only existed to sign in; the hub client takes the session from here.
    await sb.auth.stopAutoRefresh().catch(() => {});
  }
}
