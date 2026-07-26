/**
 * The Loom observability layer: folds LoomEvents into OpenTelemetry signals
 * and ships them over OTLP. One process-wide config, three exporters.
 *
 * Mapping (LoomEvent → span, GenAI semantic conventions where they apply):
 *   run_complete            → gen_ai.agent.turn   (duration, cost, tokens, model)
 *   tool_call               → gen_ai.tool.call
 *   handoff                 → loom.baton.handoff
 *   route_*                 → loom.route.<phase>
 *   memory_add/update/forget→ loom.memory.<op>
 *   error                   → span with ERROR status
 *
 * Metrics (LoomEvent → datapoint, see ./metrics.ts for names and temporality):
 *   run_complete            → gen_ai.client.token.usage, gen_ai.client.operation.duration,
 *                             loom.turns, loom.cost.usd (only if reported)
 *   status turn_started     → loom.agents.active
 *   handoff                 → loom.handoffs
 *
 * Logs (LoomEvent → log record, see ./logs.ts): the event stream itself,
 * correlated to the turn's trace so a span links to what the agent said.
 *
 * One event can produce all three. Callers still only call recordAgentEvent().
 */

import type { LoomEvent } from "../types.js";
import { LoomTelemetry, newTraceId, resolveTelemetryConfig, type TelemetryConfig, type SpanInput } from "./otlp.js";
import { LoomMetrics, type MetricAttributes } from "./metrics.js";
import { LoomLogs, eventToLogRecord } from "./logs.js";

let singleton: LoomTelemetry | null = null;
let metricsSingleton: LoomMetrics | null = null;
let logsSingleton: LoomLogs | null = null;
let sharedConfig: TelemetryConfig | null = null;

// One trace per agent turn: minted when a turn starts, reused by every span in
// that turn (tool calls, the completion), cleared when it ends — so the backend
// shows a real span tree per turn instead of one orphan span per event.
const turnTrace = new Map<string, string>();
/**
 * The trace of the turn that most recently CLOSED, per agent. The decision
 * miner runs off `run_complete` — i.e. after the turn's trace has been retired
 * — and still needs the id to link each decision to the spans it came out of.
 * One entry per agent, so this is bounded by the roster, not by history.
 */
const lastTurnTrace = new Map<string, string>();

/**
 * The trace id a span belongs to, advancing the per-agent turn as it goes.
 *
 * Also reports the turn boundary it just crossed, because the trace map is
 * already the one place that knows where an agent's turn begins and ends.
 * `opened` is true on the event that started a turn, `closed` on the one that
 * ended it — which is what the active-agents gauge counts.
 */
function traceIdFor(event: LoomEvent): { traceId: string; opened: boolean; closed: boolean } {
  const agent = event.agentId ?? "";
  const isTurnStart = event.kind === "status" && (event.payload as Record<string, unknown>)?.state === "turn_started";
  const opened = isTurnStart || !turnTrace.has(agent);
  if (opened) turnTrace.set(agent, newTraceId());
  const traceId = turnTrace.get(agent)!;
  // A turn ends when it completes — or when it dies. An adapter that throws
  // emits `error` and may never reach run_complete; treating only the happy
  // path as an ending would leave the trace (and the gauge) open forever.
  const closed = event.kind === "run_complete" || event.kind === "error";
  if (closed) {
    lastTurnTrace.set(agent, traceId);
    turnTrace.delete(agent); // this span closes the turn
  }
  return { traceId, opened, closed };
}

/**
 * The trace id of an agent's in-flight turn, or the one that just finished.
 *
 * Undefined when telemetry is off, because then no trace was ever minted and
 * there is nothing in the backend to link to. Callers must leave the field out
 * rather than substituting "" — an empty trace id renders as a link that opens
 * a search for nothing, which reads as a broken feature rather than an absent
 * one.
 */
export function turnTraceId(agentId: string): string | undefined {
  return turnTrace.get(agentId) ?? lastTurnTrace.get(agentId);
}

/**
 * One resolved config for all three signals.
 *
 * Resolved once and shared so traces, metrics and logs can never disagree about
 * the endpoint or the service name — a metric filed under a different
 * service.name than its trace is invisible in the backend's service view, and
 * that failure is silent.
 */
function config(): TelemetryConfig {
  if (!sharedConfig) sharedConfig = resolveTelemetryConfig();
  return sharedConfig;
}

export function telemetry(): LoomTelemetry {
  if (!singleton) singleton = new LoomTelemetry(config());
  return singleton;
}

export function metrics(): LoomMetrics {
  if (!metricsSingleton) metricsSingleton = new LoomMetrics(config());
  return metricsSingleton;
}

export function logs(): LoomLogs {
  if (!logsSingleton) logsSingleton = new LoomLogs(config());
  return logsSingleton;
}

/** Push every buffered signal now — for shutdown, and for tests that assert. */
export function flushTelemetry(): void {
  singleton?.flush();
  metricsSingleton?.flush();
  logsSingleton?.flush();
}

