import type { EventJournal } from "../../core/eventlog.js";
import {
  readProjectState,
  writeProjectState
} from "../../core/registry.js";
import type {
  AgentCost,
  CostSummary,
  LoomEvent,
  ProjectInfo
} from "../../types.js";
import { Recent, forecastFrom, type Forecast } from "../../core/forecast.js";
import { estimateUsd, priceBook } from "../../core/prices.js";
import { BUDGET_PAUSE_REASON, BudgetExceededError, QuarantinedError, startOfDay } from '../runtime-support.js';

/** Dependencies owned by the project coordinator, read live for each operation. */
export interface RuntimeAccountingHost {
  log: EventJournal;
  appendIfOpen: (event: Parameters<EventJournal["append"]>[0]) => void;
  info: ProjectInfo;
}

/** Owns accounting state for exactly one open project. */
export class RuntimeAccounting {
  constructor(private readonly host: RuntimeAccountingHost) { }

  // -------------------------------------------------------------------------
  // Cost telemetry — O(1) incremental, rehydrated from the log on open
  // -------------------------------------------------------------------------

  costs = { totalUsd: 0, turns: 0, totalMs: 0, tokensIn: 0, tokensOut: 0 };

  costsByAgent = new Map<
    string,
    { usd: number; turns: number; ms: number; tokensIn: number; tokensOut: number }
  >();

  /** Whether an agent's current turn has reported money yet — a turn that ends without any is unpriced. */
  private pricedTurn = new Map<string, boolean>();
  /** Unpriced turns' tokens, per agent per model, priced only when asked (the price list may arrive later). */
  private unpriced = new Map<string, Map<string, { tokensIn: number; tokensOut: number; cachedIn: number }>>();

  /** Each agent's latest turns — cost and time — for the pre-flight forecast (core/forecast.ts). */
  private recent = new Map<string, { usd: Recent; ms: Recent }>();
  private recentFor(agentId: string) {
    let r = this.recent.get(agentId);
    if (!r) { r = { usd: new Recent(), ms: new Recent() }; this.recent.set(agentId, r); }
    return r;
  }

  /** What a turn on this agent usually costs and takes; null until it has a few turns behind it. */
  forecast(agentId: string): Forecast | null {
    const r = this.recent.get(agentId);
    if (!r) return null;
    const cap = this.budgets()[agentId];
    return forecastFrom(r.usd.values(), r.ms.values(),
      Number.isFinite(cap) && cap! > 0 ? { capUsd: cap!, spentUsd: this.spendTodayFor(agentId) } : undefined);
  }

  rehydrateCosts(): void {
    for (const event of this.host.log.list({ kinds: ["status", "run_complete"] })) {
      this.trackCost(event);
    }
  }

