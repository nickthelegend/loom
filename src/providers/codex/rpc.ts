/**
 * A minimal client for `codex app-server`: newline-delimited JSON-RPC over the
 * child's stdio. Requests carry `{ id, method, params }`, notifications omit
 * `id`, and the server may send its own requests (approvals) that expect a
 * response. Field shapes follow the bindings `codex app-server generate-ts`
 * emits; only what the adapter reads is typed here.
 */

import type { ChildProcess } from "node:child_process";
import readline from "node:readline";

export type Json = Record<string, unknown>;
export interface RpcError extends Error { code?: number; data?: unknown }

type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };

export class CodexRpc {
  private seq = 0;
  private readonly pending = new Map<number | string, Pending>();
  private readonly responses = new Set<Promise<void>>();
  private closedError: Error | null = null;
  private readonly lines: readline.Interface;

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: {
      notification: (method: string, params: Json) => void;
      /** A server request; the resolved value is the JSON-RPC result. */
      request: (method: string, params: Json) => Promise<Json>;
    },
  ) {
    this.lines = readline.createInterface({ input: child.stdout! });
    this.lines.on("line", line => this.receive(line));
  }

  request(method: string, params: Json, timeoutMs = 60_000): Promise<Json> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.seq;
    return new Promise<Json>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, ...(timer ? { timer } : {}) });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Write replies to server requests settled by the caller before a later
   * request (such as interruption) can overtake those replies on stdin. */
  async flushServerResponses(): Promise<void> {
    await Promise.allSettled([...this.responses]);
  }

  /** Fail every outstanding request; later calls reject with the same error. */
  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.lines.close();
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(error); this.pending.delete(id); }
  }

  private write(message: Json): void {
    if (this.closedError || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (this.closedError) return; // a closed stream imports nothing more
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return; // log noise on stdout is not protocol
    let message: Json;
    try { message = JSON.parse(trimmed) as Json; } catch { return; }
    const id = message.id as number | string | undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method && id !== undefined) {
      // A server request: always answer, even when the handler fails, or the
      // turn waits forever on a response nobody will send.
      const response = this.handlers.request(method, (message.params ?? {}) as Json).then(
        result => this.write({ id, result }),
        (error: Error) => this.write({ id, error: { code: -32000, message: error.message } }),
      );
      this.responses.add(response);
      void response.then(() => this.responses.delete(response), () => this.responses.delete(response));
      return;
    }
    if (method) { this.handlers.notification(method, (message.params ?? {}) as Json); return; }
    if (id === undefined) return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    if (message.error) {
      const e = message.error as { message?: string; code?: number; data?: unknown };
      const error: RpcError = Object.assign(new Error(String(e.message ?? "codex app-server error")),
        { ...(e.code !== undefined ? { code: e.code } : {}), ...(e.data !== undefined ? { data: e.data } : {}) });
      waiting.reject(error);
    } else waiting.resolve((message.result ?? {}) as Json);
  }
}
