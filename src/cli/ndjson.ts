import type { DaemonClient } from "../daemon/client.js";
import type { LoomEvent } from "../types.js";
import { exitCodeFor, turnOutcome } from "../core/turn-wait.js";

export const writeJson = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
export interface StreamTurn { agentId: string; chat: string; requestId?: string; answered?: boolean }

/** Cursor polling replays fast turns and survives a dropped websocket without losing events. */
export async function streamTurns(client: DaemonClient, project: string, since: number, turns: StreamTurn[], timeoutMs: number, emit: (event: unknown) => void = writeJson): Promise<number> {
  const pending = turns.map(turn => ({ ...turn, start: turn.requestId && !turn.answered ? undefined : since, events: [] as LoomEvent[] }));
  const deadline = Date.now() + timeoutMs;
  let cursor = since, code = 0, stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const finish = (status: string, exit: number) => {
    for (const t of pending) emit({ type: "outcome", project, chat: t.chat, agent: t.agentId, status });
    return exit;
  };
  try {
    const pid = (await client.version()).pid;
    while (pending.length && Date.now() < deadline && !stopped) {
      const { events } = await client.events(project, cursor, 1000);
      cursor = events.at(-1)?.id ?? cursor;
      for (const t of [...pending]) {
        for (const e of events) {
          if ((e.chat ?? "main") !== t.chat) continue;
          if (t.start === undefined && e.kind === "status" && e.payload.state === "turn_started" && e.payload.requestId === t.requestId) t.start = e.id;
          if (t.start === undefined || e.id < t.start || (e.agentId && e.agentId !== t.agentId)) continue;
          t.events.push(e);
          emit({ type: "event", project, ...e });
          const interrupted = e.agentId === t.agentId && e.kind === "status" && e.payload.state === "interrupted";
          const outcome = interrupted ? { status: "interrupted" as const, agent: t.agentId } : turnOutcome(t.events, t.agentId, t.start, t.chat);
          if (outcome) {
            emit({ type: "outcome", project, chat: t.chat, ...outcome });
            code = Math.max(code, outcome.status === "interrupted" ? 75 : exitCodeFor(outcome));
            pending.splice(pending.indexOf(t), 1);
            break;
          }
        }
      }
      if (pending.length) {
        if ((await client.version()).pid !== pid) return finish("interrupted", 75);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return pending.length ? finish(stopped ? "interrupted" : "timeout", stopped ? 130 : 124) : code;
  } catch (error) {
    emit({ type: "error", message: (error as Error).message });
    return finish("interrupted", 75);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/** Buffer only the handshake-to-receipt gap; afterwards deltas flow without waiting for a log page. */
export async function captureDeltas(client: DaemonClient, project: string, emit: (event: unknown) => void = writeJson) {
  let turns: StreamTurn[] | undefined;
  const active = new Map<string, string>();
  const buffer: Array<Record<string, any>> = [];
  const deliver = (frame: Record<string, any>) => {
    const match = turns?.find(t => t.agentId === frame.agentId && t.chat === (frame.chat ?? "main") && (!t.requestId || t.requestId === frame.requestId));
    if (match) emit({ ...frame, type: "delta", project });
  };
  const close = await client.subscribeFrames(project, frame => {
    if (frame.type === "event" && frame.event?.kind === "status" && frame.event.payload.state === "turn_started") {
      active.set(`${frame.event.chat ?? "main"}:${frame.event.agentId}`, frame.event.payload.requestId);
    }
    if (frame.type !== "stream") return;
    const delta = { ...frame, requestId: active.get(`${frame.chat ?? "main"}:${frame.agentId}`) };
    if (turns) deliver(delta);
    else { buffer.push(delta); if (buffer.length > 1000) buffer.shift(); }
  });
  return { close, select(selected: StreamTurn[]) { turns = selected; for (const frame of buffer) deliver(frame); buffer.length = 0; } };
}
