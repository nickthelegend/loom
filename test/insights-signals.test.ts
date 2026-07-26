/**
 * Reading the other two OTel signals back out of SigNoz.
 *
 * The SQL builders and the row normalisers are pure, so they are asserted here
 * against no live ClickHouse. What matters most is the project filter: without
 * it one daemon would show another project's logs and metrics, so it gets its
 * own test rather than being implied by a happy-path assertion.
 *
 * The "unavailable" path is exercised by pointing the module's fetch at a dead
 * socket — that is the real failure the routes translate into
 * `from: "unavailable"`, and there is deliberately no fallback data to check.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMetricQuery,
  expandMetricNames,
  fetchMetricSeries,
  rowsToSeries,
  METRIC_SAMPLES_TABLE,
  METRIC_SERIES_TABLE,
  LOOM_METRIC_NAMES,
} from "../src/observability/insights.js";
import { LOG_TABLE, buildLogsQuery, fetchLogs } from "../src/observability/logs-query.js";

afterEach(() => vi.unstubAllGlobals());

/** Stand in for ClickHouse: hand back JSONEachRow text for whatever is asked. */
function stubCh(rows: Record<string, unknown>[]): { sql: string | undefined } {
  const seen: { sql: string | undefined } = { sql: undefined };
  vi.stubGlobal("fetch", async (_url: string, init: { body?: string }) => {
    seen.sql = init?.body;
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join("\n") };
  });
  return seen;
}

describe("buildLogsQuery", () => {
  it("always scopes to service.name=loom and this project", () => {
    const sql = buildLogsQuery({ project: "weave" });
    expect(sql).toContain(LOG_TABLE);
    expect(sql).toContain("resources_string['service.name'] = 'loom'");
    expect(sql).toContain("attributes_string['loom.project'] = 'weave'");
  });

  it("never lets a project name escape the literal", () => {
    // A hostile project name must not be able to close the quote and OR the
    // filter away — chLiteral strips everything outside [\w.\-:/ ].
    const sql = buildLogsQuery({ project: "weave' OR 1=1 --" });
    expect(sql).toContain("attributes_string['loom.project'] = 'weave OR 11 --'");
    expect(sql).not.toContain("OR 1=1");
  });

  it("adds agent, trace and severity filters only when asked", () => {
    // The SELECT list always mentions these columns, so assert on the WHERE
    // predicates specifically — an unasked-for filter is the actual bug.
    const bare = buildLogsQuery({ project: "p" });
    expect(bare).not.toContain("attributes_string['gen_ai.agent.id'] =");
    expect(bare).not.toContain("upper(severity_text)");
    expect(bare).not.toContain("trace_id =");

    const full = buildLogsQuery({ project: "p", agent: "plannerbot", traceId: "abc123", severity: "error, warn" });
    expect(full).toContain("attributes_string['gen_ai.agent.id'] = 'plannerbot'");
    expect(full).toContain("trace_id = 'abc123'");
    // Case-insensitive on both sides: callers type "error", SigNoz stores "ERROR".
    expect(full).toContain("upper(severity_text) IN ('ERROR', 'WARN')");
  });

  it("searches by substring, not by LIKE — wildcards cannot be smuggled in", () => {
    const sql = buildLogsQuery({ project: "p", search: "%boom%" });
    expect(sql).toContain("positionCaseInsensitive(body, 'boom') > 0");
    expect(sql).not.toContain("%");
  });

  it("clamps the limit into 1..1000 and defaults to 200", () => {
    expect(buildLogsQuery({ project: "p" })).toContain("LIMIT 200");
    expect(buildLogsQuery({ project: "p", limit: 99_999 })).toContain("LIMIT 1000");
    // 0 and negatives are explicit values, not "unset", so they clamp to 1
    // rather than falling back to the default.
    expect(buildLogsQuery({ project: "p", limit: 0 })).toContain("LIMIT 1");
    expect(buildLogsQuery({ project: "p", limit: -5 })).toContain("LIMIT 1");
  });
});

