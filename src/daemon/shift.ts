/**
 * Night Shift: the runner. Tasks go into the queue, one chat each, and run in
 * order; the shift watches the clock and its budget, and once the last task
 * has settled (its turn over, its proof done) it writes the morning report —
 * one card in the thread and one push. The report's reading of each chat is
 * core/shift.ts.
 *
 * It survives a restart: the shift is saved in .loom/shift.json and the queue
 * keeps its own items, so a daemon that comes back picks the watch up again.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ListOpts } from "../core/events/contracts.js";
import type { QueueInput, QueueItem } from "../core/prompt-queue.js";
import { projectLoomDir } from "../core/registry.js";
import { outcomeOf, parseTasks, parseUntil, report, type ShiftConfig, type ShiftReport, type TaskOutcome } from "../core/shift.js";
import type { LoomEvent, NewEvent } from "../types.js";

export interface ShiftHost {
  dir: string;
  hasAgent(id: string): boolean;
  createChat(title: string, agentId?: string): { id: string };
  enqueue(input: QueueInput): QueueItem;
  queued(): QueueItem[];
  removeQueued(id: string): void;
  /** Is any agent mid-turn? */
  busy(): boolean;
  proofsBusy(): boolean;
  /** A restart pauses the queue until someone looks; a night shift has nobody looking. Resume that pause (only that one). */
  resumeAfterRestart(): void;
  list(opts: ListOpts): LoomEvent[];
  append(e: NewEvent): LoomEvent;
  warn(message: string, detail: unknown): void;
  /** Say when the tree has uncommitted changes as the shift starts. */
  noteDirtyStart?(chat: string, what: string): void;
}

export interface StartShift { tasks: string | string[]; to?: string; until?: string | number; maxUsd?: number }

/** How long everything must stay quiet before the shift calls it a night — a turn's diff, proof or nudge lands just after it ends. */
export const SETTLE_MS = 3000;
/** ...and the tasks' own chats must have been quiet this long: a task can be between an interrupt and its next start (#302). */
export const CHAT_QUIET_MS = 15_000;
const CHECK_MS = 1000;

interface Saved { current?: ShiftConfig | null; last?: ShiftReport | null }

export class NightShift {
  private shift: ShiftConfig | null = null;
  private last: ShiftReport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private quietSince = 0;

  constructor(private readonly host: ShiftHost) {
    const saved = this.read();
    this.shift = saved.current ?? null;
    this.last = saved.last ?? null;
    if (this.shift) this.watch();
  }

  /** A shift is running: the loop watch nudges by default while it is. */
  get active(): boolean { return Boolean(this.shift); }

  status(): { active: boolean; shift: ShiftConfig | null; tasks: TaskOutcome[]; last: ShiftReport | null } {
    return { active: this.active, shift: this.shift, tasks: this.shift ? this.outcomes(this.shift) : [], last: this.last };
  }

  start(input: StartShift): ShiftConfig {
    if (this.shift) throw new Error("a night shift is already running — stop it first");
    const tasks = parseTasks(input.tasks);
    if (!tasks.length) throw new Error("a night shift needs at least one task");
    if (input.to && !this.host.hasAgent(input.to)) throw new Error(`no agent "${input.to}" in this project`);
    const until = parseUntil(input.until);
    if (until !== undefined && until <= Date.now()) throw new Error("the stop-by time has already passed");
    const maxUsd = input.maxUsd !== undefined && input.maxUsd !== null && Number(input.maxUsd) > 0 ? Number(input.maxUsd) : undefined;
    const shift: ShiftConfig = { id: randomUUID().slice(0, 8), startedAt: Date.now(), tasks: [],
      ...(input.to ? { to: input.to } : {}), ...(until ? { until } : {}), ...(maxUsd ? { maxUsd } : {}) };
    for (const text of tasks) {
      const chat = this.host.createChat(`🌙 ${text.replace(/\s+/g, " ").slice(0, 56)}`, input.to).id;
      const item = this.host.enqueue({ text, chat, source: "user", target: input.to ? { kind: "agent", agentId: input.to } : { kind: "auto" } });
      shift.tasks.push({ text, chat, queueId: item.id });
    }
    this.shift = shift;
    this.save();
    this.host.noteDirtyStart?.(shift.tasks[0]!.chat, "This night shift");
    this.host.append({ kind: "shift", payload: { phase: "started", shiftId: shift.id, tasks: shift.tasks.map((t) => ({ text: t.text, chat: t.chat })),
      ...(shift.to ? { to: shift.to } : {}), ...(shift.until ? { until: shift.until } : {}), ...(shift.maxUsd ? { maxUsd: shift.maxUsd } : {}) } });
    this.watch();
    return shift;
  }