const MS_TO_NS = 1_000_000n;

function nsWindow(endMs: number, durationMs: number): { startNs: bigint; endNs: bigint } {
  const end = BigInt(Math.max(0, Math.round(endMs)));
  const dur = BigInt(Math.max(0, Math.round(durationMs)));
  return { startNs: (end - dur) * MS_TO_NS, endNs: end * MS_TO_NS };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export type EventContext = { project?: string };

/**
 * Pure mapper: a LoomEvent → the span it should emit, or null for kinds that
 * aren't telemetry-worthy. Exported so the mapping is unit-testable without a
 * live exporter or collector.
 */
export function eventToSpan(event: LoomEvent, ctx: EventContext = {}): SpanInput | null {
  const p = event.payload ?? {};
  const base = {
    "loom.project": ctx.project,
    "loom.chat": event.chat,
    "loom.event.kind": event.kind,
    "gen_ai.agent.id": event.agentId,
  };
  switch (event.kind) {
    case "run_complete": {
      const durationMs = num(p.durationMs) ?? 0;
      return {
        name: "gen_ai.agent.turn",
        ...nsWindow(event.ts, durationMs),
        attributes: {
          ...base,
          "gen_ai.system": str(p.adapter) || str(p.system) || "loom",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": str(p.model) || undefined,
          "gen_ai.usage.input_tokens": num(p.tokensIn) ?? num(p.inputTokens),
          "gen_ai.usage.output_tokens": num(p.tokensOut) ?? num(p.outputTokens),
          "gen_ai.usage.cost_usd": num(p.costUsd),
          "loom.turn.duration_ms": durationMs,
        },
        error: p.error ? str(p.error) : undefined,
      };
    }
    case "tool_call":
      return {
        name: "gen_ai.tool.call",
        ...nsWindow(event.ts, num(p.durationMs) ?? 0),
        attributes: { ...base, "gen_ai.tool.name": str(p.tool) || str(p.name) || "tool" },
      };
    case "handoff":
      return {
        name: "loom.baton.handoff",
        ...nsWindow(event.ts, 0),
        attributes: {
          ...base,
          "loom.handoff.to": str(p.to) || str(p.agent),
          "loom.handoff.from": str(p.from) || event.agentId,
        },
      };
    case "route_started":
    case "route_step":
    case "route_paused":
    case "route_resumed":
    case "route_completed":
    case "route_failed":
      return {
        name: `loom.route.${event.kind.slice("route_".length)}`,
        ...nsWindow(event.ts, num(p.durationMs) ?? 0),
        attributes: { ...base, "loom.route.id": str(p.routeId) || str(p.id) },
        error: event.kind === "route_failed" ? str(p.error) || "route failed" : undefined,
      };
    case "memory_add":
    case "memory_update":
    case "memory_forget":
      return {
        name: `loom.memory.${event.kind.slice("memory_".length)}`,
        ...nsWindow(event.ts, 0),
        attributes: {
          ...base,
          "loom.memory.kind": str(p.kind) || str(p.type),
          "loom.memory.scope": str(p.scope),
        },
      };
    case "error":
      return { name: "loom.error", ...nsWindow(event.ts, 0), attributes: base, error: str(p.message) || "error" };
    default:
      return null;
  }
}

/**
 * One metric write, as data. Returned by the pure mapper below so the
 * event → datapoint decisions can be unit-tested without an exporter — the same
 * reason `eventToSpan` exists.
 */
export type MetricOp =
  | { op: "count"; name: string; value: number; attributes: MetricAttributes; isInt: boolean }
  | { op: "histogram"; name: string; value: number; attributes: MetricAttributes };

/**
 * Pure mapper: a LoomEvent → the datapoints it should produce.
 *
 * The rule that governs every branch: a number goes out only if the event
 * carried it. An adapter that reports tokens but no cost produces token
 * datapoints and no cost datapoint — not a cost datapoint of 0. Codex is
 * exactly this case, and the reasoning is written out at the top of
 * src/adapters/codex.ts: a fake $0.001 presented as fact is worse than a blank.
 * On a counter it is worse still, because zeros are indistinguishable from real
 * cheap turns once summed, and the total then reads as authoritative.
 */
export function eventToMetrics(event: LoomEvent): MetricOp[] {
  const p = event.payload ?? {};
  const ops: MetricOp[] = [];

  if (event.kind === "run_complete") {
    const agent = event.agentId;
    const model = str(p.model) || undefined;
    const system = str(p.adapter) || str(p.system) || undefined;
    // The GenAI convention's dimensions. `gen_ai.operation.name` is "chat"
    // because that is what an agent turn is under the convention's vocabulary.
    const genai: MetricAttributes = {
      "gen_ai.agent.id": agent,
      "gen_ai.request.model": model,
      "gen_ai.system": system,
      "gen_ai.operation.name": "chat",
    };

    const tokensIn = num(p.tokensIn) ?? num(p.inputTokens);
    const tokensOut = num(p.tokensOut) ?? num(p.outputTokens);
    // > 0 rather than != null: adapters that don't track usage write a literal
    // 0 into these fields (see runtime.trackCost), and a 0-token turn is not a
    // thing that happens. Counting those would report a busy agent as free.
    if (tokensIn !== undefined && tokensIn > 0) {
      ops.push({ op: "count", name: "gen_ai.client.token.usage", value: tokensIn, isInt: true, attributes: { ...genai, "gen_ai.token.type": "input" } });
    }
    if (tokensOut !== undefined && tokensOut > 0) {
      ops.push({ op: "count", name: "gen_ai.client.token.usage", value: tokensOut, isInt: true, attributes: { ...genai, "gen_ai.token.type": "output" } });
    }

    const durationMs = num(p.durationMs);
    if (durationMs !== undefined && durationMs >= 0) {
      // The convention specifies seconds, not milliseconds. Loom measures in
      // ms everywhere else; convert here rather than shipping a metric that
      // says "s" and holds ms.
      ops.push({ op: "histogram", name: "gen_ai.client.operation.duration", value: durationMs / 1000, attributes: genai });
    }

    ops.push({
      op: "count",
      name: "loom.turns",
      value: 1,
      isInt: true,
      attributes: { "gen_ai.agent.id": agent, "gen_ai.request.model": model, "gen_ai.system": system, status: p.error ? "error" : "ok" },
    });

    const costUsd = num(p.costUsd);
    // Present, finite and positive — the three things that make it a real
    // reported spend rather than a placeholder. Anything else emits nothing.
    if (costUsd !== undefined && costUsd > 0) {
      ops.push({ op: "count", name: "loom.cost.usd", value: costUsd, isInt: false, attributes: { "gen_ai.agent.id": agent, "gen_ai.request.model": model, "gen_ai.system": system } });
    }
    return ops;
  }

  if (event.kind === "handoff") {
    ops.push({
      op: "count",
      name: "loom.handoffs",
      value: 1,
      isInt: true,
      attributes: {
        "loom.handoff.from": str(p.from) || event.agentId || undefined,
        "loom.handoff.to": str(p.to) || str(p.agent) || undefined,
      },
    });
  }
  return ops;
}

/**
 * Agents with a turn in flight.
 *
 * Driven by the turn boundaries `traceIdFor` already computes, NOT by the
 * `turn_started` status event. Only some adapters emit that status — codex,
 * grok, claude-code and the antigravity bridge do; echo, opencode and the
 * antigravity CLI never do — so a gauge keyed on it would read zero for half
 * the roster while those agents were demonstrably working. A turn's trace
 * opening is the one signal that holds for every adapter, because it is
 * derived from the events rather than announced by them.
 *
 * Held here rather than asked of the daemon because this module must not reach
 * into the runtime, and because the answer has to be derived from events for
 * the same reason every other number is.
 */
const activeAgents = new Set<string>();

/** Maintain the active set, returning true when it actually moved. */
function trackActive(agent: string | undefined, opened: boolean, closed: boolean): boolean {
  if (!agent) return false; // human and system events are nobody's turn
  if (closed) return activeAgents.delete(agent);
  if (opened && !activeAgents.has(agent)) {
    activeAgents.add(agent);
    return true;
  }
  return false;
}

/**
 * Record one live agent event, fanning it out to every enabled signal.
 *
 * Best-effort and non-throwing: observability must never break the agent loop.
 * The three signals are independent — logs off still means traces and metrics —
 * so each checks its own switch, and the shared trace id is minted once so a
 * log record can point at the span covering the same event.
 */
export function recordAgentEvent(event: LoomEvent, ctx: EventContext = {}): void {
  try {
    const t = telemetry();
    const m = metrics();
    const l = logs();
    if (!t.enabled && !m.enabled && !l.enabled) return;

    // Advance the per-agent turn trace for every event, whatever is enabled —
    // it is the id logs correlate on, not just a trace-exporter detail.
    const { traceId, opened, closed } = traceIdFor(event);

    const span = eventToSpan(event, ctx);
    const spanId = span ? t.span({ ...span, traceId }) : undefined;

    if (l.enabled) {
      const record = eventToLogRecord(event, ctx);
      // traceId always; spanId only when this event really produced that span.
      // Pointing a log at a span id we invented would be a link to nothing.
      if (record) l.log({ ...record, traceId, ...(spanId ? { spanId } : {}) });
    }

    if (m.enabled) {
      for (const op of eventToMetrics(event)) {
        if (op.op === "count") m.addCount(op.name, op.value, { ...op.attributes, "loom.project": ctx.project }, op.isInt);
        else m.record(op.name, op.value, { ...op.attributes, "loom.project": ctx.project });
      }
      if (trackActive(event.agentId, opened, closed)) {
        m.setGauge("loom.agents.active", activeAgents.size, { "loom.project": ctx.project });
      }
    }
  } catch {
    /* never let telemetry throw into the agent loop */
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