describe("fetchLogs", () => {
  it("normalises a real-shaped row to milliseconds and plain strings", async () => {
    stubCh([
      {
        ts: 1784959283969,
        severity: "INFO",
        severityNumber: 9,
        body: "plannerbot completed a turn in 133ms",
        traceId: "fb91641ae165f8e68bf71bb1a303e98c",
        spanId: "7ecbe393bf1ec9d9",
        agent: "plannerbot",
        kind: "run_complete",
        chat: "main",
      },
      // Status lines are emitted outside a span: empty correlation ids are normal.
      { ts: 1784959286700, severity: "DEBUG", severityNumber: 5, body: "plannerbot: stopped", agent: "plannerbot" },
    ]);
    const logs = await fetchLogs({ project: "weave" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      ts: 1784959283969,
      severity: "INFO",
      severityNumber: 9,
      body: "plannerbot completed a turn in 133ms",
      traceId: "fb91641ae165f8e68bf71bb1a303e98c",
      spanId: "7ecbe393bf1ec9d9",
      agent: "plannerbot",
      kind: "run_complete",
      chat: "main",
    });
    expect(logs[1].traceId).toBe("");
    expect(logs[1].spanId).toBe("");
  });

  it("throws when ClickHouse is unreachable — there is no log fallback to invent", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchLogs({ project: "weave" })).rejects.toThrow();
  });
});

describe("expandMetricNames", () => {
  it("expands a histogram into the parts the exporter actually writes", () => {
    const names = expandMetricNames(["gen_ai.client.operation.duration"]);
    expect(names).toContain("gen_ai.client.operation.duration.sum");
    expect(names).toContain("gen_ai.client.operation.duration.count");
    expect(names).toContain("gen_ai.client.operation.duration.min");
    expect(names).toContain("gen_ai.client.operation.duration.max");
    // Per-le bucket series are noise on a chart unless explicitly asked for.
    expect(names).not.toContain("gen_ai.client.operation.duration.bucket");
  });

  it("honours an explicitly suffixed name without re-suffixing it", () => {
    expect(expandMetricNames(["loom.turns.sum"])).toEqual(["loom.turns.sum"]);
    expect(expandMetricNames(["gen_ai.client.operation.duration.bucket"])).toEqual([
      "gen_ai.client.operation.duration.bucket",
    ]);
  });

  it("drops empties and dedupes", () => {
    expect(expandMetricNames(["", "   ", "loom.turns.sum", "loom.turns.sum"])).toEqual(["loom.turns.sum"]);
  });
});

describe("buildMetricQuery", () => {
  it("joins samples to series on fingerprint and scopes to loom + this project", () => {
    const sql = buildMetricQuery(["loom.turns"], { project: "weave", sinceMs: 1_784_950_000_000, stepMs: 300_000 });
    expect(sql).toContain(METRIC_SAMPLES_TABLE);
    expect(sql).toContain(METRIC_SERIES_TABLE);
    expect(sql).toContain("ON s.fingerprint = sm.fingerprint");
    expect(sql).toContain("resource_attrs['service.name'] = 'loom'");
    expect(sql).toContain("attrs['loom.project'] = 'weave'");
    expect(sql).toContain("intDiv(sm.unix_milli, 300000) * 300000");
    expect(sql).toContain("sm.unix_milli >= 1784950000000");
  });

  it("collapses the one-row-per-hour series table so samples are not multiplied", () => {
    const sql = buildMetricQuery(["loom.turns"], { project: "p" });
    expect(sql).toContain("GROUP BY fingerprint\n    ) AS s");
  });

  it("time-filters only the samples side — the series table's unix_milli is hour-floored", () => {
    const sql = buildMetricQuery(["loom.turns"], { project: "p", sinceMs: 1_784_950_000_000 });
    const inner = sql.slice(sql.indexOf("FROM " + METRIC_SERIES_TABLE), sql.indexOf("GROUP BY fingerprint"));
    expect(inner).not.toContain("unix_milli");
  });

  it("clamps a silly step to at least a second", () => {
    expect(buildMetricQuery(["loom.turns"], { project: "p", stepMs: 0 })).toContain("intDiv(sm.unix_milli, 1000)");
  });
});

