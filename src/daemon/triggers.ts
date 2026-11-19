/**
 * The daemon end of triggers (core/triggers.ts): a ticker that fires due schedules, and the
 * webhook handler. Every fire goes through the project's prompt queue into the trigger's own
 * thread, so it waits its turn like anything typed — and a trigger whose last prompt is still
 * waiting there skips rather than piling up behind itself.
 */

import { githubCommand } from "../core/integration-triggers.js";
import { startIntake } from "./intake.js";
import { logbook } from "../core/logbook.js";
import { listProjects } from "../core/registry.js";
import { isDue, readTriggers, renderPrompt, writeTriggers, type Trigger, type TriggerRun } from "../core/triggers.js";
import type { ProjectRuntime } from "./runtime.js";
import { AutomationEngine } from "../core/auto-r4/engine.js";
import { automationHold, changeAutomation, readAutomation, type FireOptions } from "../core/auto-r4/state.js";
import { conditionReason, renderAutomation } from "../core/auto-r4/model.js";
import { listOrchestraRecipes } from "../core/orchestra-options.js";
import { readWebhooks } from "../core/auto-r4/webhooks.js";

const TICK_MS = 20_000;
const AUTOMATION_MS = 15_000;
/** Delivery ids seen recently, per trigger — a redelivered webhook runs once. */
const SEEN_MAX = 500;

