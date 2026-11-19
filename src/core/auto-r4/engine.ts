import type { LoomEvent } from "../../types.js";
import type { ProjectRuntime } from "../../daemon/runtime.js";
import type { Trigger, TriggerRun } from "../triggers.js";
import { readTriggers, writeTriggers } from "../triggers.js";
import { readAutomation, changeAutomation, automationHold, readControl, type FireOptions } from "./state.js";
import { FileChanges, readWatchUrl } from "./watch.js";
import { git } from "./model.js";
import { automationEvents } from "./events.js";
import { queueWebhooks, readWebhooks, WebhookSender } from "./webhooks.js";
import { logbook } from "../logbook.js";
import { readPrRecords } from "../pr-feedback.js";

export class AutomationEngine {
  private files = new FileChanges();
  private urlChecks = new Set<string>();
  private sender = new WebhookSender();
  constructor(private fire: (pid: string, dir: string, id: string, opts: FireOptions) => Promise<TriggerRun>) {}

  private origin(rt: ProjectRuntime, origins: Record<string, string>, chat = "main", runId?: string): string | undefined {
    if (origins[chat]) return origins[chat];
    const group = rt.chats().find(c => c.id === chat)?.group;
    const run = rt.orchestra.get(runId ?? (group?.kind === "orchestra" || group?.kind === "race" ? group.id : ""));
    return run ? origins[run.chat] : undefined;
  }

  async prepare(rt: ProjectRuntime, t: Trigger): Promise<void> {
    if (t.kind === "file") this.files.poll(`${rt.info.id}:${t.id}:${t.onChange}`, rt.info.dir, t.onChange!);
    if (t.kind === "branch") {
      const value = await git(rt.info.dir, "rev-parse", "--verify", "--end-of-options", `${t.onCommit}^{commit}`);
      changeAutomation(rt.info.dir, s => { s.watches[t.id] = { value }; });
    }
  }

  outcome(rt: ProjectRuntime, id: string, ok: boolean, note: string): void {
    const data = readTriggers(rt.info.dir), t = data.triggers.find(t => t.id === id);
    if (!t) return;
    t.failures = ok ? 0 : (t.failures ?? 0) + 1;
    const paused = !ok && t.enabled && t.failures >= (t.failureLimit ?? 3);
    if (paused) t.enabled = false;
    data.runs.push({ trigger: id, at: Date.now(), ok, note: paused ? `${note}; paused after ${t.failures} consecutive failures` : note });
    writeTriggers(rt.info.dir, data);
    if (paused) rt.log.append({ kind: "needs_input", chat: t.chat, payload: { trigger: t.id, question: `Automation ${t.name} paused after ${t.failures} consecutive failures. Review its run history before resuming.`, automationNotice: true } });
  }

  /** Reconcile a prior run without polling watches, delivering hooks or firing events. */
  reconcilePending(rt: ProjectRuntime, key: string): void {
    const since = readAutomation(rt.info.dir).pending[key];
    if (since === undefined) return;
    for (const e of rt.log.list({ since, allBranches: true, kinds: ["status", "run_complete", "error", "route_completed", "route_failed", "orchestra"] })) {
      this.settlePending(rt, e);
    }
  }

  private settlePending(rt: ProjectRuntime, e: LoomEvent): void {
    const dir = rt.info.dir, state = readAutomation(dir), data = readTriggers(dir);
    const origin = this.origin(rt, state.origins, e.chat, typeof e.payload.runId === "string" ? e.payload.runId : undefined);
    const interrupted = e.kind === "status" && e.payload.state === "interrupted";
    const terminal = interrupted || e.kind === "run_complete" || e.kind === "error" || e.kind === "route_completed" || e.kind === "route_failed" || (e.kind === "orchestra" && ["completed", "failed", "aborted"].includes(String(e.payload.phase)));
    const trigger = data.triggers.find(t => t.id === origin);
    const dispatchFailed = e.kind === "error" && !e.agentId && String(e.payload.message).startsWith("queued prompt not sent:");
    const targetTerminal = dispatchFailed || (trigger?.recipe || trigger?.orchestrate ? e.kind === "orchestra" && terminal : trigger?.route ? e.kind === "route_completed" || e.kind === "route_failed" : terminal);
    const pendingKey = trigger?.githubCommand ? e.chat ?? "main" : origin ?? "";
    if (origin && targetTerminal && state.pending[pendingKey] !== undefined && e.id > state.pending[pendingKey]!) {
      const ok = !interrupted && e.kind !== "error" && e.kind !== "route_failed" && !e.payload.error && !["failed", "aborted"].includes(String(e.payload.phase));
      this.outcome(rt, origin, ok, ok ? "completed" : `failed: ${String(e.payload.message ?? e.payload.error ?? e.payload.phase ?? "turn failed")}`);
      changeAutomation(dir, s => { delete s.pending[pendingKey]; });
    }
  }

