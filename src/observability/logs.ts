/**
 * Loom → OpenTelemetry logs (OTLP/HTTP JSON, `/v1/logs`).
 *
 * Loom already has a log: the LoomEvent stream is the source of truth for the
 * whole product. This ships it. Every agent message, tool call, file edit,
 * decision, route step, budget pause and error becomes one OTLP log record with
 * the same `service.name` as the spans, and — when the event happened inside a
 * turn — the same `traceId`/`spanId`.
 *
 * That last part is the whole point. Without trace correlation this is just a
 * second copy of the event log in a different database. With it, a slow turn
 * in the trace view gets a "related logs" tab showing what the agent actually
 * said and did while it was slow, and a log line has a link back to the span
 * that produced it. Traces tell you a turn took 40s; logs tell you why.
 *
 * Same contract as the other two exporters: buffered, best-effort, never throws
 * into the agent loop. Off with LOOM_OTEL_LOGS=0 (or any consent opt-out).
 */

import type { LoomEvent } from "../types.js";
import {
  encodeAttributes,
  postOtlp,
  resourceAttributes,
  type AttrValue,
  type KeyValue,
  type TelemetryConfig,
} from "./otlp.js";

/**
 * OTLP SeverityNumber. The spec's named levels; we use four of them.
 *
 * Mapped honestly, which mostly means resisting the urge to inflate. An agent
 * saying something is INFO, not DEBUG — it is the primary content of the
 * product. A turn that failed is ERROR. Something a human needs to look at but
 * that isn't a failure (blocked on input, over budget, a suggested handoff) is
 * WARN. Adapter lifecycle chatter is DEBUG. Nothing is FATAL: Loom survives
 * every event it logs, and a severity nobody can act on is noise with a red
 * icon.
 */
export const SEVERITY = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
} as const;

const SEVERITY_TEXT: Record<number, string> = {
  [SEVERITY.DEBUG]: "DEBUG",
  [SEVERITY.INFO]: "INFO",
  [SEVERITY.WARN]: "WARN",
  [SEVERITY.ERROR]: "ERROR",
};

/**
 * Longest body we will ship, in characters.
 *
 * An agent turn can produce a message with an entire file pasted into it. That
 * is real data and we do not drop the record — but a megabyte of it per line
 * will get the batch rejected by the collector's payload limit, taking the
 * *other* records in the batch down with it. Cut it and say so in the body, so
 * a reader can tell "this is all of it" from "there was more".
 */
const MAX_BODY_CHARS = 8192;

export type LogRecordInput = {
  timeUnixNano: bigint;
  severityNumber: number;
  body: string;
  attributes: Record<string, AttrValue>;
  traceId?: string;
  spanId?: string;
};

/**
 * A LoomEvent → the log record it should produce, or null for kinds that carry
 * nothing a human would read.
 *
 * Pure, and exported so the mapping (and especially the severity mapping) is
 * testable without a collector — same arrangement as `eventToSpan`.
 */
