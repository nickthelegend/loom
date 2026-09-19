/**
 * HttpHubClient — a daemon's (or phone's) connection to a `loom hub` server.
 * Same `HubClient` contract as the in-memory and Supabase hubs, so Team Link
 * never knows which one it's talking to.
 */

import WebSocket from "ws";

import {
  HubError,
  type ClaimResult,
  type FeedIn,
  type HubClient,
  type HubEvent,
  type Lease,
  type LeaseClaim,
  type PresenceIn,
  type TeamMemory,
  type TeamMemoryIn,
} from "../core/team-hub.js";
import type { Sealed } from "../core/team-crypto.js";
import type { LeaseScope } from "../core/team-leases.js";

export async function hubSignIn(
  baseUrl: string,
  github: string,
  opts: { name?: string; secret?: string } = {},
): Promise<{ token: string; user: { id: string; github: string; name: string } }> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/hub/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ github, ...opts }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { token?: string; user?: never; error?: string };
  if (!res.ok || !body.token) throw new HubError(body.error ?? `hub sign-in failed (${res.status})`, res.status);
  return body as unknown as { token: string; user: { id: string; github: string; name: string } };
}

export class HttpHubClient implements HubClient {
  private base: string;
  constructor(
    baseUrl: string,
    private token: string,
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(`${this.base}/hub/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok) throw new HubError(body.error ?? `hub ${method} failed (${res.status})`, res.status);
    return body.result as T;
  }

  me() {
    return this.call<Awaited<ReturnType<HubClient["me"]>>>("me");
  }
  createTeam(name: string) {
    return this.call<Awaited<ReturnType<HubClient["createTeam"]>>>("createTeam", name);
  }
  teams() {
    return this.call<Awaited<ReturnType<HubClient["teams"]>>>("teams");
  }
  registerDevice(input: { label: string; sealPub: string; signPub: string }) {
    return this.call<Awaited<ReturnType<HubClient["registerDevice"]>>>("registerDevice", input);
  }
  createInvite(teamId: string, ttlMs?: number) {
    // An omitted ttl must stay omitted: JSON turns undefined into null, and
    // null clamped to the 1-minute floor made every invite die in a minute.
    return this.call<{ invite: string; expiresAt: number }>("createInvite", teamId, ...(ttlMs === undefined ? [] : [ttlMs]));
  }
  redeemInvite(invite: string) {
    return this.call<Awaited<ReturnType<HubClient["redeemInvite"]>>>("redeemInvite", invite);
  }
  members(teamId: string) {
    return this.call<Awaited<ReturnType<HubClient["members"]>>>("members", teamId);
  }
  removeMember(teamId: string, userId: string) {
    return this.call<void>("removeMember", teamId, userId);
  }
  putKeyEnvelopes(teamId: string, version: number, envelopes: Array<{ deviceId: string; box: string }>) {
    return this.call<void>("putKeyEnvelopes", teamId, version, envelopes);
  }
  keyEnvelopes(teamId: string, deviceId: string) {
    return this.call<Array<{ version: number; box: string }>>("keyEnvelopes", teamId, deviceId);
  }
  shareRepo(teamId: string, repo: string) {
    return this.call<void>("shareRepo", teamId, repo);
  }
  repos(teamId: string) {
    return this.call<string[]>("repos", teamId);
  }
  heartbeat(teamId: string, p: PresenceIn) {
    return this.call<void>("heartbeat", teamId, p);
  }
  clearPresence(teamId: string, key: { deviceId: string; agent: string; repo: string }) {
    return this.call<void>("clearPresence", teamId, key);
  }
  presence(teamId: string) {
    return this.call<Awaited<ReturnType<HubClient["presence"]>>>("presence", teamId);
  }
  appendFeed(teamId: string, e: FeedIn) {
    return this.call<Awaited<ReturnType<HubClient["appendFeed"]>>>("appendFeed", teamId, e);
  }
  feed(teamId: string, opts?: { since?: number; limit?: number }) {
    return this.call<Awaited<ReturnType<HubClient["feed"]>>>("feed", teamId, opts ?? {});
  }

  claimLease(teamId: string, c: LeaseClaim) {
    return this.call<ClaimResult>("claimLease", teamId, c);
  }
  extendLease(teamId: string, leaseId: string, scope: LeaseScope, hardZones: string[]) {
    return this.call<ClaimResult>("extendLease", teamId, leaseId, scope, hardZones);
  }
  renewLeases(teamId: string, deviceId: string) {
    return this.call<number>("renewLeases", teamId, deviceId);
  }
  setRunLeaseState(teamId: string, runId: string, state: "active" | "landing") {
    return this.call<number>("setRunLeaseState", teamId, runId, state);
  }
  releaseLeases(teamId: string, runId: string, reason: string) {
    return this.call<number>("releaseLeases", teamId, runId, reason);
  }
  leases(teamId: string, repo?: string) {
    return this.call<Lease[]>("leases", teamId, ...(repo === undefined ? [] : [repo]));
  }

  publishMemory(teamId: string, m: TeamMemoryIn) {
    return this.call<{ memory: TeamMemory; merged: boolean }>("publishMemory", teamId, m);
  }
  updateTeamMemory(teamId: string, id: string, patch: { hmac: string; sealed: Sealed }) {
    return this.call<TeamMemory>("updateTeamMemory", teamId, id, patch);
  }
  forgetTeamMemory(teamId: string, id: string, reason: string) {
    return this.call<void>("forgetTeamMemory", teamId, id, reason);
  }
  resolveMemories(teamId: string, winnerId: string, loserId: string, reason: string) {
    return this.call<TeamMemory>("resolveMemories", teamId, winnerId, loserId, reason);
  }
  teamMemories(teamId: string, repo: string, opts?: { history?: boolean }) {
    return this.call<TeamMemory[]>("teamMemories", teamId, repo, opts ?? {});
  }

  /**
   * Live events. Reconnects with capped backoff (the relay's supervisor
   * pattern) until unsubscribed; a 4401/4403 close means "you're not allowed",
   * which retrying won't fix, so it stops.
   */
  async subscribe(teamId: string, cb: (e: HubEvent) => void): Promise<() => void> {
    let closed = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    const url = `${this.base.replace(/^http/, "ws")}/hub/subscribe?team=${encodeURIComponent(teamId)}`;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url, [`loom.hub.${this.token}`]);
      ws.on("message", (data) => {
        try {
          const e = JSON.parse(String(data)) as HubEvent | { type: "ready" };
          if (e.type === "ready") attempt = 0;
          else cb(e as HubEvent);
        } catch {
          /* ignore */
        }
      });
      ws.on("close", (code) => {
        if (closed || code === 4401 || code === 4403) return;
        const delay = [1000, 3000, 8000, 16000][Math.min(attempt++, 3)]!;
        setTimeout(connect, delay).unref?.();
      });
      ws.on("error", () => {});
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }
}