describe("rowsToSeries", () => {
  // Two buckets of one Sum series plus one Gauge series, shaped exactly as the
  // live query returns them.
  const rows: Record<string, unknown>[] = [
    {
      metric: "loom.cost.usd", type: "Sum", unit: "USD", temporality: "Cumulative",
      labels: { "gen_ai.agent.id": "plannerbot", "loom.project": "weave", __temporality__: "Cumulative" },
      fingerprint: "3533699151431890685", t: 1784958300000, vsum: 0.015, vavg: 0.001875, vmax: 0.003, n: 8,
    },
    {
      metric: "loom.cost.usd", type: "Sum", unit: "USD", temporality: "Cumulative",
      labels: { "gen_ai.agent.id": "plannerbot", "loom.project": "weave", __temporality__: "Cumulative" },
      fingerprint: "3533699151431890685", t: 1784958000000, vsum: 0.006, vavg: 0.002, vmax: 0.003, n: 3,
    },
    {
      metric: "loom.agents.active", type: "Gauge", unit: "{agent}", temporality: "Unspecified",
      labels: { "loom.project": "weave", __temporality__: "Unspecified" },
      fingerprint: "5639057939949183367", t: 1784958300000, vsum: 19, vavg: 1.7272727272727273, vmax: 3, n: 11,
    },
  ];

  it("folds rows into one entry per fingerprint with points in time order", () => {
    const series = rowsToSeries(rows);
    expect(series.map((s) => s.metric)).toEqual(["loom.agents.active", "loom.cost.usd"]);
    const cost = series.find((s) => s.metric === "loom.cost.usd")!;
    expect(cost.points.map((p) => p.t)).toEqual([1784958000000, 1784958300000]);
    expect(cost.points[1]).toEqual({ t: 1784958300000, sum: 0.015, avg: 0.001875, max: 0.003, n: 8 });
  });

  it("strips SigNoz's internal __ labels but keeps the real ones", () => {
    const cost = rowsToSeries(rows).find((s) => s.metric === "loom.cost.usd")!;
    expect(cost.labels).toEqual({ "gen_ai.agent.id": "plannerbot", "loom.project": "weave" });
  });

  it("prefers sum for a counter and avg for a gauge", () => {
    const series = rowsToSeries(rows);
    expect(series.find((s) => s.metric === "loom.cost.usd")!.prefer).toBe("sum");
    expect(series.find((s) => s.metric === "loom.agents.active")!.prefer).toBe("avg");
  });

  it("keeps the fingerprint as a string — UInt64 does not survive a JS number", () => {
    const s = rowsToSeries(rows)[0];
    expect(typeof s.fingerprint).toBe("string");
    expect(s.fingerprint).toBe("5639057939949183367");
  });
});

describe("fetchMetricSeries", () => {
  it("asks for every loom metric when handed the default set", async () => {
    const seen = stubCh([]);
    await fetchMetricSeries(LOOM_METRIC_NAMES, { project: "weave" });
    for (const n of LOOM_METRIC_NAMES) expect(seen.sql).toContain(`'${n}'`);
    expect(seen.sql).toContain("'gen_ai.client.operation.duration.sum'");
  });

  it("returns nothing without querying when no usable name is given", async () => {
    const seen = stubCh([]);
    expect(await fetchMetricSeries(["", "  "], { project: "weave" })).toEqual([]);
    expect(seen.sql).toBeUndefined();
  });

  it("throws when ClickHouse is unreachable — the route turns this into from:unavailable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchMetricSeries(["loom.turns"], { project: "weave" })).rejects.toThrow();
  });
});
