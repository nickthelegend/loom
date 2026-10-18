import type { EventJournal } from "../../core/eventlog.js";
import { blockedBy } from "../../core/goal-lanes.js";
import { OrchestraEngine } from "../../core/orchestra.js";
import {
  PromptQueue,
  describeCondition,
  type QueueCondition,
  type QueueInput,
  type QueueItem,
  type QueueState,
  type QueueTarget,
} from "../../core/prompt-queue.js";
import { type MergeOutcome } from "../../core/worktree-merge.js";
import type {
  AnyAgent,
  ProjectConfig,
  RouteState, RouteStepSpec, RouterKind
} from "../../types.js";
import { isAdapter } from "../../types.js";
import { CLOCK_TICK_MS, questionHold } from '../runtime-support.js';
import type { TurnOptions, TurnResult } from "./turns.js";

/** Dependencies owned by the project coordinator, read live for each operation. */
export interface RuntimeQueueHost {
  queue: PromptQueue;
  agents: ReadonlyMap<string, AnyAgent>;
  routeState: () => RouteState | null;
  validHolder: () => string | null;
  orchestra: OrchestraEngine;
  config: ProjectConfig;
  busySince: Map<string, number>;
  closed: boolean;
  appendIfOpen: (event: Parameters<EventJournal["append"]>[0]) => void;
  startRoute: (opts: { task: string; spec?: string | RouteStepSpec[]; router?: RouterKind; maxHops?: number; }) => Promise<RouteState>;
  handoff: (to: string, opts?: { source?: "user" | "route"; }) => Promise<{ from: string | null; merge?: MergeOutcome; }>;
  sendMessage: (text: string, agentId?: string, opts?: TurnOptions) => Promise<TurnResult>;
}

/** Owns queue state for exactly one open project. */
export class RuntimeQueue {
  constructor(private readonly host: RuntimeQueueHost) { }

  queueListeners = new Set<(s: QueueState) => void>();

  draining = false;

  /** When the project last went quiet, for a "after N quiet minutes" condition. */
  quietSince = 0;

  clockTimer: ReturnType<typeof setInterval> | null = null;

  /** Live queue changes, for the socket. Returns unsubscribe. */
  onQueueChange(cb: (q: QueueState) => void): () => void {
    this.queueListeners.add(cb);
    return () => this.queueListeners.delete(cb);
  }

  /** Line a prompt up; it goes as soon as nothing ahead of it is in the way. */
  enqueue(input: QueueInput): QueueItem {
    const t = input.target ?? { kind: "auto" as const };
    if (t.kind === "agent") this.mustTakeTurns(t.agentId);
    const item = this.host.queue.add(input);
    this.kickQueue();
    return item;
  }

  /** Change a waiting prompt. A target this project can't run is refused now,
   * not when the queue reaches it and has to stop. */
  editQueued(itemId: string, patch: { text?: string; target?: QueueTarget; plan?: boolean; when?: QueueCondition | null }): QueueItem {
    if (patch.target?.kind === "agent") this.mustTakeTurns(patch.target.agentId);
    const item = this.host.queue.edit(itemId, patch);
    this.kickQueue();
    return item;
  }

  /** An agent in this project that can hold the baton, or the reason it can't. */
  mustTakeTurns(agentId: string): void {
    const agent = this.host.agents.get(agentId);
    if (!agent) throw new Error(`no agent "${agentId}" in this project`);
    if (!isAdapter(agent)) throw new Error(`agent "${agentId}" is a bridge (read-only) — it cannot take turns`);
  }

