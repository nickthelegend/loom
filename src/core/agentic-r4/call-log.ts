import type { EventReader } from "../eventlog.js";
import type { LoomEvent } from "../../types.js";

/** Bound each request's history scan while retaining the API's oldest-first order. */
export function recentToolCalls(log: Pick<EventReader, "list">, limit: number) {
  const calls: LoomEvent[] = [];
  let before: number | undefined;
  for (let chunk = 0; chunk < 10 && calls.length < limit; chunk++) {
    const events = log.list({ kinds: ["status"], limit: 2000, ...(before === undefined ? {} : { before }) });
    for (let i = events.length - 1; i >= 0 && calls.length < limit; i--) {
      const event = events[i]!;
      if (event.payload.state === "mcp_call") calls.push(event);
    }
    if (events.length < 2000) break;
    before = events[0]!.id;
  }
  return calls.reverse().map(e => ({ id: e.id, at: e.ts, ...e.payload }));
}
