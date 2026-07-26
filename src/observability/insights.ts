/**
 * Observatory insights, read back from the backend's ClickHouse store: the spans
 * behind the Span Replay viewer and the Trace Waterfall, the per-agent burn-rate
 * series, and a deterministic 0–100 Agent Health Score. All of it is derived from
 * the same real gen_ai spans Loom exports — nothing here is synthetic.
 *
 * The scoring (`healthScore`) is a pure function so it is unit-tested without a
 * live ClickHouse, and it is the same math the UI badges render.
 */

import type { LoomEvent } from "../types.js";
import { SERVICE_NAME, SPAN_TABLE, chLiteral, chQuery } from "./clickhouse.js";

export type InsightSpan = {
  traceId: string;
  spanId: string;
  ts: number;
  name: string;
  ms: number;
  code: number; // OTel status: 2 = error
  msg: string;
  agent: string;
  ade: string; // gen_ai.system — the adapter kind
  model: string;
  tin: number;
  tout: number;
  cost: number;
  handoffFrom: string;
  handoffTo: string;
};

const SELECT = `
  toString(trace_id) AS traceId, toString(span_id) AS spanId,
  toUnixTimestamp64Milli(timestamp) AS ts, name,
  round(duration_nano / 1e6) AS ms, status_code AS code, status_message AS msg,
  attributes_string['gen_ai.agent.id']       AS agent,
  attributes_string['gen_ai.system']         AS ade,
  attributes_string['gen_ai.request.model']  AS model,
  attributes_string['loom.handoff.from']     AS handoffFrom,
  attributes_string['loom.handoff.to']       AS handoffTo,
  toFloat64(attributes_number['gen_ai.usage.cost_usd'])     AS cost,
  toUInt32(attributes_number['gen_ai.usage.input_tokens'])  AS tin,
  toUInt32(attributes_number['gen_ai.usage.output_tokens']) AS tout`;

const SERVICE = `\`resource_string_service$$name\` = '${chLiteral(SERVICE_NAME)}'`;

function rowToSpan(r: Record<string, unknown>): InsightSpan {
  return {
    traceId: String(r.traceId ?? ""),
    spanId: String(r.spanId ?? ""),
    ts: Number(r.ts ?? 0),
    name: String(r.name ?? ""),
    ms: Number(r.ms ?? 0),
    code: Number(r.code ?? 0),
    msg: String(r.msg ?? ""),
    agent: String(r.agent ?? ""),
    ade: String(r.ade ?? ""),
    model: String(r.model ?? ""),
    tin: Number(r.tin ?? 0),
    tout: Number(r.tout ?? 0),
    cost: Number(r.cost ?? 0),
    handoffFrom: String(r.handoffFrom ?? ""),
    handoffTo: String(r.handoffTo ?? ""),
  };
}

/** Recent spans for a project (optionally one agent), newest first. */
export async function fetchSpans(project: string, opts: { agent?: string; limit?: number } = {}): Promise<InsightSpan[]> {
  const proj = chLiteral(project);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const agentFilter = opts.agent ? `AND attributes_string['gen_ai.agent.id'] = '${chLiteral(opts.agent)}'` : "";
  const sql = `SELECT ${SELECT} FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND attributes_string['loom.project'] = '${proj}' ${agentFilter}
    ORDER BY timestamp DESC LIMIT ${limit}`;
  return (await chQuery(sql)).map(rowToSpan);
}

/** How many error spans an agent has emitted since `sinceMs` — the self-heal recheck signal. */
export async function recentAgentErrors(project: string, agent: string, sinceMs: number): Promise<number> {
  const proj = chLiteral(project);
  const a = chLiteral(agent);
  const sinceSec = Math.floor(Math.max(0, sinceMs) / 1000);
  const sql = `SELECT count() AS n FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND attributes_string['loom.project'] = '${proj}'
      AND attributes_string['gen_ai.agent.id'] = '${a}'
      AND status_code = 2
      AND timestamp >= toDateTime(${sinceSec})`;
  const rows = await chQuery(sql);
  return Number(rows[0]?.n ?? 0);
}

/** Every span in one trace, oldest first — the waterfall's rows. */
export async function traceSpans(traceId: string): Promise<InsightSpan[]> {
  const t = chLiteral(traceId);
  if (!t) return [];
  const sql = `SELECT ${SELECT} FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND trace_id = '${t}' ORDER BY timestamp ASC LIMIT 300`;
  return (await chQuery(sql)).map(rowToSpan);
}

/**
 * Fallback: derive InsightSpans from the local event log — the same data the
 * backend gets — so the Observatory's replay/health/waterfall still work when
 * ClickHouse is down or the agent hasn't exported anything yet.
 */
