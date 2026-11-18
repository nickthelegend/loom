import os from "node:os";
import type { ProjectRuntime } from "../../daemon/runtime.js";
import { find } from "../../core/checkpoint.js";
import { gitWorktree } from "../../core/worktrees.js";
import { notify } from "../../core/notify.js";
import { readDaemonConfig } from "../../core/registry.js";
import { sendExpoPush, wantsPush } from "../../daemon/push.js";
import { readRules, writeRules, evaluateRule, type AlertRule } from "./alerts.js";
import { turns } from "./analytics.js";

export function deliverAlert(rt: ProjectRuntime, rule: AlertRule, value: number | null, test = false): void {
  const body = `${test ? "Test: " : ""}${rule.expression} (observed ${value ?? "insufficient data"})`;
  rt.log.append({ kind: "status", payload: { state: "r4_alert", ruleId: rule.id, text: body, value, test } });
  notify({ title: `Loom · ${rt.info.name}`, body });
  const tokens = (readDaemonConfig()?.clients ?? []).filter(c => !c.guest && (!c.projects?.length || c.projects.includes(rt.info.id)) && wantsPush(c.pushKinds, "goals")).flatMap(c => c.pushToken ? [c.pushToken] : []);
  if (tokens.length) void sendExpoPush(tokens, { title: `Loom · ${rt.info.name}`, body, data: { projectId: rt.info.id, daemon: os.hostname(), category: "goals", kind: "r4_alert", ruleId: rule.id } });
}

/** Bound each query to the history needed by its metric. Queue-only checks need no log. */
export function ruleRows(rt: ProjectRuntime, rules: AlertRule[], now = Date.now()) {
  const windows = rules.filter(r => r.metric === "finish_rate" || r.metric === "turn_minutes");
  const windowRows = windows.length ? turns(rt.log.list({ limit: Math.min(20000, Math.max(...windows.map(r => r.window)) * 200) })) : [];
  const hourRows = rules.some(r => r.metric === "errors_per_hour") ? turns(rt.log.list({ sinceTs: now - 3_600_000 })) : [];
  return (rule: AlertRule) => rule.metric === "errors_per_hour" ? hourRows : windowRows;
}

export function checkRules(rt: ProjectRuntime, now = Date.now()): void {
  const rules = readRules(rt.info.id);
  if (!rules.some(r => !r.paused)) return;
  const rows = ruleRows(rt, rules.filter(r => !r.paused), now);
  let changed = false;
  const firing: AlertRule[] = [];
  for (const rule of rules) {
    if (rule.paused) continue;
    const result = evaluateRule(rule, rows(rule), rt.queue.snapshot().items.length, now);
    if (rule.firing === result.breached) continue;
    rule.firing = result.breached; changed = true;
    if (rule.firing) { rule.lastFired = now; firing.push(rule); }
  }
  if (changed) {
    // Persist the edge before notification; restarting cannot send the same breach twice.
    writeRules(rt.info.id, rules);
    for (const rule of firing) deliverAlert(rt, rule, evaluateRule(rule, rows(rule), rt.queue.snapshot().items.length, now).value);
  }
}

/** Persist just the first output, never the streamed text itself. */
export function observeRuntime(rt: ProjectRuntime): () => void {
  const active = new Map<string, boolean>();
  const k = (agent: string, chat?: string) => JSON.stringify([agent, chat ?? "main"]);
  const output = (agent: string, chat?: string) => {
    const id = k(agent, chat);
    if (active.get(id) !== false) return;
    active.set(id, true);
    rt.log.append({ kind: "status", agentId: agent, chat, payload: { state: "r4_first_output" } });
  };
  const toolStarts = new Map<string, number>(), completed = new Map<string, number>();
  const offLive = rt.onLiveDelta(f => {
    if (!("phase" in f)) { if (f.delta) output(f.agentId, f.chat); return; }
    const id = JSON.stringify([f.agentId, f.chat, f.turnId, f.itemId]);
    if (f.phase === "started") { toolStarts.set(id, Date.now()); output(f.agentId, f.chat); }
    if (f.phase === "completed") {
      const start = toolStarts.get(id); toolStarts.delete(id);
      if (start !== undefined) {
        const target = k(f.agentId, f.chat); completed.set(target, Date.now() - start);
        // Ingestion writes the completed tool synchronously after this frame.
        queueMicrotask(() => completed.delete(target));
      }
    }
  });
  const offStream = rt.onStream(f => { if (f.text) output(f.agentId, f.chat); });
  const offLog = rt.log.onEvent(e => {
    const p = e.payload;
    if (e.agentId) {
      const id = k(e.agentId, e.chat);
      if (e.kind === "status" && p.state === "turn_started" && !active.has(id)) active.set(id, false);
      if (e.kind === "tool_call" && completed.has(id)) {
        const durationMs = completed.get(id)!; completed.delete(id);
        rt.log.append({ kind: "status", agentId: e.agentId, chat: e.chat, payload: { state: "r4_tool_duration", toolEventId: e.id, durationMs } });
      }
      if (e.kind === "message" || e.kind === "tool_call") output(e.agentId, e.chat);
      if (e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && p.state === "interrupted")) {
        active.delete(id);
        for (const tool of toolStarts.keys()) if (JSON.parse(tool)[0] === e.agentId) toolStarts.delete(tool);
      }
    }
    if (e.kind === "checkpoint" && p.reason === "rewound" && !p.path) {
      void rewindPaths(rt, String(p.id), String(p.undo)).then(paths => {
        if (!closed && paths) rt.log.append({ kind: "status", payload: { state: "r4_rewind_files", rewindEventId: e.id, paths } });
      }).catch(() => {});
    }
  });
  let closed = false;
  return () => { closed = true; offStream(); offLive(); offLog(); active.clear(); toolStarts.clear(); completed.clear(); };
}

export async function rewindPaths(rt: ProjectRuntime, target: string, undo: string): Promise<string[] | null> {
  const [to, from] = await Promise.all([find(rt.info.dir, target), find(rt.info.dir, undo)]);
  if (!to || !from) return null;
  const output = await gitWorktree(["diff", "--name-only", "-z", from.commit, to.commit], rt.info.dir);
  return output.split("\0").filter(Boolean);
}
