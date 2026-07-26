/**
 * Reading Loom's own logs back out of the telemetry backend.
 *
 * Loom already *emits* structured logs over OTLP (see observability/logs.ts).
 * This is the other half: the query that lets the Observatory show an agent what
 * it actually said, correlated to the span it said it in.
 *
 * Two things make this different from the span read-back in insights.ts:
 *
 *  1. There is NO local fallback. Spans have one — `insightSpansFromLog` derives
 *     equivalent spans from the event log, because a span is a summary of an
 *     event Loom already has on disk. A log line is not: severity, body and the
 *     trace/span correlation only exist once the log record has been built and
 *     shipped. Reconstructing something log-shaped from the event log would be
 *     inventing data, so when ClickHouse is unreachable the caller reports
 *     `from: "unavailable"` and the UI says so plainly.
 *
 *  2. The identity filter is doubled up. `resources_string['service.name']`
 *     pins us to Loom (rather than any other service shipping to the same
 *     backend), and `attributes_string['loom.project']` pins us to one project.
 *     Confirmed against the live table: Loom sets loom.project as a *record*
 *     attribute, not a resource attribute, so it lands in attributes_string —
 *     one daemon's logs would otherwise leak into another project's view.
 */

import { SERVICE_NAME, chLiteral, chQuery } from "./clickhouse.js";

/**
 * The log store. Columns confirmed with DESCRIBE against a live 25.12 instance.
 * As with the span table, this is the layout the collector writes into and is
 * overridable for a backend that stores its logs elsewhere.
 */
export const LOG_TABLE = process.env.LOOM_LOG_TABLE || "signoz_logs.distributed_logs_v2";

/**
 * A log line, normalised for the UI.
 *
 * `ts` is milliseconds (the column is UInt64 *nanoseconds*, hence the intDiv).
 * `traceId`/`spanId` are already lowercase hex Strings in v2 — no unhex/hex
 * dance like the trace tables need — and are empty strings when the record was
 * emitted outside a span, which is normal for status lines.
 */
export type InsightLog = {
  ts: number;
  severity: string;
  /** OTel severity_number (1–24). Kept so the UI can sort/threshold without parsing text. */
  severityNumber: number;
  body: string;
  traceId: string;
  spanId: string;
  agent: string;
  /** loom.event.kind — which event produced the line (run_complete, status, message, ...). */
  kind: string;
  /** loom.chat — the conversation the line belongs to. */
  chat: string;
};

const SELECT = `
  intDiv(timestamp, 1000000) AS ts,
  severity_text AS severity,
  toUInt16(severity_number) AS severityNumber,
  body,
  trace_id AS traceId,
  span_id AS spanId,
  attributes_string['gen_ai.agent.id']  AS agent,
  attributes_string['loom.event.kind']  AS kind,
  attributes_string['loom.chat']        AS chat`;

/** Same shape as insights.ts's SERVICE guard, but logs keep resource attrs in a Map. */
const SERVICE = `resources_string['service.name'] = '${chLiteral(SERVICE_NAME)}'`;

function rowToLog(r: Record<string, unknown>): InsightLog {
  return {
    ts: Number(r.ts ?? 0),
    severity: String(r.severity ?? ""),
    severityNumber: Number(r.severityNumber ?? 0),
    body: String(r.body ?? ""),
    traceId: String(r.traceId ?? ""),
    spanId: String(r.spanId ?? ""),
    agent: String(r.agent ?? ""),
    kind: String(r.kind ?? ""),
    chat: String(r.chat ?? ""),
  };
}

export type FetchLogsOpts = {
  project: string;
  agent?: string;
  /** One or more severity_text values, comma-separated and case-insensitive ("error,warn"). */
  severity?: string;
  /** Pin to a single trace — the log side of the Trace Waterfall. */
  traceId?: string;
  /** Case-insensitive substring match on the body. */
  search?: string;
  limit?: number;
};

/**
 * Build the SQL for a log query. Split out from the fetch so the WHERE clause —
 * where a missing project filter would be a real leak — is unit-testable without
 * a live ClickHouse.
 *
 * Every interpolated value goes through `chLiteral`, which strips anything
 * outside `[\w.\-:/ ]`. That is deliberately blunt: it also removes `%` and `_`,
 * so a search term can never turn into a LIKE wildcard, and quotes can never
 * escape the literal. The cost is that punctuation in a search term is dropped
 * rather than matched, which for substring search over log bodies is a fine
 * trade.
 */
export function buildLogsQuery(opts: FetchLogsOpts): string {
  const proj = chLiteral(opts.project ?? "");
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));

  const where = [SERVICE, `attributes_string['loom.project'] = '${proj}'`];

  if (opts.agent) where.push(`attributes_string['gen_ai.agent.id'] = '${chLiteral(opts.agent)}'`);

  if (opts.traceId) where.push(`trace_id = '${chLiteral(opts.traceId)}'`);

  // severity_text is LowCardinality(String) and Loom writes it upper-case, but
  // callers type "error". Compare upper-cased on both sides so either works.
  const sevs = (opts.severity ?? "")
    .split(",")
    .map((s) => chLiteral(s.trim()).toUpperCase())
    .filter(Boolean);
  if (sevs.length) where.push(`upper(severity_text) IN (${sevs.map((s) => `'${s}'`).join(", ")})`);

  // positionCaseInsensitive rather than ILIKE: no wildcard semantics to smuggle
  // in, and it reads as "contains" which is what the search box promises.
  const q = chLiteral((opts.search ?? "").trim());
  if (q) where.push(`positionCaseInsensitive(body, '${q}') > 0`);

  return `SELECT ${SELECT} FROM ${LOG_TABLE}
    WHERE ${where.join("\n      AND ")}
    ORDER BY timestamp DESC LIMIT ${limit}`;
}

/**
 * Recent log lines for one project, newest first. Throws if ClickHouse is
 * unreachable — the caller turns that into `from: "unavailable"` rather than
 * substituting anything made up.
 */
export async function fetchLogs(opts: FetchLogsOpts): Promise<InsightLog[]> {
  return (await chQuery(buildLogsQuery(opts))).map(rowToLog);
}
