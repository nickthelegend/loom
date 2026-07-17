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

interface PendingPair {
  token: string;
  expiresAt: number;
}

export class AuthManager {
  private config: DaemonConfig;
  private pending = new Map<string, PendingPair>();

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  /** True for the admin token (CLI on this machine) or any paired client. */
  isAuthorized(token: string | undefined): boolean {
    if (!token) return false;
    if (timingSafeEqualStr(token, this.config.adminToken)) return true;
    return this.config.clients.some((c) => timingSafeEqualStr(token, c.token));
  }

  isAdmin(token: string | undefined): boolean {
    return Boolean(token && timingSafeEqualStr(token, this.config.adminToken));
  }

  /** The admin token, for handing to a same-machine (loopback) caller only. */
  adminToken(): string {
    return this.config.adminToken;
  }

  /** Mint a short-lived, single-use pairing token (admin only). */
  newPairingToken(): { token: string; expiresAt: number } {
    this.gc();
    const token = crypto.randomBytes(16).toString("hex");
    const entry = { token, expiresAt: Date.now() + PAIR_TTL_MS };
    this.pending.set(token, entry);
    return entry;
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

  clients(): Array<{ id: string; name: string; createdAt: number; push: boolean }> {
    return this.config.clients.map(({ id, name, createdAt, pushToken }) => ({
      id,
      name,
      createdAt,
      push: Boolean(pushToken),
    }));
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