export function insightSpansFromLog(events: LoomEvent[], agent?: string): InsightSpan[] {
  const out: InsightSpan[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const mine = e.agentId === agent || p.to === agent || p.from === agent;
    if (agent && !mine) continue;
    const common = { traceId: "", spanId: String(e.id), ts: e.ts, ade: "", model: String(p.model ?? ""), handoffFrom: "", handoffTo: "" };
    if (e.kind === "run_complete") {
      out.push({ ...common, name: "gen_ai.agent.turn", ms: Number(p.durationMs ?? 0), code: p.error ? 2 : 1, msg: String(p.error ?? ""),
        agent: e.agentId ?? "", tin: Number(p.inputTokens ?? 0), tout: Number(p.outputTokens ?? 0), cost: Number(p.costUsd ?? 0) });
    } else if (e.kind === "error") {
      out.push({ ...common, name: "loom.error", ms: 0, code: 2, msg: String(p.message ?? "error"), agent: e.agentId ?? "", tin: 0, tout: 0, cost: 0 });
    } else if (e.kind === "handoff") {
      out.push({ ...common, name: "loom.baton.handoff", ms: 0, code: 1, msg: `${p.from ?? "?"} -> ${p.to ?? "?"}`,
        agent: e.agentId ?? "", tin: 0, tout: 0, cost: 0, handoffFrom: String(p.from ?? ""), handoffTo: String(p.to ?? "") });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export type BurnBucket = { t: number; byAgent: Record<string, number>; total: number };
export type BurnSeries = {
  hours: number;
  buckets: BurnBucket[];
  totalUsd: number;
  /** USD/hour over the covered window, and the linear projection for 24h. */
  ratePerHour: number;
  projected24h: number;
};

/** Per-agent cost over time, bucketed — the burn-rate sparkline's data + a linear projection. */
export async function burnSeries(project: string, opts: { hours?: number; buckets?: number } = {}): Promise<BurnSeries> {
  const proj = chLiteral(project);
  const hours = Math.min(720, Math.max(1, opts.hours ?? 24));
  const nBuckets = Math.min(60, Math.max(2, opts.buckets ?? 12));
  const stepSec = Math.max(60, Math.round((hours * 3600) / nBuckets));
  const sql = `SELECT
      toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL ${stepSec} SECOND)) AS bucket,
      attributes_string['gen_ai.agent.id'] AS agent,
      sum(toFloat64(attributes_number['gen_ai.usage.cost_usd'])) AS cost
    FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND attributes_string['loom.project'] = '${proj}'
      AND name = 'gen_ai.agent.turn'
      AND timestamp >= now() - INTERVAL ${hours} HOUR
    GROUP BY bucket, agent ORDER BY bucket ASC`;
  const rows = await chQuery(sql);
  const map = new Map<number, BurnBucket>();
  for (const r of rows) {
    const t = Number(r.bucket ?? 0) * 1000;
    const agent = String(r.agent ?? "unknown");
    const cost = Number(r.cost ?? 0);
    const b = map.get(t) ?? { t, byAgent: {}, total: 0 };
    b.byAgent[agent] = (b.byAgent[agent] ?? 0) + cost;
    b.total += cost;
    map.set(t, b);
  }
  const buckets = [...map.values()].sort((a, b) => a.t - b.t);
  const totalUsd = buckets.reduce((a, b) => a + b.total, 0);
  const ratePerHour = totalUsd / hours;
  return { hours, buckets, totalUsd, ratePerHour, projected24h: ratePerHour * 24 };
}

/* ------------------------------------------------------------------------- *
 * Metrics read-back
 *
 * Loom exports loom.turns, loom.handoffs, loom.cost.usd, loom.agents.active,
 * gen_ai.client.token.usage and a gen_ai.client.operation.duration histogram
 * (observability/metrics.ts). Reading them back closes the loop: the same
 * numbers the Observatory shows can be checked against what the backend stored.
 *
 * The backend splits a metric across two tables, confirmed by DESCRIBE on the
 * live stack:
 *   distributed_time_series_v4 — one row per (fingerprint, hour) carrying the
 *     metadata and label maps: metric_name, type, unit, temporality, attrs
 *     (metric attributes), resource_attrs, labels (a JSON string).
 *   distributed_samples_v4     — the actual points: metric_name, fingerprint,
 *     unix_milli, value.
 * `fingerprint` is the join key: it identifies one label set, i.e. one series.
 * ------------------------------------------------------------------------- */

/**
 * The metric tables the collector writes into. Defaults are that layout;
 * both are overridable for a backend that stores its metrics elsewhere.
 */
export const METRIC_SAMPLES_TABLE = process.env.LOOM_METRIC_SAMPLES_TABLE || "signoz_metrics.distributed_samples_v4";
export const METRIC_SERIES_TABLE = process.env.LOOM_METRIC_SERIES_TABLE || "signoz_metrics.distributed_time_series_v4";

/**
 * A histogram does not exist under its own name in ClickHouse — the OTLP
 * exporter fans it out into suffixed sums/gauges. Asking for
 * "gen_ai.client.operation.duration" therefore has to expand to the real names,
 * or the query silently returns nothing.
 *
 * `.bucket` is deliberately excluded: it is one series per histogram boundary
 * (le="0.005", le="0.01", …), which is a dozen lines of noise on a chart and
 * never what a caller asking for "the duration metric" means. A caller that
 * genuinely wants buckets can name `...duration.bucket` explicitly, which the
 * exact-name path below still honours.
 */
const HISTOGRAM_SUFFIXES = ["sum", "count", "min", "max"];

/** Expand each requested name to itself plus its histogram parts, deduped. */
export function expandMetricNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = chLiteral(String(raw ?? "").trim());
    if (!n) continue;
    out.add(n);
    // Suffixing a non-histogram name is harmless — nothing matches it.
    if (!HISTOGRAM_SUFFIXES.some((s) => n.endsWith(`.${s}`)) && !n.endsWith(".bucket")) {
      for (const s of HISTOGRAM_SUFFIXES) out.add(`${n}.${s}`);
    }
  }
  return [...out];
}

export type MetricPoint = {
  /** Bucket start, epoch ms. */
  t: number;
  /**
   * Sum of the samples in the bucket. Loom's counters arrive as small
   * per-export deltas (verified on the live stack: loom.turns reports 1/2/3,
   * never a running total), so summing is the honest "how much happened in this
   * window" number for a Sum-typed metric.
   */
  sum: number;
  /** Mean of the samples in the bucket — the right read for a Gauge like loom.agents.active. */
  avg: number;
  max: number;
  /** How many raw samples went into the bucket, so the UI can tell thin data from zero. */
  n: number;
};

export type MetricSeries = {
  metric: string;
  /** The backend's type column: "Sum" | "Gauge" | "Histogram" | "". */
  type: string;
  unit: string;
  temporality: string;
  /** The series' label set (agent id, model, project, …), internal `__*` keys stripped. */
  labels: Record<string, string>;
  /** ClickHouse fingerprint as a string — UInt64 overflows a JS number. */
  fingerprint: string;
  /** Which of sum/avg the UI should plot by default, chosen from `type`. */
  prefer: "sum" | "avg";
  points: MetricPoint[];
};

export type MetricQueryOpts = {
  project: string;
  sinceMs?: number;
  stepMs?: number;
};

/** Drop the backend's internal label keys (`__name__`, `__temporality__`, …). */
function cleanLabels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith("__")) continue;
      out[k] = String(val ?? "");
    }
  }
  return out;
}

