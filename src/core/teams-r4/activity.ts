import type { LoomEvent } from "../../types.js";
import type { Handoff } from "./links.js";
import { redactText } from "../redact.js";

export function sinceTime(value: unknown = "1d", now = Date.now()): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?[hdw]$/.test(value)) throw new Error("since must be a duration such as 12h, 1d or 1w");
  const ms = Number(value.slice(0, -1)) * ({ h: 3600000, d: 86400000, w: 604800000 }[value.slice(-1)] ?? 0);
  if (!ms || ms > 90 * 86400000) throw new Error("since must be between zero and 90 days");
  return now - ms;
}
export function teammateLogin(value: unknown): string {
  if (typeof value !== "string" || !/^@?[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) throw new Error("choose a GitHub login, e.g. @teammate");
  return value.replace(/^@/, "").toLowerCase();
}
export function buildHandoff(events: LoomEvent[], branch: string, to: string, note: string): Handoff {
  const messages = events.filter(e => e.kind === "message" && !e.payload.reasoning && typeof e.payload.text === "string");
  const summary = messages.slice(-6).map(e => `${e.agentId ?? "You"}: ${String(e.payload.text).slice(0, 1000)}`).join("\n\n") || "No messages yet.";
  const lastAnswer = messages.filter(e => e.payload.author === "user").at(-1)?.id ?? 0;
  const questions = events.filter(e => e.id > lastAnswer && (e.kind === "needs_input" || (e.kind === "orchestra" && e.payload.question))).slice(-10).map(e => String(e.payload.question ?? e.payload.text ?? ""));
  return { summary: redactText(summary), branch, to: teammateLogin(to), note: redactText(note.slice(0, 4000)), questions: questions.map(redactText) };
}
export interface Activity { id?: string | number; ts: number; type: string; github?: string | null; repo?: string; meta?: Record<string, unknown>; content?: Record<string, unknown> | null }
export interface StandupPerson { person: string; started: string[]; merged: string[]; waiting: string[] }
export function buildStandup(feed: Activity[], events: LoomEvent[], since: number, person = "You", waiting: Array<{ person: string; title: string }> = []) {
  const rows = new Map<string, StandupPerson>(), seen = new Set<string>();
  const add = (who: string, kind: "started" | "merged" | "waiting", title: string, key: string) => {
    if (seen.has(key)) return; seen.add(key);
    let row = rows.get(who); if (!row) { row = { person: who, started: [], merged: [], waiting: [] }; rows.set(who, row); }
    if (!row[kind].includes(title)) row[kind].push(redactText(title));
  };
  for (const e of feed.filter(e => e.ts >= since)) {
    const kind = ["goal_started", "task_started", "pr_opened"].includes(e.type) ? "started" : ["goal_landed", "pr_merged"].includes(e.type) ? "merged" : ["goal_needs_someone", "zone_waiting", "land_queued"].includes(e.type) ? "waiting" : null;
    if (kind) add(e.github || String(e.meta?.github || "Team"), kind, String(e.content?.goal ?? e.content?.title ?? e.meta?.title ?? (e.meta?.number ? `PR #${e.meta.number}` : e.type)) + (e.repo ? ` · ${e.repo}` : ""), `feed:${e.id ?? JSON.stringify(e)}`);
  }
  for (const e of events.filter(e => e.ts >= since)) {
    const p = e.payload;
    const kind = (e.kind === "message" && p.author === "user") || (e.kind === "orchestra" && p.phase === "started") ? "started" : (e.kind === "orchestra" && (p.phase === "landed" || p.phase === "applied" || (p.phase === "delivered" && ["commit", "push"].includes(String(p.mode))))) ? "merged" : e.kind === "needs_input" || (e.kind === "orchestra" && p.status === "waiting_human") ? "waiting" : null;
    const answered = kind === "waiting" && events.some(next => next.id > e.id && (next.chat ?? "main") === (e.chat ?? "main") && ((next.kind === "message" && next.payload.author === "user") || (next.kind === "orchestra" && ["completed", "aborted", "failed", "applied"].includes(String(next.payload.phase)))));
    if (kind && !answered) add(person, kind, String(p.goal ?? p.question ?? p.text ?? `${e.agentId ?? "Chat"} · ${e.chat ?? "main"}`).slice(0, 1000), `local:${e.id}`);
  }
  for (const item of waiting) add(item.person, "waiting", item.title, `waiting:${item.person}:${item.title}`);
  const people = [...rows.values()].sort((a, b) => a.person.localeCompare(b.person));
  const markdown = people.map(p => `### ${p.person}\n${(["started", "merged", "waiting"] as const).map(k => `${k[0]!.toUpperCase() + k.slice(1)}: ${p[k].join("; ") || "—"}`).join("\n")}`).join("\n\n") || "No activity in this window.";
  return { since, people, markdown };
}
