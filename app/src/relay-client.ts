// COPY of src/core/relay-client.ts — the Loom Cloud client, shared with the
// daemon's tests and CLI. Keep this file in step with the original: only this
// header and import paths may differ (app/scripts/check-relay-copies.mjs
// enforces that).

/**
 * Loom Cloud — the client end of the relay (phone, CLI, tests).
 *
 * Gives a remote client the two things a direct connection gives it: `request`
 * (an HTTP call to the daemon) and `stream` (the /ws event feed), carried as
 * encrypted envelopes over a broadcast transport. Dependency-free apart from
 * relay-protocol.ts, so the Expo app runs this exact file (app/src/relay-client.ts
 * is a copy — keep them in step).
 *
 * Reconnection follows T3 Code's connection supervisor (github.com/pingdotgg/
 * t3code, MIT): capped backoff, a liveness ping, and a forced fresh stream
 * after the app has been in the background — mobile OSes kill sockets without
 * telling anyone.
 */

import {
  encodeMessage,
  fromB64,
  RelayDecoder,
  toB64,
  type RelayCredentials,
  type RelayMessage,
  type RelayTransport,
} from "./relay-protocol";

export interface RelayResult {
  status: number;
  body: unknown;
}

export interface StreamHandlers {
  onFrame: (frame: unknown) => void;
  onState?: (open: boolean, code?: number) => void;
}

const RETRY_MS = [1000, 3000, 8000, 16000];

function randomId(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return toB64(b);
}

export class RelayClient {
  readonly id: string;
  private key: Uint8Array;
  private decoder: RelayDecoder;
  private pending = new Map<string, { resolve: (r: RelayResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private pongs = new Map<number, (ms: number) => void>();
  private stream: { auth: string; project?: string; handlers: StreamHandlers; attempt: number } | null = null;
  private streamOpen = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  daemon: { version: string; name: string } | null = null;

  constructor(
    private transport: RelayTransport,
    creds: RelayCredentials,
    opts: { clientId?: string } = {},
  ) {
    this.id = opts.clientId ?? randomId();
    this.key = fromB64(creds.key);
    this.decoder = new RelayDecoder(this.key, "d");
    transport.onEnvelope((env) => {
      const msg = this.decoder.push(env);
      if (msg) this.handle(msg);
    });
  }

  private async send(msg: RelayMessage): Promise<void> {
    for (const env of encodeMessage(this.key, "c", msg)) await this.transport.send(env);
  }

  private handle(msg: RelayMessage): void {
    if (msg.t === "res" && msg.to === this.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve({ status: msg.status, body: msg.body });
    } else if (msg.t === "pong" && msg.to === this.id) {
      this.daemon = msg.daemon;
      const cb = this.pongs.get(msg.ts);
      this.pongs.delete(msg.ts);
      cb?.(Date.now() - msg.ts);
    } else if (msg.t === "evs" && msg.to === this.id) {
      for (const f of msg.frames) this.stream?.handlers.onFrame(f);
    } else if (msg.t === "stream" && msg.to === this.id) {
      this.streamOpen = msg.open;
      this.stream?.handlers.onState?.(msg.open, msg.code);
      if (msg.open && this.stream) this.stream.attempt = 0;
      // 4401 = the token was refused: retrying would only be refused again.
      if (!msg.open && this.stream && msg.code !== 4401 && !this.closed) this.scheduleResubscribe();
    }
  }

  /** An HTTP call to the daemon, through the relay. */
  request(method: string, path: string, opts: { auth?: string; body?: unknown; timeoutMs?: number } = {}): Promise<RelayResult> {
    const id = randomId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 504, body: { error: "the daemon did not answer through Loom Cloud — is it running?" } });
      }, opts.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, timer });
      void this.send({
        t: "req",
        id,
        from: this.id,
        method,
        path,
        ...(opts.auth ? { auth: opts.auth } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ status: 503, body: { error: `relay send failed: ${(err as Error).message}` } });
      });
    });
  }

  /** Round-trip time to the daemon in ms, or null when it doesn't answer. */
  ping(timeoutMs = 8000): Promise<number | null> {
    const ts = Date.now() + Math.random();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pongs.delete(ts);
        resolve(null);
      }, timeoutMs);
      this.pongs.set(ts, (ms) => {
        clearTimeout(timer);
        resolve(ms);
      });
      void this.send({ t: "ping", from: this.id, ts }).catch(() => resolve(null));
    });
  }

  /** Open the live event feed (the /ws frames). Replaces any previous one. */
  openStream(auth: string, handlers: StreamHandlers, project?: string): void {
    this.stream = { auth, handlers, attempt: 0, ...(project ? { project } : {}) };
    void this.resubscribe();
  }

  /** Force a fresh stream — call when the app returns to the foreground. */
  refresh(): void {
    if (this.stream) void this.resubscribe();
  }

  isStreaming(): boolean {
    return this.streamOpen;
  }

  closeStream(): void {
    this.stream = null;
    this.streamOpen = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.send({ t: "unsub", from: this.id }).catch(() => {});
  }

  private async resubscribe(): Promise<void> {
    if (!this.stream || this.closed) return;
    await this.send({
      t: "sub",
      from: this.id,
      auth: this.stream.auth,
      ...(this.stream.project ? { project: this.stream.project } : {}),
    }).catch(() => this.scheduleResubscribe());
  }

  private scheduleResubscribe(): void {
    if (!this.stream || this.retryTimer) return;
    const delay = RETRY_MS[Math.min(this.stream.attempt, RETRY_MS.length - 1)]!;
    this.stream.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.resubscribe();
    }, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await this.transport.close();
  }
}

/** Parse the cloud part of a pairing link fragment (`relay=…&sb=…&sbk=…`). */
export function parseCloudFragment(fragment: string): { relay: string; supabaseUrl: string; anonKey: string } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const relay = params.get("relay");
  const sb = params.get("sb");
  const sbk = params.get("sbk");
  if (!relay || !sb || !sbk) return null;
  const dec = new TextDecoder();
  try {
    return { relay, supabaseUrl: dec.decode(fromB64(sb)), anonKey: dec.decode(fromB64(sbk)) };
  } catch {
    return null;
  }
}