/**
 * Build the SQL for a metric series query — split out so the join, the project
 * filter and the bucketing are testable without a live ClickHouse.
 *
 * Note what the inner subquery does *not* do: filter time_series_v4 by
 * unix_milli. That column is floored to the hour there, so a naive
 * `>= sinceMs` would drop the metadata row for a series whose hour started
 * before the window and take the whole series with it. The metric_name +
 * project filters already narrow it to a handful of fingerprints, so the time
 * filter belongs on the samples side only, where it is exact.
 *
 * The GROUP BY inside the subquery collapses the one-row-per-hour duplication;
 * without it the join would multiply every sample by the number of hours the
 * series has existed.
 */
export function buildMetricQuery(names: string[], opts: MetricQueryOpts): string {
  const proj = chLiteral(opts.project ?? "");
  const step = Math.max(1000, Math.round(opts.stepMs ?? 60_000));
  const since = Math.max(0, Math.round(opts.sinceMs ?? Date.now() - 6 * 3600_000));
  const list = expandMetricNames(names)
    .map((n) => `'${n}'`)
    .join(", ");

  return `SELECT
      any(s.s_metric) AS metric, any(s.s_type) AS type, any(s.s_unit) AS unit,
      any(s.s_temporality) AS temporality, any(s.s_attrs) AS labels,
      toString(sm.fingerprint) AS fingerprint,
      intDiv(sm.unix_milli, ${step}) * ${step} AS t,
      sum(sm.value) AS vsum, avg(sm.value) AS vavg, max(sm.value) AS vmax, count() AS n
    FROM ${METRIC_SAMPLES_TABLE} AS sm
    INNER JOIN (
      SELECT fingerprint,
        any(metric_name) AS s_metric, any(type) AS s_type, any(unit) AS s_unit,
        any(temporality) AS s_temporality, any(attrs) AS s_attrs
      FROM ${METRIC_SERIES_TABLE}
      WHERE metric_name IN (${list})
        AND resource_attrs['service.name'] = '${chLiteral(SERVICE_NAME)}'
        AND attrs['loom.project'] = '${proj}'
      GROUP BY fingerprint
    ) AS s ON s.fingerprint = sm.fingerprint
    WHERE sm.metric_name IN (${list}) AND sm.unix_milli >= ${since}
    GROUP BY fingerprint, t
    ORDER BY metric ASC, fingerprint ASC, t ASC`;
}

