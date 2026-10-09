/**
 * Where the money and the tokens went: one walk over a project's event log,
 * broken down by agent, by model, by chat, by day and by tool.
 *
 * The totals follow the accounting rule (runtime/accounting.ts): a turn's
 * dollars arrive on a `turn_cost` status, and the same figure may be copied
 * onto `run_complete` — counting both would double it. So a turn's cost is
 * the `turn_cost` seen for that agent since its last turn ended, or, when an
 * adapter only reported it on `run_complete`, that. Every dollar lands on the
 * turn that spent it, which is what lets it be split by model and chat.
 *
 * Nothing is invented: an adapter that reports no price (a subscription CLI, a
 * free model) shows tokens and $0, and `unpriced` counts those turns so the UI
 * can say the total is a floor, not the bill.
 */

import type { LoomEvent } from "../types.js";

export interface UsageSlice {
  usd: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** The part of tokensIn served from the provider's cache. */
  cachedIn: number;
  /** The part of tokensOut spent thinking. */
  reasoning: number;
  ms: number;
}

export interface UsageAgent extends UsageSlice {
  agentId: string;
  kind?: string;
  models: string[];
  toolCalls: number;
  toolFailures: number;
  errors: number;
  /** Turns that reported tokens but no price. */
  unpriced: number;
}

export interface UsageReport {
  since: number;
  totals: UsageSlice & {
    toolCalls: number;
    toolFailures: number;
    errors: number;
    prompts: number;
    questions: number;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    unpriced: number;
    /** Derived, so every client says the same thing. */
    avgTurnMs: number;
    usdPerTurn: number;
    cacheHitRate: number;
  };
  byAgent: UsageAgent[];
  byModel: Array<UsageSlice & { model: string }>;
  byChat: Array<UsageSlice & { chat: string }>;
  byDay: Array<UsageSlice & { day: string }>;
  byTool: Array<{ tool: string; calls: number; failures: number }>;
}

const blank = (): UsageSlice => ({ usd: 0, turns: 0, tokensIn: 0, tokensOut: 0, cachedIn: 0, reasoning: 0, ms: 0 });