  /** Stop starting new tasks; the one running finishes, then the report goes out. */
  stop(reason = "you stopped it"): ShiftConfig | null {
    const s = this.shift;
    if (!s) return null;
    if (!s.stopped) s.stopped = reason;
    const waiting = new Set(this.host.queued().map((q) => q.id));
    for (const t of s.tasks) if (t.queueId && waiting.has(t.queueId)) {
      try { this.host.removeQueued(t.queueId); } catch { /* already gone */ }
      t.skipped = true;
    }
    this.save();
    this.check();
    return s;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Look again now (a turn just ended). */
  poke(): void { if (this.shift) this.check(); }

  private watch(): void {
    if (this.timer) return;
    this.quietSince = 0;
    this.timer = setInterval(() => { try { this.check(); } catch (err) { this.host.warn("night shift check failed", err); } }, CHECK_MS);
    this.timer.unref?.();
  }

  private spent(s: ShiftConfig): number {
    let usd = 0;
    for (const e of this.host.list({ kinds: ["status"], sinceTs: s.startedAt })) if (e.payload.state === "turn_cost") usd += Number(e.payload.costUsd ?? 0) || 0;
    return usd;
  }

  private check(): void {
    const s = this.shift;
    if (!s) return this.close();
    if (!s.stopped && s.until && Date.now() >= s.until) this.stop(`it reached the stop-by time (${new Date(s.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`);
    else if (!s.stopped && s.maxUsd && this.spent(s) >= s.maxUsd) this.stop(`it spent its $${s.maxUsd.toFixed(2)} budget`);
    if (!s.stopped) this.host.resumeAfterRestart();
    const waiting = new Set(this.host.queued().map((q) => q.id));
    const pending = s.tasks.some((t) => !t.skipped && t.queueId && waiting.has(t.queueId));
    if (pending || this.host.busy() || this.host.proofsBusy() || this.chatsBusy(s)) { this.quietSince = 0; return; }
    const now = Date.now();
    if (!this.quietSince) { this.quietSince = now; return; }
    if (now - this.quietSince < SETTLE_MS) return;
    this.finish(s);
  }

  /** Has any task's chat moved in the last CHAT_QUIET_MS? Then the shift isn't over, whatever "busy" said a moment ago. */
  private chatsBusy(s: ShiftConfig): boolean {
    const since = Date.now() - CHAT_QUIET_MS;
    return s.tasks.some((t) => !t.skipped && this.host.list({ chat: t.chat, sinceTs: since, limit: 1 }).length > 0);
  }

  private outcomes(s: ShiftConfig): TaskOutcome[] {
    const waiting = new Set(this.host.queued().map((q) => q.id));
    return s.tasks.map((t) => outcomeOf(t, this.host.list({ chat: t.chat, limit: 2000 }), { queued: Boolean(t.queueId && waiting.has(t.queueId)) }));
  }

  private finish(s: ShiftConfig): void {
    // nothing is running any more: a task that never finished was cut off (a restart, a crash)
    const outcomes = this.outcomes(s).map((o) => o.status === "running" ? { ...o, status: "failed" as const, error: o.stopped ?? "it stopped before finishing (was Loom restarted?)" } : o);
    const r = report(s, outcomes);
    s.reportedAt = r.endedAt;
    this.last = r;
    this.shift = null;
    this.save();
    this.close();
    this.host.append({ kind: "shift", payload: { phase: "report", ...r } as unknown as Record<string, unknown> });
  }

  private file(): string { return path.join(projectLoomDir(this.host.dir), "shift.json"); }

  private read(): Saved {
    try { return JSON.parse(fs.readFileSync(this.file(), "utf8")) as Saved; } catch { return {}; }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify({ current: this.shift, last: this.last }, null, 2));
    } catch (err) { this.host.warn("couldn't save the night shift", err); }
  }
}