export class TriggerRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private automationTimer: ReturnType<typeof setInterval> | null = null;
  private openRuntimes: () => Iterable<ProjectRuntime> = () => [];
  private automationTicking: Promise<void> | null = null;
  private seen = new Map<string, number>();
  private firing = new Map<string, Promise<TriggerRun>>();
  private ticking: Promise<void> | null = null;
  private automation = new AutomationEngine((pid, dir, id, opts) => this.fire(pid, dir, id, opts));

  constructor(private runtime: (projectId: string) => Promise<ProjectRuntime>) {}

  setOpenRuntimes(get: () => Iterable<ProjectRuntime>): void { this.openRuntimes = get; }

  prepare(rt: ProjectRuntime, t: Trigger): Promise<void> { return this.automation.prepare(rt, t); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => logbook.warn("triggers", "tick failed", String(e))), TICK_MS);
    this.timer.unref?.();
    this.automationTimer = setInterval(() => void this.tickAutomation().catch(e => logbook.warn("triggers", "automation tick failed", String(e))), AUTOMATION_MS);
    this.automationTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.automationTimer) clearInterval(this.automationTimer);
    this.automationTimer = null;
  }

  /** Fire every schedule that's due, across projects. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOne(now);
    try { await this.ticking; } finally { this.ticking = null; }
  }

  private async tickOne(now: Date): Promise<void> {
    for (const info of listProjects()) {
      const { triggers } = readTriggers(info.dir);
      for (const t of triggers) if (isDue(t, now)) await this.fire(info.id, info.dir, t.id, { kind: "scheduled" });
    }
  }

  /** Background automation never opens an idle project or delays the schedule timer. */
  async tickAutomation(now = Date.now()): Promise<void> {
    if (this.automationTicking) return this.automationTicking;
    this.automationTicking = (async () => {
      for (const rt of this.openRuntimes()) {
        const dir = rt.info.dir;
        if (!readTriggers(dir).triggers.some(t => t.enabled && ["file", "event", "branch", "url"].includes(t.kind)) &&
            !readWebhooks(dir).webhooks.length && !readAutomation(dir).held.length && !Object.keys(readAutomation(dir).pending).length) continue;
        try { await this.automation.tick(rt, now); }
        catch (e) { logbook.warn("triggers", "automation tick failed", String(e)); }
      }
    })();
    try { await this.automationTicking; } finally { this.automationTicking = null; }
  }

  /**
   * Queue one run of a trigger. `body` is a webhook's payload. Returns what happened, which is
   * also recorded in the trigger's run history.
   */
  async fire(projectId: string, dir: string, triggerId: string, opts: FireOptions): Promise<TriggerRun> {
    const key = `${projectId}:${triggerId}`;
    const prior = this.firing.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.fireOne(projectId, dir, triggerId, opts));
    this.firing.set(key, next);
    try { return await next; }
    finally { if (this.firing.get(key) === next) this.firing.delete(key); }
  }

  private async fireOne(projectId: string, dir: string, triggerId: string, opts: FireOptions): Promise<TriggerRun> {
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
    if (!t.enabled && opts.kind !== "manual") return record(false, "skipped: trigger paused");
    const hold = automationHold();
    if (hold) {
      changeAutomation(dir, s => {
        const duplicate = s.held.some(h => h.trigger === triggerId && (opts.kind === "scheduled" || (opts.delivery && opts.delivery === h.opts.delivery)));
        if (!duplicate) {
          if (s.held.length >= 1000) throw new Error("automation hold is full (1000 deliveries)");
          s.held.push({ trigger: triggerId, opts, at: now });
        }
      });
      return record(false, `held: ${hold}`);
    }
    const command = t.githubCommand ? githubCommand(opts.body, opts.event) : null;
    if (t.githubCommand && !command) return record(false, "skipped: requires a trusted /loom issue comment");
    if (command && t.commandIds?.includes(command.id)) return record(false, "skipped: already delivered");
    if (command) opts.delivery = `github-comment:${command.id}`;
    if (opts.delivery) {
      const key = `${projectId}:${triggerId}:${opts.delivery}`;
      if (this.seen.has(key)) return { trigger: triggerId, at: now, ok: false, note: "skipped: already delivered" };
    }
    if (opts.kind === "webhook" && t.minIntervalSec && t.lastFiredAt && now - t.lastFiredAt < t.minIntervalSec * 1000) {
      return record(false, `skipped: within ${t.minIntervalSec}s of the last run`);
    }
    let rt: ProjectRuntime;
    try { rt = await this.runtime(projectId); } catch (e) { return record(false, `project unavailable: ${(e as Error).message}`); }
    let pendingKey = t.id;
    let setPending = false;
    try {
      const reason = await conditionReason(dir, t.condition);
      if (reason) return record(false, reason);
      if (t.kind === "intake") {
        if (!t.intake) return record(false, "intake needs source and mode");
        const issues = await startIntake(rt, t.intake.source, undefined, t.intake.mode, t.agent, t.intake.label);
        return record(true, `intake checked ${issues.length} assigned issues`);
      }
      let chat = !command && t.chat && rt.chats().some((c) => c.id === t.chat) ? t.chat : undefined;
      if (!chat) {
        chat = rt.createChat(command ? `GitHub #${command.number}: ${command.prompt.slice(0, 60)}` : `⏱ ${t.name}`, t.agent ? { agentId: t.agent } : {}).id;
        const fresh = readTriggers(dir);
        const cur = fresh.triggers.find((x) => x.id === triggerId);
        if (cur) { cur.chat = chat; writeTriggers(dir, fresh); }
      }
      if (rt.queue.snapshot().items.some((i) => i.chat === chat)) return record(false, "skipped: its last run is still waiting in the queue");
      const text = command ? `${command.prompt}\n\nIssue: ${command.url}` : renderPrompt(renderAutomation(t.prompt, opts.body ?? {}), opts.body ?? {}, opts.event ?? "", { name: t.name, firedAt: now });
      // always one named agent: an "auto" queue item runs a route, and routes answer in the main chat
      const agentId = t.agent ?? rt.baton.holder() ?? rt.config.agents.find((a) => a.enabled !== false)?.id;
      const recipe = t.recipe ? listOrchestraRecipes().find(r => r.name === t.recipe) : undefined;
      if (t.recipe && !recipe) throw new Error(`no Orchestra recipe "${t.recipe}"`);
      if (t.route && !rt.config.routes?.[t.route]) throw new Error(`no saved route "${t.route}"`);
      if (!agentId && !t.orchestrate && !recipe && !t.route) throw new Error("no agent in this project to run it");
      pendingKey = command ? chat : t.id;
      this.automation.reconcilePending(rt, pendingKey);
      if (opts.kind !== "manual" && !readTriggers(dir).triggers.find(x => x.id === triggerId)?.enabled) return record(false, "skipped: trigger paused");
      if (readAutomation(dir).pending[pendingKey] !== undefined) return record(false, "skipped: its last run is still running");
      changeAutomation(dir, s => { s.cursor ??= rt.log.lastId(); s.origins[chat!] = t.id; s.depth[chat!] = opts.depth ?? 0; s.pending[pendingKey] = rt.log.lastId(); });
      setPending = true;
      rt.enqueue({ text: `${text || recipe?.options.goal || ""}\n\n(started by the trigger "${t.name}", ${opts.kind})`, chat, source: "user", automation: t.id,
        target: recipe ? { kind: "orchestra", recipeOptions: recipe.options } : t.orchestrate ? { kind: "orchestra" } : t.route ? { kind: "auto", routeName: t.route } : { kind: "agent", agentId: agentId! } });
      if (opts.delivery) {
        this.seen.set(`${projectId}:${triggerId}:${opts.delivery}`, now);
        if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
      }
      if (command) {
        const fresh = readTriggers(dir);
        const cur = fresh.triggers.find(x => x.id === triggerId);
        if (cur) { cur.commandIds = [...(cur.commandIds ?? []), command.id].slice(-500); writeTriggers(dir, fresh); }
      }
      return record(true, rt.queue.paused ? "queued — but this project's queue is paused, so it waits until you resume it" : "queued");
    } catch (e) {
      if (opts.kind === "scheduled") {
        const fresh = readTriggers(dir), current = fresh.triggers.find(x => x.id === triggerId);
        if (current) { current.lastFiredAt = now; writeTriggers(dir, fresh); }
      }
      if (setPending) changeAutomation(dir, s => { delete s.pending[pendingKey]; });
      this.automation.outcome(rt, t.id, false, `failed: ${(e as Error).message}`);
      return { trigger: triggerId, at: now, ok: false, note: (e as Error).message };
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
