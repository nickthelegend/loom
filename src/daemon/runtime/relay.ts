/**
 * Quota Relay: when an agent runs out of quota mid-task, the next one carries
 * on, with the context, and the first takes the chat back when it resets.
 *
 * Recognising the limit is core/quota.ts. Here: which agent picks up (the
 * project's `relay.to` order, or the other CLI agents in roster order — never
 * a paid API model unless you list it), stopping the parked turn, handing the
 * baton over with a briefing that says what happened, re-sending the request
 * in the same chat, and — when nobody is left — queueing it for the moment the
 * first agent's limit lifts. Everything it does is a `status` event in the
 * thread, so the record says who did what and why.
 */

import { backAt, quotaHit, type QuotaHit } from "../../core/quota.js";
import type { AgentConfig, EventKind, LoomEvent } from "../../types.js";
import { MAIN_CHAT } from "../../types.js";
import type { QueueInput } from "../../core/prompt-queue.js";

export interface RelayConfig {
  /** Off: a limit is reported, the work waits (default on). */
  auto?: boolean;
  /** Who picks up, in order (agent ids). Default: every other CLI agent in roster order. */
  to?: string[];
  /** Give the chat back to the first agent when its limit resets (default on). */
  handBack?: boolean;
}

export interface RelayHost {
  config(): { relay?: RelayConfig; agents: AgentConfig[] };
  busy(agentId: string): boolean;
  /** The chat an agent's current turn is in. */
  turnChat(agentId: string): string | undefined;
  available(agentId: string): Promise<boolean>;
  interrupt(chat: string): Promise<unknown>;
  handoff(to: string): Promise<unknown>;
  holder(): string | null;
  setBriefing(agentId: string, text: string): void;
  send(text: string, agentId: string, chat: string): Promise<unknown>;
  enqueue(input: QueueInput): unknown;
  list(opts: { chat?: string; limit?: number; kinds?: EventKind[] }): LoomEvent[];
  append(e: { kind: EventKind; agentId?: string; chat?: string; payload: Record<string, unknown> }): LoomEvent;
  warn(message: string, detail?: unknown): void;
}

/** Kinds that are subscriptions with windows, not metered APIs — safe to hand work to by default. */
const CLI_KINDS = new Set(["claude-code", "codex", "opencode", "grok-code", "antigravity-cli", "agy"]);

export class QuotaRelay {
  /** agentId → when its limit lifts. */
  private capped = new Map<string, { resetAt: number; timer: ReturnType<typeof setTimeout> | null; handedTo?: string; chat?: string }>();
  /** One relay per request: `${chat}:${requestEventId}`. */
  private relayed = new Set<string>();

  constructor(private readonly host: RelayHost) {}

  /** Is this agent out of quota right now? */
  cappedUntil(agentId: string, now = Date.now()): number | null {
    const c = this.capped.get(agentId);
    return c && c.resetAt > now ? c.resetAt : null;
  }

  /** Every agent out of quota, and until when — for status and the UI. */
  caps(now = Date.now()): Record<string, number> {
    return Object.fromEntries([...this.capped].filter(([, c]) => c.resetAt > now).map(([id, c]) => [id, c.resetAt]));
  }

  /**
   * Where a new prompt for `agentId` should go: itself, or — while it's out of
   * quota and relaying is on — whoever would pick up its work.
   */
  async route(agentId: string, chat = MAIN_CHAT): Promise<string> {
    // the window reset but the baton isn't back yet (its timer hasn't fired, or the hand-back is
    // mid-flight): finish giving it back first, so the prompt goes to the agent it was meant for
    const c = this.capped.get(agentId);
    if (c && !this.cappedUntil(agentId)) {
      if (c.timer) clearTimeout(c.timer);
      await this.lift(agentId);
    }
    // its stand-in was mid-turn at the reset, so the baton was going back when that turn ended;
    // a prompt for this agent now is you choosing it — give it back now, as picking it and sending does
    const standIn = this.waitingBack.get(agentId);
    if (standIn) {
      this.waitingBack.delete(agentId);
      if (this.host.holder() === standIn) await this.giveBack(agentId);
    }
    const lifting = this.lifting.get(agentId);
    if (lifting) await lifting;
    if (!this.cappedUntil(agentId) || this.host.config().relay?.auto === false) return agentId;
    const next = await this.next(agentId);
    if (!next) return agentId;
    this.host.append({ kind: "status", chat: chat === MAIN_CHAT ? undefined : chat, payload: {
      state: "quota_redirect", from: agentId, to: next, resetAt: this.cappedUntil(agentId),
      text: `${agentId} is out of quota until ${backAt(this.cappedUntil(agentId)!)} — ${next} takes this one` } });
    return next;
  }

