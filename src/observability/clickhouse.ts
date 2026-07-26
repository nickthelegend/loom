/**
 * The one place Loom talks to the telemetry backend's ClickHouse store. Every
 * read-back feature — triage, span replay, burn rate, health score, the trace
 * waterfall — goes through here so the endpoint, the table, and the failure
 * behaviour are shared.
 *
 * Reads are best-effort: an unreachable ClickHouse throws, and callers fall back
 * (to the local event log, or an empty view) rather than break the page.
 */

export const CH_URL = process.env.LOOM_CLICKHOUSE_URL || "http://localhost:8123";

/**
 * The span index.
 *
 * The default is the table layout the collector writes into; it is overridable
 * so the same read-back works against a backend that lays its spans out
 * differently.
 */
export const SPAN_TABLE = process.env.LOOM_SPAN_TABLE || "signoz_traces.distributed_signoz_index_v3";

/**
 * The service every read-back filters on — the same name the exporter stamps
 * onto `service.name` (see otlp.ts#resolveTelemetryConfig).
 *
 * Read from the environment rather than hardcoded, because the two halves have
 * to agree: overriding LOOM_SERVICE_NAME to distinguish two fleets moved what
 * the exporter wrote while every query still asked for 'loom', and each panel
 * then came back empty with nothing to say why. Emit and read-back share one
 * answer or the feature only works on the default.
 */
export const SERVICE_NAME = process.env.LOOM_SERVICE_NAME || process.env.OTEL_SERVICE_NAME || "loom";

/** Escape a value for a single-quoted ClickHouse string literal. */
export function chLiteral(v: string): string {
  return v.replace(/[^\w.\-:/ ]/g, "");
}

/** Run one SQL query, returning parsed JSONEachRow rows. Throws if unreachable. */
export async function chQuery(sql: string): Promise<Record<string, unknown>[]> {
  if (typeof globalThis.fetch !== "function") throw new Error("no fetch");
  const res = await fetch(`${CH_URL}/?default_format=JSONEachRow`, { method: "POST", body: sql });
  if (!res.ok) throw new Error(`clickhouse ${res.status}`);
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