export function eventToLogRecord(
  event: LoomEvent,
  ctx: { project?: string } = {},
): LogRecordInput | null {
  const p = event.payload ?? {};
  const attributes: Record<string, AttrValue> = {
    "loom.project": ctx.project,
    "loom.chat": event.chat,
    "loom.event.kind": event.kind,
    "loom.event.id": event.id,
    "gen_ai.agent.id": event.agentId,
  };
  const who = event.agentId || "loom";

  switch (event.kind) {
    case "message": {
      const text = str(p.text);
      if (!text) return null;
      // Reasoning is the model thinking out loud, not addressing anyone. Same
      // severity, tagged so it can be filtered out of a "what did the agent
      // say" view.
      return rec(event, SEVERITY.INFO, text, { ...attributes, "loom.message.reasoning": p.reasoning === true });
    }

    case "tool_call": {
      const tool = str(p.tool) || str(p.name) || "tool";
      return rec(event, SEVERITY.INFO, `${who} called ${tool}${summarize(p.input ?? p.args ?? p.command)}`, {
        ...attributes,
        "gen_ai.tool.name": tool,
      });
    }

    case "tool_result": {
      const tool = str(p.tool) || str(p.name) || "tool";
      const failed = p.error != null || p.isError === true || num(p.exitCode) === 1;
      return rec(
        event,
        failed ? SEVERITY.WARN : SEVERITY.DEBUG,
        `${tool} returned${summarize(p.error ?? p.output ?? p.result)}`,
        { ...attributes, "gen_ai.tool.name": tool, "loom.tool.failed": failed },
      );
    }

    case "file_edit": {
      const path = str(p.path);
      if (!path) return null;
      return rec(event, SEVERITY.INFO, `${who} edited ${path}`, {
        ...attributes,
        "loom.file.path": path,
        "loom.file.tool": str(p.tool) || undefined,
      });
    }

    case "decision": {
      const text = str(p.text) || str(p.decision) || str(p.summary);
      if (!text) return null;
      return rec(event, SEVERITY.INFO, `decision: ${text}`, {
        ...attributes,
        "loom.decision.kind": str(p.kind) || undefined,
        "loom.decision.confidence": num(p.confidence),
      });
    }

    case "handoff":
      return rec(
        event,
        SEVERITY.INFO,
        `baton: ${str(p.from) || event.agentId || "?"} → ${str(p.to) || str(p.agent) || "?"}`,
        {
          ...attributes,
          "loom.handoff.from": str(p.from) || event.agentId || undefined,
          "loom.handoff.to": str(p.to) || str(p.agent) || undefined,
        },
      );

    case "suggestion":
      return rec(event, SEVERITY.INFO, `suggested handoff to ${str(p.to) || str(p.agent) || "?"}`, attributes);

    // Blocked on a human. Not a failure, but nothing moves until someone looks.
    case "needs_input":
      return rec(event, SEVERITY.WARN, `${who} needs input: ${str(p.question)}`, attributes);

    case "run_complete": {
      const ms = num(p.durationMs) ?? 0;
      const failed = p.error != null;
      return rec(
        event,
        failed ? SEVERITY.ERROR : SEVERITY.INFO,
        failed ? `${who} turn failed after ${ms}ms: ${str(p.error)}` : `${who} completed a turn in ${ms}ms`,
        {
          ...attributes,
          "gen_ai.request.model": str(p.model) || undefined,
          "gen_ai.system": str(p.adapter) || undefined,
          "loom.turn.duration_ms": ms,
        },
      );
    }

    case "route_started":
    case "route_step":
    case "route_paused":
    case "route_resumed":
    case "route_completed":
    case "route_failed": {
      const phase = event.kind.slice("route_".length);
      const routeId = str(p.routeId) || str(p.id);
      const failed = event.kind === "route_failed";
      return rec(
        event,
        failed ? SEVERITY.ERROR : event.kind === "route_paused" ? SEVERITY.WARN : SEVERITY.INFO,
        `route ${routeId || "?"} ${phase}${failed ? `: ${str(p.error) || "route failed"}` : summarize(p.step ?? p.agent)}`,
        { ...attributes, "loom.route.id": routeId || undefined, "loom.route.phase": phase },
      );
    }

    case "memory_add":
    case "memory_update":
    case "memory_forget": {
      const op = event.kind.slice("memory_".length);
      return rec(event, SEVERITY.INFO, `memory ${op}: ${str(p.text) || str(p.key) || str(p.kind)}`, {
        ...attributes,
        "loom.memory.op": op,
        "loom.memory.scope": str(p.scope) || undefined,
      });
    }

    case "error":
      return rec(event, SEVERITY.ERROR, str(p.message) || "error", {
        ...attributes,
        "loom.error.detail": str(p.stderr) || str(p.detail) || undefined,
      });

    case "status": {
      const state = str(p.state);
      // The budget guard's two states are the reason status isn't all DEBUG: a
      // paused agent is the single most confusing thing to debug from the
      // outside ("why did nothing happen?"), and it deserves to be visible at
      // WARN next to the turns that didn't run.
      if (state === "budget_exceeded") {
        return rec(
          event,
          SEVERITY.WARN,
          `${who} paused — spent $${fixed(p.spentTodayUsd)} against a $${fixed(p.budgetUsd)}/day budget`,
          {
            ...attributes,
            "loom.status.state": state,
            "loom.budget.usd": num(p.budgetUsd),
            "loom.budget.spent_today_usd": num(p.spentTodayUsd),
          },
        );
      }
      if (state === "budget_recovered") {
        return rec(event, SEVERITY.INFO, `${who} back under budget — pause lifted`, {
          ...attributes,
          "loom.status.state": state,
          "loom.budget.paused_ms": num(p.pausedMs),
        });
      }
      if (!state) return null;
      return rec(event, SEVERITY.DEBUG, `${who}: ${state}`, { ...attributes, "loom.status.state": state });
    }

    default:
      // agent_join / role_change / turn_diff / memory_import and friends: real
      // events, but with no body worth a line of their own. They are already on
      // the span side; adding a "something happened" log record would only pad
      // the log volume.
      return null;
  }
}

function rec(
  event: LoomEvent,
  severityNumber: number,
  body: string,
  attributes: Record<string, AttrValue>,
): LogRecordInput {
  return {
    timeUnixNano: BigInt(Math.max(0, Math.round(event.ts))) * 1_000_000n,
    severityNumber,
    body: truncate(body),
    attributes,
  };
}

/** Cut an over-long body and say by how much, rather than lying about length. */
export function truncate(body: string, max = MAX_BODY_CHARS): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}… [truncated ${body.length - max} chars]`;
}

/** A short parenthetical for a payload field, or nothing when there isn't one. */
function summarize(v: unknown): string {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  if (!s) return "";
  return `: ${s.length > 200 ? `${s.slice(0, 200)}…` : s}`;
}

function fixed(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "?";
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Buffered OTLP log exporter. Mirrors LoomTelemetry's batching exactly. */
export class LoomLogs {
  private buffer: Record<string, unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly logsUrl: string;
  private readonly resource: KeyValue[];

  constructor(private readonly cfg: TelemetryConfig) {
    this.logsUrl = `${cfg.endpoint}/v1/logs`;
    this.resource = resourceAttributes(cfg);
  }

  get enabled(): boolean {
    return this.cfg.logsEnabled && typeof globalThis.fetch === "function";
  }

  /** Buffer one record. No-op when logs are disabled. */
  log(input: LogRecordInput): void {
    if (!this.enabled) return;
    const ts = input.timeUnixNano.toString();
    this.buffer.push({
      timeUnixNano: ts,
      // When the event happened vs. when we saw it. Identical here — Loom
      // observes its own events synchronously — but the field is required for
      // a backend to order records, and omitting it makes it fall back to ingest
      // time, which reorders a burst of turn output arbitrarily.
      observedTimeUnixNano: ts,
      severityNumber: input.severityNumber,
      severityText: SEVERITY_TEXT[input.severityNumber] ?? "INFO",
      body: { stringValue: input.body },
      attributes: encodeAttributes(input.attributes),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.spanId ? { spanId: input.spanId } : {}),
    });
    if (this.buffer.length >= 64) this.drain();
    else this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, 1500);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const logRecords = this.buffer;
    this.buffer = [];
    postOtlp(this.logsUrl, this.cfg.headers, {
      resourceLogs: [
        {
          resource: { attributes: this.resource },
          scopeLogs: [{ scope: { name: "loom" }, logRecords }],
        },
      ],
    });
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
  }
}
