/**
 * The daemon end of triggers (core/triggers.ts): a ticker that fires due schedules, and the
 * webhook handler. Every fire goes through the project's prompt queue into the trigger's own
 * thread, so it waits its turn like anything typed — and a trigger whose last prompt is still
 * waiting there skips rather than piling up behind itself.
 */

import { logbook } from "../core/logbook.js";
import { listProjects } from "../core/registry.js";
import { isDue, readTriggers, renderPrompt, writeTriggers, type Trigger, type TriggerRun } from "../core/triggers.js";
import type { ProjectRuntime } from "./runtime.js";

const TICK_MS = 20_000;
/** Delivery ids seen recently, per trigger — a redelivered webhook runs once. */
const SEEN_MAX = 500;

export class TriggerRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, number>();

  constructor(private runtime: (projectId: string) => Promise<ProjectRuntime>) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => logbook.warn("triggers", "tick failed", String(e))), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire every schedule that's due, across projects. */
  async tick(now = new Date()): Promise<void> {
    for (const info of listProjects()) {
      const { triggers } = readTriggers(info.dir);
      for (const t of triggers) if (isDue(t, now)) await this.fire(info.id, info.dir, t.id, { kind: "scheduled" });
    }
  }

  /**
   * Queue one run of a trigger. `body` is a webhook's payload. Returns what happened, which is
   * also recorded in the trigger's run history.
   */
  async fire(projectId: string, dir: string, triggerId: string, opts: { kind: "scheduled" | "webhook" | "manual"; body?: unknown; event?: string; delivery?: string }): Promise<TriggerRun> {
    const data = readTriggers(dir);
    const t = data.triggers.find((x) => x.id === triggerId);
    const now = Date.now();
    const record = (ok: boolean, note: string): TriggerRun => {
      const fresh = readTriggers(dir);
      const run = { trigger: triggerId, at: now, ok, note };
      const cur = fresh.triggers.find((x) => x.id === triggerId);
      if (cur && ok) cur.lastFiredAt = now;
      else if (cur && opts.kind === "scheduled") cur.lastFiredAt = now; // a skipped schedule still used its slot
      fresh.runs.push(run);
      writeTriggers(dir, fresh);
      return run;
    };
    if (!t) return { trigger: triggerId, at: now, ok: false, note: "no such trigger" };
    if (opts.delivery) {
      const key = `${triggerId}:${opts.delivery}`;
      if (this.seen.has(key)) return { trigger: triggerId, at: now, ok: false, note: "skipped: already delivered" };
      this.seen.set(key, now);
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
    }
    if (opts.kind === "webhook" && t.minIntervalSec && t.lastFiredAt && now - t.lastFiredAt < t.minIntervalSec * 1000) {
      return record(false, `skipped: within ${t.minIntervalSec}s of the last run`);
    }
    let rt: ProjectRuntime;
    try { rt = await this.runtime(projectId); } catch (e) { return record(false, `project unavailable: ${(e as Error).message}`); }
    try {
      let chat = t.chat && rt.chats().some((c) => c.id === t.chat) ? t.chat : undefined;
      if (!chat) {
        chat = rt.createChat(`⏱ ${t.name}`, t.agent ? { agentId: t.agent } : {}).id;
        const fresh = readTriggers(dir);
        const cur = fresh.triggers.find((x) => x.id === triggerId);
        if (cur) { cur.chat = chat; writeTriggers(dir, fresh); }
      }
      if (rt.queue.snapshot().items.some((i) => i.chat === chat)) return record(false, "skipped: its last run is still waiting in the queue");
      const text = opts.body !== undefined || t.kind === "webhook"
        ? renderPrompt(t.prompt, opts.body ?? {}, opts.event ?? "", { name: t.name, firedAt: now })
        : renderPrompt(t.prompt, {}, "", { name: t.name, firedAt: now });
      // always one named agent: an "auto" queue item runs a route, and routes answer in the main chat
      const agentId = t.agent ?? rt.baton.holder() ?? rt.config.agents.find((a) => a.enabled !== false)?.id;
      if (!agentId) return record(false, "no agent in this project to run it");
      rt.enqueue({ text: `${text}\n\n(started by the trigger "${t.name}", ${opts.kind})`, chat, source: "user", target: { kind: "agent", agentId } });
      return record(true, rt.queue.paused ? "queued — but this project's queue is paused, so it waits until you resume it" : "queued");
    } catch (e) {
      return record(false, (e as Error).message);
    }
  }
}

/** The trigger a webhook id names, and its project. */
export function findWebhook(id: string): { projectId: string; dir: string; trigger: Trigger } | null {
  for (const info of listProjects()) {
    const t = readTriggers(info.dir).triggers.find((x) => x.id === id && x.kind === "webhook");
    if (t) return { projectId: info.id, dir: info.dir, trigger: t };
  }
  return null;
}