  trackCost(event: LoomEvent): void {
    const agentId = event.agentId ?? "unknown";
    const entry =
      this.costsByAgent.get(agentId) ?? { usd: 0, turns: 0, ms: 0, tokensIn: 0, tokensOut: 0 };
    if (event.kind === "status" && event.payload.state === "turn_cost") {
      const usd = Number(event.payload.costUsd ?? 0);
      if (usd > 0) {
        this.pricedTurn.set(agentId, true);
        this.recentFor(agentId).usd.push(usd);
        this.costs.totalUsd += usd;
        entry.usd += usd;
        this.costsByAgent.set(agentId, entry);
        // The moment the money crosses the cap, pause — don't wait for the next
        // dispatch to notice. enforceBudget still guards every dispatch (that's
        // the hard stop); this makes the pause visible when the spend happens,
        // so a looping agent shows as paused NOW rather than at its next ask,
        // and the burn panel's "over" and the roster's "paused" agree in time.
        const cap = this.budgets()[agentId];
        if (
          Number.isFinite(cap) &&
          cap! > 0 &&
          this.spendTodayFor(agentId) >= cap! &&
          !this.quarantined()[agentId]
        ) {
          this.quarantine(agentId, `${BUDGET_PAUSE_REASON}$${cap!.toFixed(2)}/day`, false);
          this.host.appendIfOpen({
            kind: "status",
            agentId,
            payload: { state: "budget_exceeded", budgetUsd: cap, spentTodayUsd: this.spendTodayFor(agentId) },
          });
        }
      }
    } else if (event.kind === "run_complete") {
      const ms = Number(event.payload.durationMs ?? 0);
      if (ms > 0 && !event.payload.error) this.recentFor(agentId).ms.push(ms);
      // Adapters that report token usage (codex, claude-code, …) carry it on
      // run_complete; cost-only adapters leave these 0. Either way the totals
      // stay honest — an absent number is never invented here.
      const tin = Number(event.payload.inputTokens ?? event.payload.tokensIn ?? 0) || 0;
      const tout = Number(event.payload.outputTokens ?? event.payload.tokensOut ?? 0) || 0;
      this.costs.turns += 1;
      this.costs.totalMs += ms;
      this.costs.tokensIn += tin;
      this.costs.tokensOut += tout;
      entry.turns += 1;
      entry.ms += ms;
      entry.tokensIn += tin;
      entry.tokensOut += tout;
      this.costsByAgent.set(agentId, entry);
      const priced = this.pricedTurn.get(agentId) || Number(event.payload.costUsd ?? 0) > 0;
      this.pricedTurn.delete(agentId);
      if (!priced && (tin || tout) && event.payload.model) {
        const byModel = this.unpriced.get(agentId) ?? new Map();
        const m = byModel.get(String(event.payload.model)) ?? { tokensIn: 0, tokensOut: 0, cachedIn: 0 };
        m.tokensIn += tin;
        m.tokensOut += tout;
        m.cachedIn += Number(event.payload.cachedInputTokens ?? 0) || 0;
        byModel.set(String(event.payload.model), m);
        this.unpriced.set(agentId, byModel);
      }
    }
  }

  /** An agent's unpriced tokens at API prices; undefined when there are none, or no price for them. */
  private estimateFor(agentId: string): number | undefined {
    const byModel = this.unpriced.get(agentId);
    if (!byModel) return undefined;
    const book = priceBook();
    let usd: number | undefined;
    for (const [model, t] of byModel) {
      const est = estimateUsd({ model, ...t }, book);
      if (est !== undefined) usd = (usd ?? 0) + est;
    }
    return usd;
  }

  costSummary(): CostSummary {
    const byAgent: AgentCost[] = [...this.costsByAgent.entries()]
      .map(([agentId, c]) => {
        const estUsd = this.estimateFor(agentId);
        return { agentId, ...c, ...(estUsd !== undefined ? { estUsd } : {}) };
      })
      .sort((a, b) => b.usd - a.usd || b.turns - a.turns);
    const estimated = byAgent.filter((a) => a.estUsd !== undefined);
    return {
      ...(estimated.length ? { estUsd: estimated.reduce((sum, a) => sum + a.estUsd!, 0) } : {}),
      totalUsd: this.costs.totalUsd,
      turns: this.costs.turns,
      totalMs: this.costs.totalMs,
      tokensIn: this.costs.tokensIn,
      tokensOut: this.costs.tokensOut,
      byAgent,
    };
  }

  /** Per-agent spend budgets (USD/day), set from the Observatory burn-rate panel. */
  budgets(): Record<string, number> {
    return readProjectState(this.host.info.dir).budgets ?? {};
  }

  /** Set (usd > 0) or clear (usd ≤ 0) one agent's daily budget; returns the new map. */
  setBudget(agentId: string, usdPerDay: number): Record<string, number> {
    const state = readProjectState(this.host.info.dir);
    const budgets = { ...(state.budgets ?? {}) };
    if (Number.isFinite(usdPerDay) && usdPerDay > 0) budgets[agentId] = usdPerDay;
    else delete budgets[agentId];
    writeProjectState(this.host.info.dir, { ...state, budgets });
    return budgets;
  }

  /**
   * What one agent has really spent since local midnight.
   *
   * Read from the log, using the same rule the running cost totals use: a
   * turn's money arrives on a `turn_cost` status and nowhere else. (The same
   * figure is copied onto `run_complete` for the exported span; counting both
   * would double every turn.) Adapters that report tokens but no dollars —
   * codex, agy — contribute 0, honestly, because they hand us no price.
   */
  spendTodayFor(agentId: string, now = Date.now()): number {
    const since = startOfDay(now);
    let usd = 0;
    for (const e of this.host.log.list({ kinds: ["status"], sinceTs: since })) {
      if (e.agentId !== agentId) continue;
      if (e.payload.state !== "turn_cost") continue;
      usd += Number(e.payload.costUsd ?? 0) || 0;
    }
    return usd;
  }