  /** Why the head can't go yet, or null when it can. */
  queueBlocker(item: QueueItem): string | null {
    // A condition comes first: a prompt held for 3am isn't waiting on an agent.
    if (this.host.config.brain?.continuity && this.host.busySince.size) return "waiting for the foreground native turn";
    const held = item.when ? this.conditionUnmet(item.when) : null;
    if (held) return held;
    const route = this.host.routeState();
    const routing = route && (route.status === "running" || route.status === "waiting_human");
    const holder = this.host.validHolder();
    if (item.target.kind === "orchestra") {
      const running = this.host.orchestra.runningScopes();
      if (!running.length) return null;
      const allowed = Math.max(1, this.host.config.maxConcurrentGoals ?? 1);
      // With lanes on, a queued goal that can't collide with what's running
      // starts beside it; the rest wait, with the overlap named.
      return blockedBy({ runId: "queued", goal: item.text, paths: [] }, running, allowed)
        ?? null;
    }
    if (routing) return "waiting for the running route";
    if (item.target.kind === "agent" && this.host.busySince.has(item.target.agentId)) return `waiting for ${item.target.agentId} to finish its turn`;
    if (holder && this.host.busySince.has(holder)) return `waiting for ${holder} to finish its turn`;
    return null;
  }

  /**
   * Is a queued prompt's condition still unmet? The reason, or null to go.
   *
   * Every branch reads a fact the daemon already has — the clock, a goal's
   * landing state, its checks — so nothing here can be wrong in an interesting
   * way. A condition about a goal that no longer exists releases the prompt
   * rather than holding it for ever.
   */
  conditionUnmet(when: QueueCondition): string | null {
    if (when.kind === "at") {
      return Date.now() >= when.at ? null : describeCondition(when);
    }
    if (when.kind === "quiet") {
      const busy = this.host.busySince.size > 0 || Boolean(this.host.orchestra.active());
      if (busy) {
        this.quietSince = 0;
        return describeCondition(when);
      }
      if (!this.quietSince) this.quietSince = Date.now();
      return Date.now() - this.quietSince >= when.ms ? null : describeCondition(when);
    }
    const run = this.host.orchestra.get(when.runId);
    if (!run) return null; // the goal is gone: holding for it for ever helps nobody
    if (when.kind === "landed") {
      return run.landing?.state === "merged" ? null : describeCondition(when);
    }
    const checks = run.landing?.checks;
    const green = Boolean(checks && !checks.failing.length && !checks.pending.length && checks.passing > 0);
    return green ? null : describeCondition(when);
  }