  private skipChain(dir: string, trigger: string, depth: number): boolean {
    if (depth <= 2) return false;
    const data = readTriggers(dir);
    data.runs.push({ trigger, at: Date.now(), ok: false, note: "skipped: started by a chain of automation runs" });
    writeTriggers(dir, data);
    return true;
  }

  async tick(rt: ProjectRuntime, now = Date.now()): Promise<void> {
    const dir = rt.info.dir, pid = rt.info.id;
    if (readAutomation(dir).cursor === undefined) changeAutomation(dir, s => { s.cursor = rt.log.lastId(); });
    for (const e of rt.log.list({ since: readAutomation(dir).cursor, allBranches: true })) {
      const state = readAutomation(dir), data = readTriggers(dir);
      const origin = this.origin(rt, state.origins, e.chat, typeof e.payload.runId === "string" ? e.payload.runId : undefined);
      const trigger = data.triggers.find(t => t.id === origin);
      this.settlePending(rt, e);
      for (const name of automationEvents(e)) {
        // Landing polls can repeat the same state; fire only on its transition.
        const transition = `${e.payload.runId}:${name}`;
        if (["pr_merged", "ci_failed", "pr_opened"].includes(name)) {
          const value = JSON.stringify(e.payload.landing ?? e.payload.pr);
          if (state.transitions[transition] === value) continue;
          changeAutomation(dir, s => { s.transitions[transition] = value; });
        }
        queueWebhooks(dir, pid, name, { ...e.payload, id: e.id, chat: e.chat, agentId: e.agentId }, String(e.id), e.ts);
        for (const t of data.triggers.filter(t => t.enabled && t.kind === "event" && t.on === name && t.createdAt <= e.ts)) {
          if (origin === t.id || e.payload.automationNotice) continue;
          const depth = origin ? (state.depth[trigger?.chat ?? e.chat ?? "main"] ?? 0) + 1 : 0;
          if (this.skipChain(dir, t.id, depth)) continue;
          await this.fire(pid, dir, t.id, { kind: "automation", depth, event: name, delivery: `event:${e.id}`, body: { event: { ...e.payload, type: name, id: e.id, chat: e.chat, agentId: e.agentId } } });
        }
      }
      changeAutomation(dir, s => { s.cursor = e.id; });
    }
    // PR feedback already polls GitHub and GitLab. Read its durable facts instead
    // of starting another remote poller, including PRs opened outside Orchestra.
    for (const row of readPrRecords(dir)) {
      const state = readAutomation(dir), key = `pr:${row.repo}:${row.prNumber}`;
      const facts = [
        { name: "pr_opened", id: `${key}:open`, at: row.openedAt, payload: {} },
        ...(row.state === "MERGED" ? [{ name: "pr_merged", id: `${key}:merged`, at: row.checkedAt ?? 0, payload: {} }] : []),
        ...row.signatures.flatMap(signature => {
          try { const s = JSON.parse(signature) as unknown[]; return s[0] === "ci" ? [{ name: "ci_failed", id: `${key}:${signature}`, at: row.checkedAt ?? 0, payload: { check: s[1], commit: s[2] } }] : []; }
          catch { return []; }
        }),
      ];
      for (const fact of facts) {
        if (state.transitions[fact.id]) continue;
        if (fact.at >= (state.startedAt ?? 0)) {
          const payload = { type: fact.name, prNumber: row.prNumber, repo: row.repo, url: row.url, chat: row.chat, ...fact.payload };
          queueWebhooks(dir, pid, fact.name, payload, fact.id, fact.at);
          for (const t of readTriggers(dir).triggers.filter(t => t.enabled && t.kind === "event" && t.on === fact.name && t.createdAt <= fact.at && this.origin(rt, state.origins, row.chat) !== t.id)) {
            const origin = this.origin(rt, state.origins, row.chat);
            const originChat = readTriggers(dir).triggers.find(t => t.id === origin)?.chat ?? row.chat;
            const depth = origin ? (state.depth[originChat ?? "main"] ?? 0) + 1 : 0;
            if (this.skipChain(dir, t.id, depth)) continue;
            await this.fire(pid, dir, t.id, { kind: "automation", depth, event: fact.name, delivery: fact.id, body: { event: payload } });
          }
        }
        changeAutomation(dir, s => { s.transitions[fact.id] = "seen"; });
      }
    }
    if (!automationHold(new Date(now))) {
      for (const held of readAutomation(dir).held) {
        const trigger = readTriggers(dir).triggers.find(t => t.id === held.trigger);
        if (readAutomation(dir).pending[held.trigger] !== undefined ||
            (trigger?.chat && rt.queue.snapshot().items.some(item => item.chat === trigger.chat))) continue;
        const run = await this.fire(pid, dir, held.trigger, held.opts);
        if (/still (running|waiting)/.test(run.note) || run.note.startsWith("held:")) continue;
        changeAutomation(dir, s => {
          const index = s.held.findIndex(h => h.trigger === held.trigger && h.at === held.at && JSON.stringify(h.opts) === JSON.stringify(held.opts));
          if (index >= 0) s.held.splice(index, 1);
        });
      }
    }
    for (const t of readTriggers(dir).triggers.filter(t => t.enabled)) {
      try {
        if (t.kind === "file") {
          const key = `${pid}:${t.id}:${t.onChange}`;
          const files = this.files.poll(key, dir, t.onChange!, now);
          if (files.length) {
            const run = await this.fire(pid, dir, t.id, { kind: "automation", body: { files }, delivery: `files:${now}` });
            if (/still (running|waiting)/.test(run.note)) this.files.restore(key, files);
          }
        } else if (t.kind === "branch") {
          const value = await git(dir, "rev-parse", "--verify", "--end-of-options", `${t.onCommit}^{commit}`);
          const prior = readAutomation(dir).watches[t.id]?.value;
          if (prior && prior !== value) {
            const commits = await git(dir, "log", "--format=%H %s", `${prior}..${value}`, "--");
            if (commits) {
              const run = await this.fire(pid, dir, t.id, { kind: "automation", body: { commits, range: `${prior}..${value}` }, delivery: `commit:${value}` });
              if (/still (running|waiting)/.test(run.note)) continue;
            }
          }
          changeAutomation(dir, s => { s.watches[t.id] = { value }; });
        } else if (t.kind === "url") {
          const key = `${pid}:${t.id}`;
          const prior = readAutomation(dir).watches[t.id];
          if (this.urlChecks.has(key) || now - (prior?.checkedAt ?? 0) < (t.everyMin ?? 15) * 60_000) continue;
          this.urlChecks.add(key);
          changeAutomation(dir, s => { s.watches[t.id] = { ...prior, checkedAt: now }; });
          void (async () => {
            const value = await readWatchUrl(t.watchUrl!, t.select);
            const current = readTriggers(dir).triggers.find(x => x.id === t.id);
            if (!current?.enabled || current.watchUrl !== t.watchUrl || current.select !== t.select) return;
            if (prior?.value !== undefined && value !== prior.value) {
              const run = await this.fire(pid, dir, t.id, { kind: "automation", body: { old: prior.value.slice(0, 8000), new: value.slice(0, 8000) }, delivery: `url:${now}` });
              if (/still (running|waiting)/.test(run.note)) return;
            }
            changeAutomation(dir, s => { s.watches[t.id] = { value, checkedAt: now }; });
          })().catch(e => this.outcome(rt, t.id, false, `watch failed: ${(e as Error).message}`))
            .finally(() => this.urlChecks.delete(key));
        }
      } catch (e) { this.outcome(rt, t.id, false, `watch failed: ${(e as Error).message}`); }
    }
    const control = readControl();
    const paused = control.paused && (!control.resumeAt || control.resumeAt > Date.now());
    if (!paused && readWebhooks(dir).deliveries.some(d => d.status === "pending")) void this.sender.tick(dir).catch(e => logbook.warn("triggers", "webhook delivery failed", String(e)));
  }
}
