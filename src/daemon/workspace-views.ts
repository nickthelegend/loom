/**
 * Views across every project: search every session, and the audit trail — who let what happen.
 * Approach credit: Nuphos ("search every team session"; "audit trails"), Apache-2.0, © Zeabur Inc.
 *
 * A project whose runtime is loaded is read through its live log; one that isn't is opened just
 * for the read and closed again, so a search doesn't spin up every project's agents.
 */

import { EventLog } from "../core/eventlog.js";
import { listProjects, projectLoomDir } from "../core/registry.js";
import { searchChats } from "../core/search.js";
import { readTriggers } from "../core/triggers.js";
import type { LoomEvent } from "../types.js";
import type { ProjectRuntime } from "./runtime.js";

type Reader = Pick<EventLog, "list">;

async function withLog<T>(info: { id: string; dir: string }, live: Map<string, ProjectRuntime>, fn: (log: Reader, chats: (id: string) => string) => T): Promise<T | null> {
  const rt = live.get(info.id);
  if (rt) return fn(rt.log, (id) => rt.chats().find((c) => c.id === id)?.title ?? id);
  let log: EventLog | null = null;
  try {
    log = await EventLog.open(projectLoomDir(info.dir));
    return fn(log, (id) => id);
  } catch {
    return null;
  } finally {
    log?.close();
  }
}

export interface SessionHit { project: string; projectName: string; chat: string; chatTitle: string; eventId: number; at: number; agent?: string; snippet: string }

/** Every chat in every project (a scoped token: its projects only), newest first. */
export async function searchSessions(query: string, live: Map<string, ProjectRuntime>, scope: string[] | null, limit = 60): Promise<{ hits: SessionHit[]; truncated: boolean }> {
  const out: SessionHit[] = [];
  let truncated = false;
  for (const info of listProjects()) {
    if (scope && !scope.includes(info.id)) continue;
    const r = await withLog(info, live, (log, title) => {
      const { hits, truncated: t } = searchChats(log, query, { limit: 25 });
      return { t, hits: hits.map((h) => ({ project: info.id, projectName: info.name, chat: h.chat, chatTitle: title(h.chat), eventId: h.eventId, at: h.at,
        ...(h.agentId ? { agent: h.agentId } : {}), snippet: h.snippet.slice(0, 240) })) };
    });
    if (!r) continue;
    if (r.t) truncated = true;
    out.push(...r.hits);
  }
  out.sort((a, b) => b.at - a.at);
  if (out.length > limit) truncated = true;
  return { hits: out.slice(0, limit), truncated };
}

export interface AuditEntry { at: number; project: string; projectName: string; chat?: string; what: string; who: string; detail?: string }

/**
 * What people and automations did, newest first: approvals answered (and by whom), messages from
 * teammates in a shared chat, from Slack / Discord, and from triggers, and every baton handoff.
 */
export async function auditTrail(since: number, live: Map<string, ProjectRuntime>, limit = 500): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for (const info of listProjects()) {
    const base = { project: info.id, projectName: info.name };
    await withLog(info, live, (log) => {
      for (const e of log.list({ since: 0, limit: 20_000 }) as LoomEvent[]) {
        if (e.ts < since) continue;
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const chat = e.chat ? { chat: e.chat } : {};
        if (e.kind === "approval" && p.phase === "decided") {
          out.push({ ...base, ...chat, at: e.ts, what: `${p.behavior === "allow" ? "allowed" : "denied"} ${String(p.tool ?? "a tool")}${p.scope === "session" ? " for the session" : ""}`,
            who: typeof p.by === "string" ? p.by : String(p.message ?? "").startsWith("No answer") ? "timed out" : "owner", detail: `asked by ${e.agentId ?? "an agent"}` });
        } else if (e.kind === "message" && !e.agentId && typeof p.text === "string") {
          const text = p.text;
          const via = /\(from (.+?) on (Slack|Discord)\)\s*$/.exec(text);
          const trig = /\(started by the trigger "(.+?)", (\w+)\)\s*$/.exec(text);
          if (typeof p.by === "string") out.push({ ...base, ...chat, at: e.ts, what: "sent a message in a shared chat", who: p.by, detail: text.slice(0, 160) });
          else if (via) out.push({ ...base, ...chat, at: e.ts, what: `sent a message from ${via[2]}`, who: via[1]!, detail: text.replace(via[0], "").trim().slice(0, 160) });
          else if (trig) out.push({ ...base, ...chat, at: e.ts, what: `trigger fired (${trig[2]})`, who: `trigger "${trig[1]}"`, detail: text.replace(trig[0], "").trim().slice(0, 160) });
        } else if (e.kind === "handoff" && typeof p.to === "string") {
          out.push({ ...base, at: e.ts, what: `baton → ${p.to}`, who: p.from ? String(p.from) : "owner" });
        }
      }
    });
    // triggers that didn't run (skipped, failed) are in their own history, not the thread
    for (const r of readTriggers(info.dir).runs) {
      if (r.at < since || r.ok) continue;
      out.push({ ...base, at: r.at, what: "trigger didn't run", who: `trigger ${r.trigger}`, detail: r.note });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