  /**
   * A prompt held for an hour needs something to notice the hour arriving.
   *
   * Only ticks while such a prompt exists — the queue's other conditions are
   * woken by the events they wait on (a goal landing, checks going green), and
   * a timer that runs when nothing needs it is a battery someone else pays for.
   */
  watchClockConditions(q: QueueState): void {
    const needsClock = q.items.some((i) => i.when && (i.when.kind === "at" || i.when.kind === "quiet"));
    if (needsClock && !this.clockTimer) {
      this.clockTimer = setInterval(() => this.kickQueue(), CLOCK_TICK_MS);
      this.clockTimer.unref?.();
    } else if (!needsClock && this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  /**
   * Hold the queue because `agentId` asked the human something — but only when
   * the queue is actually pointed at that agent. An orchestra worker's question
   * is the orchestrator's to answer (see core/orchestra.ts) and shouldn't
   * freeze a queue lined up for someone else.
   */
  holdQueueFor(agentId: string): void {
    const head = this.host.queue.peek();
    if (!head || this.host.queue.paused) return;
    const mine = head.target.kind === "agent" ? head.target.agentId === agentId : head.target.kind === "auto";
    if (!mine) return;
    this.host.queue.setPaused(true, questionHold(agentId));
  }

  /**
   * You answered, so the hold is over.
   *
   * Only a hold this agent's own question put there: a queue you paused
   * yourself stays paused, and so does one stopped mid-turn. Without this, the
   * next thing you typed while the agent worked would queue behind the held
   * prompt and sit there, in a queue nothing was going to resume.
   */
  releaseQuestionHold(agentId: string): void {
    if (!this.host.queue.paused || this.host.queue.snapshot().reason !== questionHold(agentId)) return;
    this.host.queue.setPaused(false);
  }

  kickQueue(): void {
    if (this.host.closed || this.draining || this.host.queue.paused || !this.host.queue.length) return;
    queueMicrotask(() => void this.drainPromptQueue());
  }

  private holds = 0;
  /** Queue items being sent right now (by id): a second dispatch of the same one is dropped. */
  private dispatching = new Set<string>();

  /**
   * Keep the queue still while a follow-up to the turn just stopped goes in (a loop nudge, a hand-off):
   * otherwise the next queued task starts in the gap, on the same tree, and the follow-up lands after it (#285).
   * Returns the release.
   */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => { if (released) return; released = true; this.holds--; this.kickQueue(); };
  }

  /** Send the head of the queue if it may go; then look again. */
  async drainPromptQueue(): Promise<void> {
    if (this.host.closed || this.draining || this.holds > 0 || this.host.queue.paused) return;
    const head = this.host.queue.peek();
    if (!head || this.queueBlocker(head)) return;
    this.draining = true;
    // Out of the queue, then sent: what you can still see is what hasn't gone.
    // (Leaving it in place until the send returns would survive a crash
    // mid-dispatch, at the price of a prompt you can edit or remove after it
    // has already reached the agent — a worse thing to be wrong about.)
    const item = this.host.queue.shift()!;
    try {
      await this.dispatchQueued(item);
    } catch (err) {
      // refused (budget, quarantine, policy, a missing agent): keep it where it
      // was and stop, so you can edit it or send it elsewhere — never drop it
      const message = err instanceof Error ? err.message : String(err);
      if (!this.host.closed) {
        this.host.queue.unshift(item);
        this.host.queue.setPaused(true, `the next prompt wasn't sent: ${message}`);
        this.host.appendIfOpen({ kind: "error", chat: item.chat, payload: { message: `queued prompt not sent: ${message}` } });
      }
    } finally {
      this.draining = false;
    }
    this.kickQueue();
  }

  async dispatchQueued(item: QueueItem): Promise<void> {
    const t = item.target;
    if (t.kind === "orchestra") {
      await this.host.orchestra.start({
        goal: item.text,
        // A queued goal remembers the thread it was typed in. sendMessage
        // below always honoured that; this branch dropped it (#100).
        ...(item.chat ? { chat: item.chat } : {}),
        ...(t.orchestrator ? { orchestrator: t.orchestrator } : {}),
        ...(t.workers?.length ? { workers: t.workers } : {}),
        ...(t.maxParallel ? { maxParallel: t.maxParallel } : {}),
        ...(t.maxUsd ? { maxUsd: t.maxUsd } : {}),
        ...(item.plan ? { plan: true } : {}),
      });
      return;
    }
    if (t.kind === "auto" && !item.plan) {
      await this.host.startRoute({ task: item.text, spec: "auto" });
      return;
    }
    // one agent: the baton moves to it first, as when you pick it and send
    const to = t.kind === "agent" ? t.agentId : undefined;
    // A queued prompt goes once. After a restart one task went twice in the same millisecond, and each
    // send cut the other's turn short — five starts and stops in nine seconds (#302).
    if (this.dispatching.has(item.id)) return;
    const holder = this.host.validHolder();
    if (to && holder && holder !== to) await this.host.handoff(to, { source: item.source });
    // ...and never over a turn: an agent that's mid-turn by the time we get here gets it back, first in line
    const target = to ?? this.host.validHolder();
    if (target && this.host.busySince.has(target)) { this.host.queue.unshift(item); return; }
    this.dispatching.add(item.id);
    setTimeout(() => this.dispatching.delete(item.id), 60_000).unref?.();
    await this.host.sendMessage(item.text, to, { source: item.source, chat: item.chat, fromQueue: true,
      requestId: item.continuity?.requestId ?? (item.editedAt ? `queue:${item.id}:edit:${item.editedAt}` : `queue:${item.id}`),
      ...(item.continuity ? { capturedModel: item.continuity.model } : {}),
      ...(item.plan ? { plan: true } : {}),
      ...(item.length ? { length: item.length } : {}) });
  }
}
