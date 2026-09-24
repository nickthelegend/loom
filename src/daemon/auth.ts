/**
 * Daemon auth — bearer tokens + QR pairing.
 *
 * Trust model (decided in the design interview): the tailnet is the
 * boundary. The daemon binds to localhost or the Tailscale interface only;
 * Tailscale provides device auth + E2E encryption. Tokens here are the
 * second factor that makes a *device on the tailnet* a *paired client*.
 *
 * Pairing: `loom pair` mints a short-lived, single-use pairing token,
 * rendered as a QR code. The phone exchanges it (POST /api/pair/claim) for
 * a long-lived client token. Raw secrets never ride in URLs.
 */

import crypto from "node:crypto";
import type { DaemonConfig } from "../core/registry.js";
import { readDaemonConfig, writeDaemonConfig } from "../core/registry.js";

const PAIR_TTL_MS = 10 * 60 * 1000;
/** How often a device's last-used time is written to disk, at most. */
const SEEN_WRITE_MS = 10 * 60 * 1000;

interface PendingPair {
  projects?: string[];
  token: string;
  expiresAt: number;
}

export class AuthManager {
  private config: DaemonConfig;
  private pending = new Map<string, PendingPair>();
  private seenWritten = new Map<string, number>();

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  /** True for the admin token (CLI on this machine) or any paired client. */
  isAuthorized(token: string | undefined): boolean {
    if (!token) return false;
    if (timingSafeEqualStr(token, this.config.adminToken)) return true;
    const client = this.config.clients.find((c) => timingSafeEqualStr(token, c.token));
    if (client) this.touch(client.id);
    return Boolean(client);
  }

  /**
   * Note that a device was just used. Every re-pair mints a new client and
   * nothing retired the old ones — 49 "phone" entries piled up on one machine
   * with no way to tell the live one from the dead. Kept in memory on every
   * request, written through at most every ten minutes per device.
   */
  private touch(clientId: string): void {
    const now = Date.now();
    const mem = this.config.clients.find((c) => c.id === clientId);
    if (mem) mem.lastSeen = now;
    const last = this.seenWritten.get(clientId) ?? 0;
    if (now - last < SEEN_WRITE_MS) return;
    this.seenWritten.set(clientId, now);
    try {
      this.reload();
      const c = this.config.clients.find((x) => x.id === clientId);
      if (c) {
        c.lastSeen = now;
        writeDaemonConfig(this.config);
      }
    } catch {
      // a failed bookkeeping write must never fail the request it rode on
    }
  }

  isAdmin(token: string | undefined): boolean {
    return Boolean(token && timingSafeEqualStr(token, this.config.adminToken));
  }

  /** The admin token, for handing to a same-machine (loopback) caller only. */
  adminToken(): string {
    return this.config.adminToken;
  }

  /**
   * Mint a short-lived, single-use pairing token (admin only).
   *
   * `projects` scopes every client claimed from it: the phone paired for one
   * project gets that project, not the daemon. Carried on the pending entry so
   * the claimer cannot widen it — scope is chosen by the admin who mints, not
   * the device that claims.
   */
  newPairingToken(projects?: string[]): { token: string; expiresAt: number } {
    this.gc();
    const token = crypto.randomBytes(16).toString("hex");
    const entry = {
      token,
      expiresAt: Date.now() + PAIR_TTL_MS,
      ...(projects?.length ? { projects } : {}),
    };
    this.pending.set(token, entry);
    return { token: entry.token, expiresAt: entry.expiresAt };
  }

  /** Exchange a valid pairing token for a long-lived client token. */
  claim(pairingToken: string, name = "device"): { clientToken: string; clientId: string } | null {
    this.gc();
    const entry = this.pending.get(pairingToken);
    if (!entry) return null;
    this.pending.delete(pairingToken); // single use
    const client = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      token: crypto.randomBytes(32).toString("hex"),
      createdAt: Date.now(),
      ...(entry.projects?.length ? { projects: entry.projects } : {}),
    };
    // Read-modify-write: never clobber fields (pid, host, port) that the
    // daemon wrote after this manager snapshotted the config.
    this.reload();
    this.config.clients.push(client);
    writeDaemonConfig(this.config);
    return { clientToken: client.token, clientId: client.id };
  }

  revoke(clientId: string): boolean {
    this.reload();
    const before = this.config.clients.length;
    this.config.clients = this.config.clients.filter((c) => c.id !== clientId);
    if (this.config.clients.length !== before) {
      writeDaemonConfig(this.config);
      return true;
    }
    return false;
  }

  clients(): Array<{ id: string; name: string; createdAt: number; lastSeen: number | null; push: boolean }> {
    return this.config.clients.map(({ id, name, createdAt, lastSeen, pushToken }) => ({
      id,
      name,
      createdAt,
      lastSeen: lastSeen ?? null,
      push: Boolean(pushToken),
    }));
  }

  /**
   * The projects this token may touch: null = unrestricted (admin, or a client
   * paired without scope), otherwise the allow-list.
   */
  allowedProjects(token: string | undefined): string[] | null {
    if (!token || this.isAdmin(token)) return null;
    const client = this.config.clients.find((c) => timingSafeEqualStr(token, c.token));
    return client?.projects?.length ? client.projects : null;
  }

  /** Which paired client does this bearer token belong to? (admin → null) */
  clientFor(token: string | undefined): { id: string; name: string } | null {
    if (!token) return null;
    const client = this.config.clients.find((c) => timingSafeEqualStr(token, c.token));
    return client ? { id: client.id, name: client.name } : null;
  }

  /** Attach/detach a push token on a paired client (read-modify-write). */
  setPushToken(clientId: string, pushToken: string | null, platform?: string): boolean {
    this.reload();
    const client = this.config.clients.find((c) => c.id === clientId);
    if (!client) return false;
    if (pushToken) {
      client.pushToken = pushToken;
      if (platform) client.platform = platform;
    } else {
      delete client.pushToken;
      delete client.platform;
    }
    writeDaemonConfig(this.config);
    return true;
  }

  /** Re-read clients from disk (another process may have paired). */
  reload(): void {
    const fresh = readDaemonConfig();
    if (fresh) this.config = fresh;
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (v.expiresAt < now) this.pending.delete(k);
    }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1];
}
