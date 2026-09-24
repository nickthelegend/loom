/**
 * Loom Cloud — the daemon end of the relay.
 *
 * Tailscale reaches your machine when the phone is on your tailnet. Loom Cloud
 * reaches it from anywhere: the daemon joins a Supabase Realtime channel and
 * answers encrypted requests that arrive there. See core/relay-protocol.ts for
 * the wire format and why Supabase never sees plaintext.
 *
 * The bridge is deliberately dumb. It does not re-implement the API — each
 * relayed request becomes a real HTTP call against this daemon on loopback,
 * carrying the phone's own bearer token, and each live stream is a real /ws
 * connection opened with that token. So pairing, scopes, admin-only routes and
 * every future endpoint behave identically over the relay and over the LAN.
 */

import { hostedTarget } from "../core/hosted.js";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

import { loomHome } from "../core/registry.js";
import { logbook } from "../core/logbook.js";
import {
  encodeMessage,
  fromB64,
  newRelayCredentials,
  RelayDecoder,
  relayTopic,
  type RelayCredentials,
  type RelayEnvelope,
  type RelayMessage,
  type RelayTransport,
} from "../core/relay-protocol.js";

// ---------------------------------------------------------------------------
// Settings (~/.loom/cloud.json, 0600)
// ---------------------------------------------------------------------------

export interface CloudSettings {
  enabled: boolean;
  channel?: string;
  key?: string;
  /** Supabase project; env LOOM_SUPABASE_URL / LOOM_SUPABASE_ANON_KEY win. */
  supabaseUrl?: string;
  anonKey?: string;
}

function cloudFile(): string {
  return path.join(loomHome(), "cloud.json");
}

export function readCloudSettings(): CloudSettings {
  try {
    return JSON.parse(fs.readFileSync(cloudFile(), "utf8")) as CloudSettings;
  } catch {
    return { enabled: false };
  }
}

export function writeCloudSettings(s: CloudSettings): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(cloudFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** The Supabase project in effect: env first, then saved settings. */
export function supabaseTarget(s: CloudSettings = readCloudSettings()): { url: string; anonKey: string } | null {
  // Your own project when you've named one; otherwise Loom's hosted project —
  // the same one the Team Hub uses. Asking every user to paste a Supabase URL
  // and key before "reach this computer from your phone" works made the one
  // switch a setup chore. The relay only ever carries ciphertext either way.
  const hosted = hostedTarget();
  const url = process.env.LOOM_SUPABASE_URL || s.supabaseUrl || hosted.supabaseUrl || "";
  const anonKey = process.env.LOOM_SUPABASE_ANON_KEY || s.anonKey || (url === hosted.supabaseUrl ? hosted.publishableKey : "") || "";
  return url && anonKey ? { url, anonKey } : null;
}

export function ensureCredentials(s: CloudSettings): RelayCredentials {
  if (s.channel && s.key) return { channel: s.channel, key: s.key };
  const c = newRelayCredentials();
  s.channel = c.channel;
  s.key = c.key;
  return c;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Supabase Realtime broadcast — the production transport. */
export async function supabaseTransport(url: string, anonKey: string, channel: string): Promise<RelayTransport> {
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 40 } },
  });
  const ch = client.channel(relayTopic(channel), { config: { broadcast: { self: false, ack: false } } });
  const listeners: Array<(env: unknown) => void> = [];
  ch.on("broadcast", { event: "e" }, (msg: { payload?: unknown }) => {
    for (const l of listeners) l(msg.payload);
  });
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ch.subscribe((status: string, err?: Error) => {
    if (status === "SUBSCRIBED") resolveReady();
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      rejectReady(err ?? new Error(`realtime ${status.toLowerCase()}`));
      logbook.warn("cloud", `relay channel ${status.toLowerCase()} — retrying`, err?.message);
    }
  });
  return {
    async send(env) {
      await ch.send({ type: "broadcast", event: "e", payload: env });
    },
    onEnvelope(cb) {
      listeners.push(cb);
    },
    ready: () => ready,
    async close() {
      await client.removeChannel(ch).catch(() => {});
      client.realtime.disconnect();
    },
  };
}

/**
 * An in-process broadcast bus with Supabase's semantics (everyone but the
 * sender receives, asynchronously, JSON round-tripped). For tests and demos.
 */
