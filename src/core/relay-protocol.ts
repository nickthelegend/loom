/**
 * Loom Cloud relay — the wire format.
 *
 * Reaching your daemon from a phone on another network without a VPN: both
 * ends join one Supabase Realtime broadcast channel and pass encrypted
 * envelopes through it. The daemon turns each request into an ordinary local
 * HTTP call (or WebSocket) against itself, with the phone's own paired token,
 * so every auth and scope rule is the one the LAN path already enforces.
 *
 * **Supabase sees only ciphertext.** The channel name and the 32-byte key are
 * minted by the daemon and travel only inside the pairing QR / link fragment.
 * Every envelope is XChaCha20-Poly1305 with a fresh random nonce; a message
 * that doesn't authenticate is dropped. The relay can't read your code, your
 * prompts or your tokens, and it can't forge a request.
 *
 * Pattern credits: the pairing token rides the URL *fragment* (never sent to a
 * server) and clients resume a stream from a sequence number — both from
 * T3 Code (github.com/pingdotgg/t3code, MIT).
 *
 * This file is dependency-light on purpose (only @noble/ciphers): the Expo app
 * carries a copy (app/src/relay-protocol.ts) and the two must stay in step.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";

export const RELAY_PROTOCOL = 1;
/** Supabase's default broadcast payload cap is 256 KB; stay well under after base64. */
export const MAX_CHUNK = 96 * 1024;

/** A request from a client, executed by the daemon against itself. */
export interface RelayRequest {
  t: "req";
  id: string;
  from: string; // client id (random per app install)
  method: string;
  path: string; // must start with /api/
  auth?: string; // "Bearer <token>"
  body?: unknown;
  /**
   * When the client sent it (ms). Inside the sealed envelope, so nobody on the
   * relay can change it: the daemon refuses a request stamped too far from
   * now, and remembers the ids it has run — a captured request can't be sent
   * again. Absent from clients older than this field.
   */
  ts?: number;
}

export interface RelayResponse {
  t: "res";
  id: string;
  to: string;
  status: number;
  body: unknown;
}

/** Open (or replace) a live event stream for a client — a remote WebSocket. */
export interface RelaySubscribe {
  t: "sub";
  from: string;
  auth: string;
  project?: string;
}

export interface RelayUnsubscribe {
  t: "unsub";
  from: string;
}

/** Live frames for one client, batched. Each frame is exactly a /ws frame. */
export interface RelayEvents {
  t: "evs";
  to: string;
  frames: unknown[];
}

/** Stream state for one client: open, or closed with the /ws close code. */
export interface RelayStreamState {
  t: "stream";
  to: string;
  open: boolean;
  code?: number;
}

export interface RelayPing {
  t: "ping";
  from: string;
  ts: number;
}

export interface RelayPong {
  t: "pong";
  to: string;
  ts: number;
  daemon: { version: string; name: string };
}

export type RelayMessage =
  | RelayRequest
  | RelayResponse
  | RelaySubscribe
  | RelayUnsubscribe
  | RelayEvents
  | RelayStreamState
  | RelayPing
  | RelayPong;

/** What actually crosses Supabase. `p` is set when a message spans parts. */
export interface RelayEnvelope {
  v: number;
  /** direction: c = client→daemon, d = daemon→client. Each side ignores its own. */
  d: "c" | "d";
  /** base64 of nonce‖ciphertext */
  x: string;
  /** multipart: [messageId, index, count] */
  p?: [string, number, number];
}

// ---------------------------------------------------------------------------
// base64url without Buffer (the phone has none)
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toB64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
  }
  return out;
}

