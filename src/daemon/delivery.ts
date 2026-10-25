/** Client transport only: no persistence, Brain or harness dependencies. */
export interface ClientScope { project?: string; scope?: string[]; /** a guest's one chat (Share live) */ chat?: string }
export interface FrameConnection {
  readonly readyState: number;
  /** Bytes queued and not yet written (ws). A client this far behind is slow or gone. */
  readonly bufferedAmount?: number;
  send(frame: string, callback?: (error?: Error) => void): void;
  terminate?(): void;
}

/** Live previews of a reply being typed: the finished message is in the log, so a lagging client can miss these. */
const DISPOSABLE = new Set(["stream", "delta"]);
/** Behind by this much, a client gets no more disposable frames until it catches up. */
export const LAG_SKIP_BYTES = 1 << 20;
/** Behind by this much, it's dropped; it reconnects and replays from the log (?since=). */
export const LAG_DROP_BYTES = 16 << 20;

export type FrameAudience =
  | { kind: "project"; projectId?: string }
  | { kind: "log"; projectId?: string }
  | { kind: "admin" };

function visible(scope: ClientScope, audience: FrameAudience): boolean {
  if (audience.kind === "admin") return !scope.scope;
  const project = audience.projectId;
  if (audience.kind === "log") {
    return !scope.scope || Boolean(project && scope.scope.includes(project));
  }
  if (!project) return true; // existing daemon-wide frames
  return (!scope.project || scope.project === project) && (!scope.scope || scope.scope.includes(project));
}

/** The chat a frame belongs to: an event's (main when it names none), or the frame's own. */
export function frameChat(payload: Record<string, unknown>): string | null {
  const e = payload.event as { chat?: string } | undefined;
  if (e && typeof e === "object") return e.chat ?? "main";
  return typeof payload.chat === "string" ? payload.chat : null;
}

/** Serialize once, preserve order and isolate failed clients. The caller owns
 * connection registration and replay; this module never drops canonical events.
 */
export class ClientDelivery<T extends FrameConnection> {
  constructor(
    private readonly clients: ReadonlyMap<T, ClientScope>,
    private readonly onFailure: (client: T, error: unknown) => void = () => {},
  ) {}

  publish(payload: Record<string, unknown>, audience: FrameAudience): void {
    const frame = JSON.stringify(payload);
    const disposable = DISPOSABLE.has(String(payload.type));
    for (const [client, scope] of this.clients) {
      if (client.readyState !== 1 || !visible(scope, audience)) continue;
      // a guest sees its chat's frames and nothing else — no terminals, logs, other threads
      if (scope.chat && (audience.kind !== "project" || frameChat(payload) !== scope.chat)) continue;
      const failed = (error: unknown) => {
        try { this.onFailure(client, error); } catch { /* diagnostics cannot break delivery */ }
      };
      // A sleeping laptop or a phone that lost its network keeps its socket
      // for minutes; everything sent piles up in its buffer meanwhile.
      const lag = client.bufferedAmount ?? 0;
      if (lag > LAG_DROP_BYTES) {
        failed(new Error(`client fell ${Math.round(lag / 1048576)} MB behind; dropped (it reconnects and replays)`));
        try { client.terminate?.(); } catch { /* already gone */ }
        continue;
      }
      if (disposable && lag > LAG_SKIP_BYTES) continue;
      try {
        client.send(frame, (error) => { if (error) failed(error); });
      } catch (error) {
        failed(error);
      }
    }
  }
}