export class MemoryRelayBus {
  private members = new Set<(env: unknown) => void>();
  /** Every envelope that crossed the bus, as the relay operator would see it. */
  readonly wire: unknown[] = [];

  connect(): RelayTransport {
    const listeners: Array<(env: unknown) => void> = [];
    const self = (env: unknown) => listeners.forEach((l) => l(env));
    this.members.add(self);
    return {
      send: async (env) => {
        const copy = JSON.parse(JSON.stringify(env));
        this.wire.push(copy);
        for (const m of this.members) if (m !== self) setTimeout(() => m(copy), 0);
      },
      onEnvelope: (cb) => void listeners.push(cb),
      ready: async () => {},
      close: async () => void this.members.delete(self),
    };
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

const DENY = [/^\/api\/bootstrap/, /^\/api\/webhooks\//];
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_CLIENTS = 32;
const MAX_INFLIGHT = 16;
const CLIENT_IDLE_MS = 5 * 60_000;
/** How far a request's own timestamp may sit from the daemon's clock. */
const REQ_SKEW_MS = 10 * 60_000;
/** Ids are remembered for longer than any stamp could pass, so a copy is always caught one way or the other. */
const SEEN_TTL_MS = 2 * REQ_SKEW_MS + 60_000;
const SEEN_MAX = 20_000;
const FLUSH_MS = 60;
const FLUSH_BYTES = 48 * 1024;

interface ClientState {
  lastSeen: number;
  inflight: number;
  ws?: WebSocket;
  buffer: unknown[];
  bufferBytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RelayBridgeOptions {
  transport: RelayTransport;
  key: string;
  /** http://127.0.0.1:<port> — where relayed requests are executed. */
  localBase: () => string;
  identity: () => { version: string; name: string };
}

export class RelayBridge {
  private key: Uint8Array;
  private decoder: RelayDecoder;
  private clients = new Map<string, ClientState>();
  private sweeper: ReturnType<typeof setInterval>;
  private closed = false;
  /** "<client>:<request id>" → when it was first run (see RelayRequest.ts). */
  private seen = new Map<string, number>();
  stats = { requests: 0, rejected: 0, frames: 0, replayed: 0 };

  constructor(private opts: RelayBridgeOptions) {
    this.key = fromB64(opts.key);
    this.decoder = new RelayDecoder(this.key, "c");
    opts.transport.onEnvelope((env) => {
      const msg = this.decoder.push(env);
      if (msg) void this.handle(msg).catch((err) => logbook.warn("cloud", "relay message failed", String(err)));
    });
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  clientCount(): number {
    return this.clients.size;
  }

  private client(id: string): ClientState | null {
    let c = this.clients.get(id);
    if (!c) {
      if (this.clients.size >= MAX_CLIENTS) return null;
      c = { lastSeen: Date.now(), inflight: 0, buffer: [], bufferBytes: 0 };
      this.clients.set(id, c);
    }
    c.lastSeen = Date.now();
    return c;
  }

  private async send(msg: RelayMessage): Promise<void> {
    if (this.closed) return;
    for (const env of encodeMessage(this.key, "d", msg)) await this.opts.transport.send(env as RelayEnvelope);
  }

  private async handle(msg: RelayMessage): Promise<void> {
    if (msg.t === "ping") {
      if (!this.client(String(msg.from))) return;
      return this.send({ t: "pong", to: String(msg.from), ts: Number(msg.ts) || 0, daemon: this.opts.identity() });
    }
    if (msg.t === "req") return this.request(msg);
    if (msg.t === "sub") return this.subscribe(String(msg.from), String(msg.auth ?? ""), msg.project);
    if (msg.t === "unsub") return this.unsubscribe(String(msg.from));
  }

  private async request(msg: Extract<RelayMessage, { t: "req" }>): Promise<void> {
    const from = String(msg.from);
    const c = this.client(from);
    const reply = (status: number, body: unknown) => this.send({ t: "res", id: String(msg.id), to: from, status, body });
    if (!c) return reply(503, { error: "too many relay clients" });
    // A request seen before is a copy, not a retry (a retry gets a fresh id):
    // drop it without an answer, which the real client already had.
    const now = Date.now();
    const key = `${from}:${String(msg.id)}`;
    if (this.seen.has(key)) {
      this.stats.replayed++;
      return;
    }
    if (typeof msg.ts === "number" && Math.abs(now - msg.ts) > REQ_SKEW_MS) {
      this.stats.rejected++;
      const mins = Math.round((now - msg.ts) / 60_000);
      return reply(408, { error: `this request is stamped ${Math.abs(mins)} min ${mins > 0 ? "ago" : "ahead"} — check the phone's clock` });
    }
    this.seen.set(key, now);
    if (this.seen.size > SEEN_MAX) this.forgetSeen(now, true);
    const method = String(msg.method || "GET").toUpperCase();
    const p = String(msg.path || "");
    if (!p.startsWith("/api/") || p.includes("..") || DENY.some((re) => re.test(p)) || !METHODS.has(method)) {
      this.stats.rejected++;
      return reply(403, { error: "not relayable" });
    }
    if (c.inflight >= MAX_INFLIGHT) return reply(429, { error: "too many requests in flight" });
    c.inflight++;
    this.stats.requests++;
    try {
      const res = await fetch(this.opts.localBase() + p, {
        method,
        headers: {
          ...(msg.auth ? { authorization: String(msg.auth) } : {}),
          ...(msg.body !== undefined ? { "content-type": "application/json" } : {}),
          "x-loom-via": "relay",
        },
        ...(msg.body !== undefined && method !== "GET" ? { body: JSON.stringify(msg.body) } : {}),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON bodies ride as text */
      }
      await reply(res.status, body);
    } catch (err) {
      await reply(502, { error: `daemon unreachable: ${(err as Error).message}` });
    } finally {
      c.inflight--;
    }
  }

  private forgetSeen(now: number, force = false): void {
    for (const [k, at] of this.seen) {
      if (now - at > SEEN_TTL_MS) this.seen.delete(k);
    }
    // still full of fresh ids (a flood): drop the oldest half rather than grow
    if (force && this.seen.size > SEEN_MAX) {
      let n = Math.floor(this.seen.size / 2);
      for (const k of this.seen.keys()) {
        if (n-- <= 0) break;
        this.seen.delete(k);
      }
    }
  }

  private subscribe(from: string, auth: string, project?: string): void {
    const c = this.client(from);
    if (!c) return;
    this.unsubscribe(from, false);
    const token = auth.replace(/^Bearer\s+/i, "");
    const url = this.opts.localBase().replace(/^http/, "ws") + "/ws" + (project ? `?project=${encodeURIComponent(project)}` : "");
    const ws = new WebSocket(url, [`loom.bearer.${token}`], { headers: { "x-loom-via": "relay" } });
    c.ws = ws;
    ws.on("open", () => void this.send({ t: "stream", to: from, open: true }));
    ws.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      // Terminal output is a firehose; it stays on direct connections.
      if ((frame as { type?: string }).type === "term") return;
      this.stats.frames++;
      c.buffer.push(frame);
      c.bufferBytes += (data as Buffer).length ?? 0;
      if (c.bufferBytes >= FLUSH_BYTES) this.flush(from);
      else c.timer ??= setTimeout(() => this.flush(from), FLUSH_MS);
    });
    ws.on("close", (code) => {
      if (c.ws !== ws) return;
      this.flush(from);
      c.ws = undefined;
      void this.send({ t: "stream", to: from, open: false, code });
    });
    ws.on("error", () => {});
  }

  private flush(from: string): void {
    const c = this.clients.get(from);
    if (!c) return;
    if (c.timer) clearTimeout(c.timer);
    c.timer = undefined;
    if (!c.buffer.length) return;
    const frames = c.buffer;
    c.buffer = [];
    c.bufferBytes = 0;
    void this.send({ t: "evs", to: from, frames });
  }

  private unsubscribe(from: string, forget = true): void {
    const c = this.clients.get(from);
    if (!c) return;
    const ws = c.ws;
    c.ws = undefined;
    ws?.close();
    if (forget && !c.inflight) {
      if (c.timer) clearTimeout(c.timer);
      this.clients.delete(from);
    }
  }

  /** A phone that stopped pinging is gone; don't hold a socket open for it. */
  private sweep(): void {
    const cutoff = Date.now() - CLIENT_IDLE_MS;
    for (const [id, c] of this.clients) if (c.lastSeen < cutoff) this.unsubscribe(id);
    this.forgetSeen(Date.now());
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const id of [...this.clients.keys()]) this.unsubscribe(id);
    await this.opts.transport.close();
  }
}