  /**
   * The spend ledger as a daily series, per agent per day.
   *
   * "What did this project cost me last week" had no answer short of reading
   * turn by turn. Same source of truth as spendTodayFor — turn_cost statuses
   * and nowhere else — bucketed by local day. Tokens ride along from
   * run_complete, keyed the same way, so 'which agent is eating the tokens'
   * (#17) is the same walk as 'what did this cost' (#16). Days with no spend
   * simply don't appear; a chart can zero-fill, the API doesn't lie.
   */
  costSeries(days = 30, now = Date.now()): Array<{
    day: string;
    usd: number;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    byAgent: Record<string, { usd: number; turns: number; tokensIn: number; tokensOut: number }>;
  }> {
    const since = startOfDay(now) - (days - 1) * 24 * 60 * 60 * 1000;
    const buckets = new Map<
      string,
      {
        usd: number;
        turns: number;
        tokensIn: number;
        tokensOut: number;
        byAgent: Record<string, { usd: number; turns: number; tokensIn: number; tokensOut: number }>;
      }
    >();
    const dayOf = (ts: number): string => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const bucket = (ts: number) => {
      const key = dayOf(ts);
      let b = buckets.get(key);
      if (!b) {
        b = { usd: 0, turns: 0, tokensIn: 0, tokensOut: 0, byAgent: {} };
        buckets.set(key, b);
      }
      return b;
    };
    const agentSlot = (
      b: ReturnType<typeof bucket>,
      agentId: string,
    ): { usd: number; turns: number; tokensIn: number; tokensOut: number } => {
      let s = b.byAgent[agentId];
      if (!s) {
        s = { usd: 0, turns: 0, tokensIn: 0, tokensOut: 0 };
        b.byAgent[agentId] = s;
      }
      return s;
    };
    for (const e of this.host.log.list({ kinds: ["status", "run_complete"], sinceTs: since })) {
      const agentId = e.agentId ?? "unknown";
      if (e.kind === "status" && e.payload.state === "turn_cost") {
        const usd = Number(e.payload.costUsd ?? 0) || 0;
        if (usd <= 0) continue;
        const b = bucket(e.ts);
        b.usd += usd;
        agentSlot(b, agentId).usd += usd;
      } else if (e.kind === "run_complete") {
        const tin = Number(e.payload.inputTokens ?? e.payload.tokensIn ?? 0) || 0;
        const tout = Number(e.payload.outputTokens ?? e.payload.tokensOut ?? 0) || 0;
        const b = bucket(e.ts);
        b.turns += 1;
        b.tokensIn += tin;
        b.tokensOut += tout;
        const s = agentSlot(b, agentId);
        s.turns += 1;
        s.tokensIn += tin;
        s.tokensOut += tout;
      }
    }
    return [...buckets.entries()]
      .map(([day, b]) => ({ day, ...b }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Every budgeted agent: its cap, what it has spent today, and whether it's out. */
  budgetStatus(now = Date.now()): Record<string, { budgetUsd: number; spentTodayUsd: number; over: boolean }> {
    const out: Record<string, { budgetUsd: number; spentTodayUsd: number; over: boolean }> = {};
    for (const [agentId, budgetUsd] of Object.entries(this.budgets())) {
      const spentTodayUsd = this.spendTodayFor(agentId, now);
      out[agentId] = { budgetUsd, spentTodayUsd, over: spentTodayUsd >= budgetUsd };
    }
    return out;
  }

  /**
   * Refuse to dispatch to an agent a firing alert has paused.
   *
   * The self-heal loop wrote quarantines into state and *nothing read them
   * back*: the webhook paused an agent, and the very next handoff or message
   * went straight to it. So the headline feature — the telemetry backend says
   * an agent is unhealthy, Loom takes it out of rotation — paused nothing at
   * all. It sat beside `enforceBudget`, which had exactly the same bug and was
   * fixed; this is the other half.
   *
   * Budget pauses are skipped here because `enforceBudget` owns them and can
   * lift them on its own (a new day, a raised cap). An alert pause only lifts
   * when the alert says resolved, so there is nothing to re-check.
   */
  enforceQuarantine(agentId: string): void {
    const q = this.quarantined()[agentId];
    if (!q || q.reason.startsWith(BUDGET_PAUSE_REASON)) return;
    throw new QuarantinedError(agentId, q.reason, q.since);
  }

  /**
   * Refuse a turn an agent can't afford.
   *
   * A budget that nothing checks is a text field, and that is all this was: the
   * burn panel wrote USD/day into state and no code path ever read it back, so
   * an agent with a $1 cap would happily spend $40. Now every dispatch — a
   * message you send, a baton hop, a route step — passes through here first.
   *
   * At or over the cap the agent is quarantined and the turn throws, taking the
   * same route through the UI as the self-heal alert pause (same state map,
   * same shape) so a paused agent looks paused however it got there. The pause
   * lifts itself: the spend is measured against the current day, so when the
   * day rolls over — or you raise the cap — the next attempt clears it and logs
   * the recovery. A budget of 0/unset means no budget, and nothing is enforced.
   */
  enforceBudget(agentId: string, now = Date.now()): void {
    const budgetUsd = this.budgets()[agentId];
    if (!Number.isFinite(budgetUsd) || !budgetUsd || budgetUsd <= 0) {
      this.liftBudgetPause(agentId, now);
      return;
    }
    const spentUsd = this.spendTodayFor(agentId, now);
    // a turn's cost only lands when it ends, so the cap was crossed by a whole turn ($8.47 of $8.00, #321):
    // under the cap but with less left than this agent's typical turn costs, it doesn't start one
    const typical = this.forecast(agentId)?.usd?.typical ?? 0;
    const wouldCross = typical > 0 && spentUsd < budgetUsd && spentUsd + typical > budgetUsd;
    if (spentUsd < budgetUsd && !wouldCross) {
      this.liftBudgetPause(agentId, now);
      return;
    }
    if (!this.quarantined()[agentId]) {
      this.quarantine(agentId, `${BUDGET_PAUSE_REASON}$${budgetUsd.toFixed(2)}/day`, false, now);
    }
    // One event per refusal, not one per pause: the thread should show every
    // turn that didn't happen, not just the first.
    this.host.log.append({
      kind: "status",
      agentId,
      payload: { state: "budget_exceeded", budgetUsd, spentTodayUsd: spentUsd, ...(wouldCross ? { wouldCross: true, typicalTurnUsd: typical } : {}) },
    });
    throw new BudgetExceededError(agentId, budgetUsd, spentUsd, wouldCross ? typical : undefined);
  }

  /**
   * Lift a pause this guard put there, and only that one — a quarantine from a
   * firing alert is somebody else's to lift, and clearing it here would
   * un-pause an agent that is still broken.
   */
  liftBudgetPause(agentId: string, now = Date.now()): void {
    const q = this.quarantined()[agentId];
    if (!q?.reason.startsWith(BUDGET_PAUSE_REASON)) return;
    this.unquarantine(agentId);
    this.host.log.append({
      kind: "status",
      agentId,
      payload: { state: "budget_recovered", reason: q.reason, pausedMs: Math.max(0, now - q.since) },
    });
  }

  /** Agents currently paused by a firing alert (self-heal quarantine). */
  quarantined(): Record<string, { reason: string; since: number; displaced: boolean }> {
    return readProjectState(this.host.info.dir).quarantine ?? {};
  }

  /** Pause an agent (a firing alert). `displaced` marks that it lost the baton to a fallback. */
  quarantine(agentId: string, reason: string, displaced: boolean, now = Date.now()): void {
    const state = readProjectState(this.host.info.dir);
    const quarantine = { ...(state.quarantine ?? {}) };
    quarantine[agentId] = { reason, since: now, displaced };
    writeProjectState(this.host.info.dir, { ...state, quarantine });
  }

  /** Lift an agent's quarantine (its alert resolved); returns what it was, or null. */
  unquarantine(agentId: string): { reason: string; since: number; displaced: boolean } | null {
    const state = readProjectState(this.host.info.dir);
    const quarantine = { ...(state.quarantine ?? {}) };
    const prev = quarantine[agentId] ?? null;
    if (prev) {
      delete quarantine[agentId];
      writeProjectState(this.host.info.dir, { ...state, quarantine });
    }
    return prev;
  }
}