/** Fold the flat (series, bucket) rows into one entry per series, points ordered. */
export function rowsToSeries(rows: Record<string, unknown>[]): MetricSeries[] {
  const byFp = new Map<string, MetricSeries>();
  for (const r of rows) {
    const fp = String(r.fingerprint ?? "");
    const type = String(r.type ?? "");
    let s = byFp.get(fp);
    if (!s) {
      s = {
        metric: String(r.metric ?? ""),
        type,
        unit: String(r.unit ?? ""),
        temporality: String(r.temporality ?? ""),
        labels: cleanLabels(r.labels),
        fingerprint: fp,
        prefer: type === "Gauge" ? "avg" : "sum",
        points: [],
      };
      byFp.set(fp, s);
    }
    s.points.push({
      t: Number(r.t ?? 0),
      sum: Number(r.vsum ?? 0),
      avg: Number(r.vavg ?? 0),
      max: Number(r.vmax ?? 0),
      n: Number(r.n ?? 0),
    });
  }
  for (const s of byFp.values()) s.points.sort((a, b) => a.t - b.t);
  return [...byFp.values()].sort((a, b) => a.metric.localeCompare(b.metric) || a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * Read named metrics back for one project, one entry per distinct label set.
 * Throws if ClickHouse is unreachable — like logs, there is no local substitute
 * for a metric the backend never received, and the route reports that honestly.
 */
export async function fetchMetricSeries(names: string[], opts: MetricQueryOpts): Promise<MetricSeries[]> {
  if (!expandMetricNames(names).length) return [];
  return rowsToSeries(await chQuery(buildMetricQuery(names, opts)));
}

/** The metrics Loom actually emits — the default set when a caller names none. */
export const LOOM_METRIC_NAMES = [
  "loom.turns",
  "loom.handoffs",
  "loom.cost.usd",
  "loom.agents.active",
  "gen_ai.client.token.usage",
  "gen_ai.client.operation.duration",
];

export type Health = {
  score: number; // 0–100
  grade: "healthy" | "degraded" | "unhealthy";
  turns: number;
  errorCount: number;
  buckets: { errorRate: number; latency: number; tokenBloat: number; recency: number }; // penalties (each ≥ 0)
};

const isErr = (s: InsightSpan): boolean => s.code === 2 || s.name === "loom.error" || s.name === "loom.route.failed";

/**
 * A deterministic 0–100 health score from an agent's own spans. Four penalty
 * buckets subtract from 100:
 *   errorRate (≤40) — share of spans that errored
 *   latency   (≤25) — share of turns slower than 30s
 *   tokenBloat(≤20) — average input tokens above an 80k comfort line
 *   recency   (≤15) — how recently the last error fired (fades over 30 min)
 * Pure: same input, same score — this is what the UI badge shows.
 */
export function healthScore(spans: InsightSpan[], now = Date.now()): Health {
  const turns = spans.filter((s) => s.name === "gen_ai.agent.turn");
  const errs = spans.filter(isErr).sort((a, b) => b.ts - a.ts);
  const nTurns = turns.length;

  const errorRate = spans.length ? Math.round((errs.length / spans.length) * 40) : 0;
  const slow = turns.filter((t) => t.ms > 30_000).length;
  const latency = nTurns ? Math.round(Math.min(1, slow / nTurns) * 25) : 0;
  const avgIn = nTurns ? turns.reduce((a, t) => a + t.tin, 0) / nTurns : 0;
  const tokenBloat = Math.round(Math.min(1, Math.max(0, (avgIn - 80_000) / 120_000)) * 20);
  let recency = 0;
  if (errs[0]) {
    const ageMin = (now - errs[0].ts) / 60_000;
    recency = Math.round(Math.max(0, 1 - ageMin / 30) * 15);
  }

  const score = Math.max(0, Math.min(100, 100 - errorRate - latency - tokenBloat - recency));
  const grade = score >= 80 ? "healthy" : score >= 50 ? "degraded" : "unhealthy";
  return { score, grade, turns: nTurns, errorCount: errs.length, buckets: { errorRate, latency, tokenBloat, recency } };
}