  /** Every agent event passes through: a limit starts a relay. */
  observe(event: LoomEvent): void {
    if (!event.agentId) return;
    if (event.kind === "run_complete") for (const [agentId, standIn] of [...this.waitingBack]) {
      if (standIn !== event.agentId) continue;
      this.waitingBack.delete(agentId);
      if (this.host.holder() === standIn) this.giveBack(agentId);
    }
    const hit = quotaHit(event);
    if (hit) void this.onLimit(event.agentId, event, hit).catch((err) => this.host.warn("quota relay failed", err));
  }

  private async onLimit(agentId: string, event: LoomEvent, hit: QuotaHit): Promise<void> {
    const chat = event.chat ?? this.host.turnChat(agentId) ?? MAIN_CHAT;
    const already = this.capped.get(agentId);
    if (!already || already.resetAt < hit.resetAt) this.cap(agentId, hit.resetAt, chat);
    const request = this.lastRequest(chat, event.id);
    const key = `${chat}:${request?.id ?? event.id}`;
    if (this.relayed.has(key)) return;
    this.relayed.add(key);
    if (this.relayed.size > 500) this.relayed.delete(this.relayed.values().next().value!);
    const where = chat === MAIN_CHAT ? undefined : chat;
    const back = backAt(hit.resetAt);

    if (this.host.config().relay?.auto === false || !request) {
      this.host.append({ kind: "status", agentId, chat: where, payload: { state: "quota_limit", resetAt: hit.resetAt, known: hit.known,
        reason: hit.reason, text: `${agentId} is out of quota${hit.known ? ` until ${back}` : ""}; the work waits${request ? " (relay is off)" : ""}` } });
      return;
    }

    // a parked turn (Claude waits inside the CLI until the reset) is stopped, so it can be handed on
    if (this.host.busy(agentId)) await this.host.interrupt(chat).catch(() => {});
    const next = await this.next(agentId);
    const prompt = String(request.payload.text ?? "");
    if (!next) {
      // nobody left: the request waits in the queue for the first agent's reset
      this.host.enqueue({ text: prompt, target: { kind: "agent", agentId }, chat, source: "route", when: { kind: "at", at: hit.resetAt } } as QueueInput);
      this.host.append({ kind: "status", agentId, chat: where, payload: { state: "quota_relay", from: agentId, to: null, resetAt: hit.resetAt,
        reason: hit.reason, text: `${agentId} is out of quota and no other agent can take over — queued for ${back}, when it resets` } });
      return;
    }
    const c = this.capped.get(agentId);
    if (c) { c.handedTo = next; c.chat = chat; }
    this.host.append({ kind: "status", agentId, chat: where, payload: { state: "quota_relay", from: agentId, to: next, resetAt: hit.resetAt,
      known: hit.known, reason: hit.reason, text: `${agentId} hit its usage limit — ${next} carries on${hit.known ? `; ${agentId} is back around ${back}` : ""}` } });
    await this.host.handoff(next);
    this.host.setBriefing(next, [
      `[Loom quota relay] "${agentId}" was working on this request and ran out of usage quota (${hit.reason}).`,
      "Its changes so far are in the working tree — read them before you change anything, then continue the task from where it stopped.",
      "Don't start over unless what it did is wrong; say what you kept.",
    ].join("\n"));
    await this.host.send(prompt, next, chat);
  }

  /** Who picks up from `from`: the configured order, else the other CLI agents; available, not capped, not busy. */
  private async next(from: string): Promise<string | null> {
    const cfg = this.host.config();
    const enabled = cfg.agents.filter((a) => a.enabled !== false && a.id !== from);
    const order = cfg.relay?.to?.length
      ? cfg.relay.to.map((id) => enabled.find((a) => a.id === id)).filter((a): a is AgentConfig => Boolean(a))
      : enabled.filter((a) => CLI_KINDS.has(a.kind) || a.kind === "echo");
    for (const a of order) {
      if (this.cappedUntil(a.id) || this.host.busy(a.id)) continue;
      if (await this.host.available(a.id).catch(() => false)) return a.id;
    }
    return null;
  }