export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("bad base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Keys and envelopes
// ---------------------------------------------------------------------------

export interface RelayCredentials {
  /** Channel id — also unguessable, but secrecy rests on the key. */
  channel: string;
  /** 32-byte key, base64url. */
  key: string;
}

export function newRelayCredentials(): RelayCredentials {
  return { channel: toB64(randomBytes(16)), key: toB64(randomBytes(32)) };
}

/** The Supabase channel topic for a credential set. */
export function relayTopic(channel: string): string {
  return `loom-relay:${channel}`;
}

/** `channel.key` — the compact form carried in a pairing link. */
export function packCredentials(c: RelayCredentials): string {
  return `${c.channel}.${c.key}`;
}

export function unpackCredentials(s: string): RelayCredentials | null {
  const [channel, key] = s.split(".");
  if (!channel || !key) return null;
  try {
    if (fromB64(key).length !== 32) return null;
  } catch {
    return null;
  }
  return { channel, key };
}

export function seal(key: Uint8Array, plaintext: Uint8Array): string {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return toB64(out);
}

/** Null when the envelope doesn't authenticate — never throws on hostile input. */
export function open(key: Uint8Array, sealed: string): Uint8Array | null {
  try {
    const raw = fromB64(sealed);
    if (raw.length < 24 + 16) return null;
    return xchacha20poly1305(key, raw.slice(0, 24)).decrypt(raw.slice(24));
  } catch {
    return null;
  }
}

/** Encode a message into one or more envelopes (split when large). */
export function encodeMessage(key: Uint8Array, dir: "c" | "d", msg: RelayMessage): RelayEnvelope[] {
  const bytes = enc.encode(JSON.stringify(msg));
  if (bytes.length <= MAX_CHUNK) return [{ v: RELAY_PROTOCOL, d: dir, x: seal(key, bytes) }];
  const id = toB64(randomBytes(9));
  const count = Math.ceil(bytes.length / MAX_CHUNK);
  const out: RelayEnvelope[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      v: RELAY_PROTOCOL,
      d: dir,
      x: seal(key, bytes.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)),
      p: [id, i, count],
    });
  }
  return out;
}

/**
 * Reassembles multipart messages and decrypts. Feed every envelope from the
 * other side; it yields each complete message once.
 */
export class RelayDecoder {
  private parts = new Map<string, { chunks: (Uint8Array | undefined)[]; at: number }>();
  constructor(
    private key: Uint8Array,
    /** Which direction this side reads: the daemon reads "c", the client "d". */
    private reads: "c" | "d",
  ) {}

  push(env: unknown): RelayMessage | null {
    if (!env || typeof env !== "object") return null;
    const e = env as RelayEnvelope;
    if (e.v !== RELAY_PROTOCOL || e.d !== this.reads || typeof e.x !== "string") return null;
    const plain = open(this.key, e.x);
    if (!plain) return null;
    let bytes = plain;
    if (e.p) {
      const [id, index, count] = e.p;
      if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 512 || index < 0 || index >= count) {
        return null;
      }
      const entry = this.parts.get(id) ?? { chunks: new Array(count).fill(undefined), at: Date.now() };
      entry.chunks[index] = plain;
      this.parts.set(id, entry);
      this.gc();
      if (entry.chunks.some((c) => !c)) return null;
      this.parts.delete(id);
      const total = entry.chunks.reduce((n, c) => n + c!.length, 0);
      bytes = new Uint8Array(total);
      let o = 0;
      for (const c of entry.chunks) {
        bytes.set(c!, o);
        o += c!.length;
      }
    }
    try {
      const msg = JSON.parse(dec.decode(bytes)) as RelayMessage;
      return msg && typeof msg === "object" && typeof msg.t === "string" ? msg : null;
    } catch {
      return null;
    }
  }

  private gc(): void {
    const cutoff = Date.now() - 60_000;
    for (const [id, e] of this.parts) if (e.at < cutoff) this.parts.delete(id);
  }
}

/** Where envelopes go: Supabase in production, an in-memory bus in tests. */
export interface RelayTransport {
  send(env: RelayEnvelope): Promise<void>;
  onEnvelope(cb: (env: unknown) => void): void;
  /** Resolves once the transport is joined and can send. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