function add(into: UsageSlice, t: UsageSlice): void {
  into.usd += t.usd;
  into.turns += t.turns;
  into.tokensIn += t.tokensIn;
  into.tokensOut += t.tokensOut;
  into.cachedIn += t.cachedIn;
  into.reasoning += t.reasoning;
  into.ms += t.ms;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Local calendar day, as the Observatory's daily series counts it. */
function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function usageReport(
  events: readonly LoomEvent[],
  opts: { since?: number; kinds?: Record<string, string>; models?: Record<string, string> } = {},
): UsageReport {
  const since = opts.since ?? 0;
  const agents = new Map<string, UsageAgent>();
  const models = new Map<string, UsageSlice>();
  const chats = new Map<string, UsageSlice>();
  const days = new Map<string, UsageSlice>();
  const tools = new Map<string, { calls: number; failures: number }>();
  const pending = new Map<string, number>(); // agent → turn_cost not yet tied to a turn
  const totals = blank();
  let toolCalls = 0, toolFailures = 0, errors = 0, prompts = 0, questions = 0, filesChanged = 0, linesAdded = 0, linesRemoved = 0, unpriced = 0;

  const agent = (id: string): UsageAgent => {
    let a = agents.get(id);
    if (!a) {
      a = { agentId: id, ...(opts.kinds?.[id] ? { kind: opts.kinds[id] } : {}), ...blank(), models: [], toolCalls: 0, toolFailures: 0, errors: 0, unpriced: 0 };
      agents.set(id, a);
    }
    return a;
  };
  const slice = <K>(m: Map<K, UsageSlice>, k: K): UsageSlice => {
    let s = m.get(k);
    if (!s) m.set(k, (s = blank()));
    return s;
  };

  for (const e of events) {
    if (e.ts < since) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const who = e.agentId ?? "unknown";

    if (e.kind === "status" && p.state === "turn_cost") {
      pending.set(who, (pending.get(who) ?? 0) + num(p.costUsd));
      continue;
    }
    if (e.kind === "run_complete") {
      const owed = pending.get(who) ?? 0;
      pending.delete(who);
      const usd = owed > 0 ? owed : num(p.costUsd);
      const t: UsageSlice = {
        usd,
        turns: 1,
        tokensIn: num(p.inputTokens ?? p.tokensIn),
        tokensOut: num(p.outputTokens ?? p.tokensOut),
        cachedIn: num(p.cachedInputTokens),
        reasoning: num(p.reasoningTokens),
        ms: num(p.durationMs),
      };
      // a turn that didn't name its model ran on whatever the agent defaults to
      const model = String(p.model ?? opts.models?.[who] ?? "") || (opts.kinds?.[who] ? `${opts.kinds[who]} · default model` : "unknown");
      const a = agent(who);
      add(a, t);
      if (!a.models.includes(model)) a.models.push(model);
      if (!usd && (t.tokensIn || t.tokensOut)) {
        a.unpriced++;
        unpriced++;
      }
      add(totals, t);
      add(slice(models, model), t);
      add(slice(chats, e.chat ?? "main"), t);
      add(slice(days, dayOf(e.ts)), t);
      continue;
    }
    if (e.kind === "tool_call") {
      const failed = p.ok === false || !!p.error || (typeof p.exitCode === "number" && p.exitCode !== 0);
      const name = String(p.server ? `${String(p.server)}.${String(p.tool ?? "tool")}` : p.tool ?? "tool");
      const t = tools.get(name) ?? { calls: 0, failures: 0 };
      t.calls++;
      if (failed) t.failures++;
      tools.set(name, t);
      const a = agent(who);
      a.toolCalls++;
      toolCalls++;
      if (failed) {
        a.toolFailures++;
        toolFailures++;
      }
      continue;
    }
    if (e.kind === "error") {
      if (e.agentId) agent(who).errors++;
      errors++;
      continue;
    }
    if (e.kind === "message" && !e.agentId) prompts++;
    else if (e.kind === "needs_input") questions++;
    else if (e.kind === "turn_diff") {
      filesChanged += Array.isArray(p.files) ? p.files.length : 0;
      linesAdded += num(p.added);
      linesRemoved += num(p.removed);
    }
  }
  // money reported with no turn after it (an interrupted turn) still counts
  for (const [who, usd] of pending) {
    if (!usd) continue;
    agent(who).usd += usd;
    totals.usd += usd;
    slice(models, opts.models?.[who] || "unknown").usd += usd;
  }

  const bySpend = <T extends UsageSlice>(a: T, b: T) => b.usd - a.usd || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || b.turns - a.turns;
  return {
    since,
    totals: {
      ...totals,
      toolCalls,
      toolFailures,
      errors,
      prompts,
      questions,
      filesChanged,
      linesAdded,
      linesRemoved,
      unpriced,
      avgTurnMs: totals.turns ? Math.round(totals.ms / totals.turns) : 0,
      usdPerTurn: totals.turns ? totals.usd / totals.turns : 0,
      cacheHitRate: totals.tokensIn ? totals.cachedIn / totals.tokensIn : 0,
    },
    byAgent: [...agents.values()].sort(bySpend),
    byModel: [...models.entries()].map(([model, s]) => ({ model, ...s })).sort(bySpend),
    byChat: [...chats.entries()].map(([chat, s]) => ({ chat, ...s })).sort(bySpend).slice(0, 20),
    byDay: [...days.entries()].map(([day, s]) => ({ day, ...s })).sort((a, b) => a.day.localeCompare(b.day)),
    byTool: [...tools.entries()].map(([tool, t]) => ({ tool, ...t })).sort((a, b) => b.calls - a.calls).slice(0, 20),
  };
}
