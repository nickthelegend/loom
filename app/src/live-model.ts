/**
 * Replies as they're typed, on the phone. The daemon sends `stream` frames —
 * pieces of what an agent is writing, each with its offset in the reply — and
 * the first page of a thread carries the reply so far. This folds both into
 * one text per agent without repeating or dropping characters, whichever
 * arrives first. Pure, so it's testable in plain node.
 */

export type StreamFrame = { agentId: string; text: string; reasoning?: boolean; off?: number };
export type LiveSnapshot = { agentId: string; chat: string; text: string; think?: string };
/** `base`: where `text` starts in the reply (0 once the start is known). */
export type LiveOne = { text: string; base: number; thinking: boolean };
export type LiveMap = Record<string, LiveOne>;

const TERMINAL = new Set(["run_complete", "error", "needs_input"]);

export function applyStream(m: LiveMap, f: StreamFrame): LiveMap {
  if (!f.agentId || !f.text) return m;
  const cur = m[f.agentId];
  if (f.reasoning) return { ...m, [f.agentId]: { text: cur?.text ?? "", base: cur?.base ?? 0, thinking: true } };
  const off = typeof f.off === "number" ? f.off : undefined;
  if (!cur || !cur.text) return { ...m, [f.agentId]: { text: f.text, base: off ?? 0, thinking: false } };
  const end = cur.base + cur.text.length;
  let text: string;
  if (off === undefined) text = cur.text + f.text;
  else if (off + f.text.length <= end) return m; // already have it
  else if (off <= end) text = cur.text + f.text.slice(end - off);
  else text = cur.text + f.text; // a gap: better a missing word than a stall
  return { ...m, [f.agentId]: { text, base: cur.base, thinking: false } };
}

/** The reply so far, from the thread's first page, merged with what already came in. */
export function seed(m: LiveMap, snap: LiveSnapshot[] | undefined, chat: string): LiveMap {
  let out = m;
  for (const s of snap ?? []) {
    if (!s?.agentId || (s.chat || "main") !== chat || !(s.text || s.think)) continue;
    const cur = out[s.agentId];
    let text = s.text;
    if (cur?.text && cur.base <= s.text.length) text = s.text + cur.text.slice(s.text.length - cur.base);
    else if (cur?.text) text = s.text + cur.text;
    out = { ...out, [s.agentId]: { text, base: 0, thinking: !s.text && !!s.think } };
  }
  return out;
}

/** A finished message replaces its typing; a turn's end drops it. */
export function applyEvent(
  m: LiveMap,
  ev: { kind: string; agentId?: string; payload?: Record<string, unknown> },
): LiveMap {
  const id = ev.agentId;
  if (!id || !m[id]) return m;
  const p = ev.payload ?? {};
  const ends =
    TERMINAL.has(ev.kind) ||
    (ev.kind === "status" && (p.state === "interrupted" || p.state === "stopped")) ||
    (ev.kind === "message" && !p.reasoning);
  if (ends) {
    const { [id]: _gone, ...rest } = m;
    return rest;
  }
  if (ev.kind === "message") return { ...m, [id]: { ...m[id]!, thinking: false } };
  return m;
}
