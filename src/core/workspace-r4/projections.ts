import type { LoomEvent } from "../../types.js";

export interface InboxItem {
  id: string; kind: "approval" | "question" | "failed" | "paused";
  project: string; projectName: string; chat: string; title: string; at: number;
  agent?: string; eventId?: number; approvalId?: string; runId?: string; requestId?: string;
  crewId?: string; action?: string;
  questions?: Array<{ id: string; question: string }>;
}
/** Clear questions when answered or superseded, without losing unresolved failures on restart. */
export class EventInbox {
  private pending = new Map<string, Omit<InboxItem, "project" | "projectName">>();
  private failures = new Map<string, Omit<InboxItem, "project" | "projectName">>();
  update(e: LoomEvent) {
    const { pending, failures } = this;
    const p = e.payload, chat = e.chat ?? "main", key = chat + ":" + (e.agentId ?? "");
    if (e.kind === "needs_input") {
      const structured = typeof p.requestId === "string" && p.responseMode !== "message";
      // Engines promote plain worker questions to their paused-run state; those rows own the reply.
      if (!structured && (p.orchestra || p.crew)) return;
      const qs = Array.isArray(p.questions) ? p.questions as Array<Record<string, unknown>> : [];
      pending.set(key, { id: "question:" + e.id, kind: "question", chat, agent: typeof p.askAgent === "string" ? p.askAgent : e.agentId, eventId: e.id, at: e.ts,
        title: String(p.question ?? p.text ?? qs.map(q => q.question ?? q.header ?? "").join(" · ")),
        ...(structured ? { requestId: String(p.requestId), questions: qs.map((q, i) => ({ id: String(q.id ?? i), question: String(q.question ?? q.header ?? "Answer") })) } : {}) });
    } else if (e.kind === "status" && p.state === "question_answered") {
      if (pending.get(key)?.requestId === p.requestId) pending.delete(key);
    } else if ((e.kind === "run_complete" && pending.get(key)?.requestId) || e.kind === "error" || e.kind === "status" && ["turn_started", "interrupted", "stopped"].includes(String(p.state))) {
      pending.delete(key);
    } else if (e.kind === "message" && !e.agentId) {
      for (const [k, q] of pending) if (q.chat === chat && !q.requestId) pending.delete(k);
    }
    if (e.kind === "error") failures.set(key, { id: "failed:" + e.id, kind: "failed", chat, agent: e.agentId,
      eventId: e.id, at: e.ts, title: String(p.message ?? p.error ?? p.text ?? "Turn failed") });
    if (e.kind === "run_complete" || e.kind === "status" && p.state === "turn_started") failures.delete(key);
    if (e.kind === "message" && !e.agentId) for (const [k, f] of failures) if (f.chat === chat) failures.delete(k);
  }
  items(hidden: ReadonlySet<number> = new Set(), since = 0) {
    for (const map of [this.pending, this.failures]) for (const [key, item] of map) if (item.at < since) map.delete(key);
    return [...this.pending.values(), ...this.failures.values()].filter(i => !hidden.has(i.eventId!));
  }
}
export function eventInbox(events: LoomEvent[], hidden: ReadonlySet<number> | number[] = []) {
  const projection = new EventInbox();
  events.forEach(e => projection.update(e));
  return projection.items(new Set(hidden));
}
export interface ChatFile { path: string; name: string; kind: "image" | "file"; eventId: number; at: number; direction: "received" | "produced" }
export function safeRelative(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 4096 && !/^[\\/]|^[a-z][a-z\d+.-]*:/i.test(value) && !/[\x00-\x1f\\]/.test(value) && !value.split("/").includes("..");
}
/** Index actual attachment/image references, never arbitrary tool arguments or remote URLs. */
export function chatFiles(events: LoomEvent[]): ChatFile[] {
  const files = new Map<string, ChatFile>();
  for (const e of events) {
    const add = (value: unknown, image = false) => {
      if (typeof value !== "string") return;
      value = value.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
      if (!safeRelative(value) || !/\.[^./]+$/.test(value)) return;
      const key = e.id + ":" + value;
      files.set(key, { path: value, name: value.split("/").at(-1)!, kind: image || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(value) ? "image" : "file",
        eventId: e.id!, at: e.ts, direction: e.agentId ? "produced" : "received" });
    };
    const p = e.payload;
    if (e.kind === "file_edit" && typeof p.path === "string" && /\.(png|jpe?g|gif|webp|avif|svg|pdf)$/i.test(p.path)) add(p.path);
    for (const im of Array.isArray(p.images) ? p.images : []) if (im && typeof im === "object") add((im as { path?: unknown }).path, true);
    for (const f of Array.isArray(p.attachments) ? p.attachments : []) if (f && typeof f === "object") add((f as { path?: unknown }).path);
    if (e.kind === "message" && typeof p.text === "string") {
      for (const m of p.text.matchAll(/^\[(image|file)\] (.+)$/gm)) add(m[2], m[1] === "image");
      for (const m of p.text.matchAll(/(!?)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) add(m[2] ?? m[3], m[1] === "!");
    }
  }
  return [...files.values()].sort((a, b) => b.at - a.at);
}