  private cap(agentId: string, resetAt: number, chat: string): void {
    const prev = this.capped.get(agentId);
    if (prev?.timer) clearTimeout(prev.timer);
    const delay = Math.max(0, Math.min(resetAt - Date.now(), 2 ** 31 - 1));
    const timer = setTimeout(() => void this.lift(agentId), delay);
    timer.unref?.();
    this.capped.set(agentId, { resetAt, timer, ...(prev?.handedTo ? { handedTo: prev.handedTo } : {}), chat: prev?.chat ?? chat });
  }

  /** Hand-backs under way, so a prompt that arrives mid-way waits for the baton instead of missing it. */
  private lifting = new Map<string, Promise<void>>();

  /** Reset, but its stand-in was mid-turn: the baton goes back when that turn ends (agent → stand-in). */
  private waitingBack = new Map<string, string>();

  /** Is the relay still holding this agent's work — out of quota, or not yet handed back? */
  holds(agentId: string): boolean { return this.capped.has(agentId) || this.lifting.has(agentId) || this.waitingBack.has(agentId); }

  private backTimers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Give the baton back once the stand-in is idle. Its run_complete usually says when (observe), but
   * a turn winds down a moment after that event — a reset landing in between saw it "busy" with no
   * run_complete left to come — so it is also looked at twice a second until then.
   */
  private waitBack(agentId: string, standIn: string): void {
    this.waitingBack.set(agentId, standIn);
    if (this.backTimers.has(agentId)) return;
    const t = setInterval(() => {
      if (this.waitingBack.get(agentId) !== standIn) return this.stopWaitingBack(agentId);
      if (this.host.busy(standIn)) return;
      this.stopWaitingBack(agentId);
      this.waitingBack.delete(agentId);
      if (this.host.holder() === standIn) void this.giveBack(agentId);
    }, 500);
    t.unref?.();
    this.backTimers.set(agentId, t);
  }

  private stopWaitingBack(agentId: string): void {
    const t = this.backTimers.get(agentId);
    if (t) clearInterval(t);
    this.backTimers.delete(agentId);
  }

  private giveBack(agentId: string): Promise<void> {
    this.stopWaitingBack(agentId);
    const back = this.host.handoff(agentId).then(() => {}, () => {}).finally(() => this.lifting.delete(agentId));
    this.lifting.set(agentId, back);
    return back;
  }

  /** The limit lifted: say so, and (by default) give the chat back — now if the stand-in is idle, else when its turn ends. */
  private lift(agentId: string): Promise<void> {
    const c = this.capped.get(agentId);
    this.capped.delete(agentId);
    if (!c) return this.lifting.get(agentId) ?? Promise.resolve();
    const chat = c.chat && c.chat !== MAIN_CHAT ? c.chat : undefined;
    const wants = this.host.config().relay?.handBack !== false && c.handedTo && this.host.holder() === c.handedTo;
    const busy = Boolean(wants && this.host.busy(c.handedTo!));
    this.host.append({ kind: "status", agentId, chat, payload: { state: "quota_reset", agentId,
      text: `${agentId}'s usage limit reset${wants ? busy ? ` — the baton goes back to ${agentId} when ${c.handedTo} finishes` : ` — the baton is back with ${agentId}` : ""}` } });
    if (!wants) return Promise.resolve();
    // the stand-in is mid-turn: don't cut it off — hand back when that turn ends (observe), or sooner if you ask for this agent
    if (busy) { this.waitBack(agentId, c.handedTo!); return Promise.resolve(); }
    return this.giveBack(agentId);
  }

  /** The request the turn was answering: the last message in the chat from a person (or a route), before `at`. */
  private lastRequest(chat: string, at: number): LoomEvent | null {
    const recent = this.host.list({ chat, limit: 200 });
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i]!;
      if (e.id > at) continue;
      if (e.kind === "message" && !e.agentId && String(e.payload.text ?? "").trim()) return e;
    }
    return null;
  }

  stop(): void {
    for (const c of this.capped.values()) if (c.timer) clearTimeout(c.timer);
    this.capped.clear();
    this.waitingBack.clear();
    for (const t of this.backTimers.values()) clearInterval(t);
    this.backTimers.clear();
  }
}
