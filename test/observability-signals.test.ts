/**
 * Metrics and logs unit tests: the OTLP payload shapes a collector will reject
 * if we get them wrong (sum/histogram/gauge bodies, temporality, asInt vs
 * asDouble, log record fields), the LoomEvent -> datapoint and
 * LoomEvent -> log record mappers, honest severity mapping, and the rule this
 * codebase cares about most — never invent a number an adapter didn't report.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { LoomMetrics } from "../src/observability/metrics.js";
import { LoomLogs, SEVERITY, eventToLogRecord, truncate } from "../src/observability/logs.js";
import { eventToMetrics, flushTelemetry, recordAgentEvent } from "../src/observability/index.js";
import { resolveTelemetryConfig, type TelemetryConfig } from "../src/observability/otlp.js";

const ev = (
  kind: string,
  payload: Record<string, unknown> = {},
  extra: Partial<LoomEvent> = {},
): LoomEvent => ({ id: 1, ts: 1_000, kind: kind as LoomEvent["kind"], payload, ...extra });

const cfg = (over: Partial<TelemetryConfig> = {}): TelemetryConfig => ({
  endpoint: "http://collector:4318",
  serviceName: "loom",
  headers: { "content-type": "application/json" },
  enabled: true,
  metricsEnabled: true,
  logsEnabled: true,
  ...over,
});

function stubFetch() {
  const calls: Array<{ url: string; opts: { headers: Record<string, string>; body: string } }> = [];
  const fn = vi.fn(async (url: string, opts: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, opts });
    return { ok: true } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Per-signal switches
// ---------------------------------------------------------------------------

describe("resolveTelemetryConfig — per-signal switches", () => {
  it("keeps metrics and logs on by default", () => {
    const c = resolveTelemetryConfig({});
    expect(c.metricsEnabled).toBe(true);
    expect(c.logsEnabled).toBe(true);
  });

  it("drops one signal without touching the others", () => {
    const noMetrics = resolveTelemetryConfig({ LOOM_OTEL_METRICS: "0" });
    expect(noMetrics.enabled).toBe(true);
    expect(noMetrics.metricsEnabled).toBe(false);
    expect(noMetrics.logsEnabled).toBe(true);

    const noLogs = resolveTelemetryConfig({ LOOM_OTEL_LOGS: "0" });
    expect(noLogs.enabled).toBe(true);
    expect(noLogs.metricsEnabled).toBe(true);
    expect(noLogs.logsEnabled).toBe(false);
  });

  it("lets a consent opt-out kill every signal, not just traces", () => {
    for (const env of [{ DO_NOT_TRACK: "1" }, { LOOM_TELEMETRY_DISABLED: "1" }, { LOOM_OTEL: "0" }]) {
      const c = resolveTelemetryConfig(env);
      expect([c.enabled, c.metricsEnabled, c.logsEnabled]).toEqual([false, false, false]);
    }
  });
});

// ---------------------------------------------------------------------------
// eventToMetrics — the mapping, and the no-fake-numbers rule
// ---------------------------------------------------------------------------

describe("eventToMetrics (LoomEvent -> datapoints)", () => {
  const find = (ops: ReturnType<typeof eventToMetrics>, name: string) => ops.filter((o) => o.name === name);

  it("splits token usage into input/output series per the GenAI convention", () => {
    const ops = eventToMetrics(
      ev("run_complete", { durationMs: 2000, inputTokens: 900, outputTokens: 120, model: "gpt-5-codex", adapter: "codex" }, { agentId: "codex" }),
    );
    const tokens = find(ops, "gen_ai.client.token.usage");
    expect(tokens).toHaveLength(2);
    const input = tokens.find((t) => t.attributes["gen_ai.token.type"] === "input")!;
    const output = tokens.find((t) => t.attributes["gen_ai.token.type"] === "output")!;
    expect(input.value).toBe(900);
    expect(output.value).toBe(120);
    expect(input.attributes["gen_ai.agent.id"]).toBe("codex");
    expect(input.attributes["gen_ai.request.model"]).toBe("gpt-5-codex");
    expect(input.attributes["gen_ai.operation.name"]).toBe("chat");
  });

  it("records turn duration as a histogram in seconds, not milliseconds", () => {
    const ops = eventToMetrics(ev("run_complete", { durationMs: 2500 }, { agentId: "a" }));
    const d = find(ops, "gen_ai.client.operation.duration")[0]!;
    expect(d.op).toBe("histogram");
    expect(d.value).toBe(2.5);
  });

  it("counts a completed turn with an ok/error status", () => {
    const ok = find(eventToMetrics(ev("run_complete", { durationMs: 1 }, { agentId: "a" })), "loom.turns")[0]!;
    expect(ok.value).toBe(1);
    expect(ok.attributes.status).toBe("ok");
    const bad = find(eventToMetrics(ev("run_complete", { durationMs: 1, error: "boom" }, { agentId: "a" })), "loom.turns")[0]!;
    expect(bad.attributes.status).toBe("error");
  });

  it("emits cost only when an adapter actually reported one", () => {
    const withCost = find(eventToMetrics(ev("run_complete", { durationMs: 1, costUsd: 0.031 }, { agentId: "cc" })), "loom.cost.usd");
    expect(withCost).toHaveLength(1);
    expect(withCost[0]!.value).toBeCloseTo(0.031);
    expect(withCost[0]!.op === "count" && withCost[0]!.isInt).toBe(false); // money is not an integer
  });

  it("emits NO cost datapoint for adapters that report none — absent is not zero", () => {
    // codex reports tokens and deliberately never a dollar figure.
    const codex = ev("run_complete", { durationMs: 1200, inputTokens: 52831, outputTokens: 120, adapter: "codex" }, { agentId: "codex" });
    expect(find(eventToMetrics(codex), "loom.cost.usd")).toHaveLength(0);
    // and an explicit zero is still not a spend worth counting
    expect(find(eventToMetrics(ev("run_complete", { durationMs: 1, costUsd: 0 })), "loom.cost.usd")).toHaveLength(0);
    expect(find(eventToMetrics(ev("run_complete", { durationMs: 1, costUsd: null })), "loom.cost.usd")).toHaveLength(0);
  });

  it("emits no token datapoints when the adapter tracked no usage", () => {
    // antigravity reports duration and model only; runtime.ts writes 0s.
    const agy = ev("run_complete", { durationMs: 15000, model: "gemini-flash", inputTokens: 0, outputTokens: 0 }, { agentId: "antigravity" });
    const ops = eventToMetrics(agy);
    expect(find(ops, "gen_ai.client.token.usage")).toHaveLength(0);
    expect(find(ops, "gen_ai.client.operation.duration")).toHaveLength(1); // duration is real, though
    expect(find(ops, "loom.turns")).toHaveLength(1);
  });

  it("counts a baton handoff with from/to", () => {
    const op = eventToMetrics(ev("handoff", { from: "planner", to: "coder" }, { agentId: "planner" }))[0]!;
    expect(op.name).toBe("loom.handoffs");
    expect(op.value).toBe(1);
    expect(op.attributes["loom.handoff.from"]).toBe("planner");
    expect(op.attributes["loom.handoff.to"]).toBe("coder");
  });

  it("produces nothing for events that carry no measurement", () => {
    expect(eventToMetrics(ev("message", { text: "hi" }))).toEqual([]);
    expect(eventToMetrics(ev("file_edit", { path: "/a.ts" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LoomMetrics — the OTLP wire shapes
// ---------------------------------------------------------------------------

describe("LoomMetrics (OTLP/HTTP JSON export)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const metricNamed = (body: string, name: string) =>
    JSON.parse(body).resourceMetrics[0].scopeMetrics[0].metrics.find((m: { name: string }) => m.name === name);

  it("posts a sum body with delta temporality, isMonotonic and asInt datapoints", async () => {
    const { calls } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.addCount("gen_ai.client.token.usage", 100, { "gen_ai.token.type": "input", "gen_ai.agent.id": "codex" });
    m.addCount("gen_ai.client.token.usage", 40, { "gen_ai.token.type": "input", "gen_ai.agent.id": "codex" });
    m.flush();
    await settle();

    expect(calls[0]!.url).toBe("http://collector:4318/v1/metrics");
    const body = JSON.parse(calls[0]!.opts.body);
    const rm = body.resourceMetrics[0];
    expect(rm.resource.attributes.find((a: { key: string }) => a.key === "service.name").value.stringValue).toBe("loom");
    const metric = rm.scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("gen_ai.client.token.usage");
    expect(metric.unit).toBe("{token}");
    expect(metric.sum.aggregationTemporality).toBe(2); // DELTA
    expect(metric.sum.isMonotonic).toBe(true);
    const dp = metric.sum.dataPoints[0];
    expect(dp.asInt).toBe("140"); // same attribute set coalesced, int64 as string
    expect(typeof dp.startTimeUnixNano).toBe("string");
    expect(typeof dp.timeUnixNano).toBe("string");
    expect(dp.attributes.find((a: { key: string }) => a.key === "gen_ai.token.type").value.stringValue).toBe("input");
  });

  it("keeps distinct attribute sets as distinct datapoints", async () => {
    const { calls } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.addCount("gen_ai.client.token.usage", 10, { "gen_ai.token.type": "input" });
    m.addCount("gen_ai.client.token.usage", 3, { "gen_ai.token.type": "output" });
    m.flush();
    await settle();
    expect(metricNamed(calls[0]!.opts.body, "gen_ai.client.token.usage").sum.dataPoints).toHaveLength(2);
  });

  it("uses asDouble for money so a three-cent turn is not rounded to nothing", async () => {
    const { calls } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.addCount("loom.cost.usd", 0.031, { "gen_ai.agent.id": "cc" }, false);
    m.flush();
    await settle();
    const metric = metricNamed(calls[0]!.opts.body, "loom.cost.usd");
    expect(metric.unit).toBe("USD");
    expect(metric.sum.dataPoints[0].asDouble).toBeCloseTo(0.031);
    expect(metric.sum.dataPoints[0].asInt).toBeUndefined();
  });

  it("posts a histogram body with buckets that line up with the boundaries", async () => {
    const { calls } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.record("gen_ai.client.operation.duration", 0.5, { "gen_ai.agent.id": "a" });
    m.record("gen_ai.client.operation.duration", 15, { "gen_ai.agent.id": "a" });
    m.flush();
    await settle();

    const h = metricNamed(calls[0]!.opts.body, "gen_ai.client.operation.duration").histogram;
    expect(h.aggregationTemporality).toBe(2);
    const dp = h.dataPoints[0];
    expect(dp.count).toBe("2"); // int64 as string
    expect(dp.sum).toBeCloseTo(15.5);
    expect(dp.min).toBe(0.5);
    expect(dp.max).toBe(15);
    // OTLP requires exactly one more bucket than boundaries (the +Inf bucket).
    expect(dp.bucketCounts).toHaveLength(dp.explicitBounds.length + 1);
    expect(dp.bucketCounts.every((c: string) => typeof c === "string")).toBe(true);
    expect(dp.bucketCounts.reduce((n: number, c: string) => n + Number(c), 0)).toBe(2);
  });

  it("posts a gauge body with no temporality and no start time — it is a reading", async () => {
    const { calls } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.setGauge("loom.agents.active", 2, { "loom.project": "acme" });
    m.setGauge("loom.agents.active", 1, { "loom.project": "acme" }); // last observation wins
    m.flush();
    await settle();

    const metric = metricNamed(calls[0]!.opts.body, "loom.agents.active");
    expect(metric.unit).toBe("{agent}");
    expect(metric.gauge.aggregationTemporality).toBeUndefined();
    const dp = metric.gauge.dataPoints[0];
    expect(dp.asInt).toBe("1");
    expect(dp.startTimeUnixNano).toBeUndefined();
    expect(typeof dp.timeUnixNano).toBe("string");
  });

  it("gives consecutive delta windows non-overlapping start/end times", async () => {
    const { calls } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.addCount("loom.turns", 1, { status: "ok" });
    m.flush();
    await settle();
    m.addCount("loom.turns", 1, { status: "ok" });
    m.flush();
    await settle();

    const first = metricNamed(calls[0]!.opts.body, "loom.turns").sum.dataPoints[0];
    const second = metricNamed(calls[1]!.opts.body, "loom.turns").sum.dataPoints[0];
    expect(second.startTimeUnixNano).toBe(first.timeUnixNano); // window advanced, no overlap
    // and the counter reset: delta means "since last export", not a running total
    expect(second.asInt).toBe("1");
  });

  it("does not post when metrics are switched off", async () => {
    const { fn } = stubFetch();
    const m = new LoomMetrics(cfg({ metricsEnabled: false }));
    expect(m.enabled).toBe(false);
    m.addCount("loom.turns", 1, {});
    m.record("gen_ai.client.operation.duration", 1, {});
    m.setGauge("loom.agents.active", 3, {});
    m.flush();
    await settle();
    expect(fn).not.toHaveBeenCalled();
  });

  it("posts nothing at all when no event produced a datapoint", async () => {
    const { fn } = stubFetch();
    const m = new LoomMetrics(cfg());
    m.flush();
    await settle();
    expect(fn).not.toHaveBeenCalled(); // no synthetic zero-valued heartbeat
  });
});

// ---------------------------------------------------------------------------
// eventToLogRecord — bodies, attributes, severity
// ---------------------------------------------------------------------------

describe("eventToLogRecord (LoomEvent -> OTLP log record)", () => {
  it("maps an agent message to INFO with the text as the body", () => {
    const r = eventToLogRecord(ev("message", { text: "shipping the fix" }, { agentId: "codex", chat: "main" }), { project: "acme" })!;
    expect(r.severityNumber).toBe(SEVERITY.INFO);
    expect(r.body).toBe("shipping the fix");
    expect(r.attributes["gen_ai.agent.id"]).toBe("codex");
    expect(r.attributes["loom.project"]).toBe("acme");
    expect(r.attributes["loom.chat"]).toBe("main");
    expect(r.attributes["loom.event.kind"]).toBe("message");
    expect(r.timeUnixNano).toBe(1_000_000_000n); // ts 1000ms -> ns
  });

  it("tags reasoning so it can be filtered out of what the agent actually said", () => {
    const r = eventToLogRecord(ev("message", { text: "hmm", reasoning: true }, { agentId: "a" }))!;
    expect(r.attributes["loom.message.reasoning"]).toBe(true);
  });

  it("maps tool calls and file edits with their own attributes", () => {
    const tool = eventToLogRecord(ev("tool_call", { tool: "Bash", command: "ls" }, { agentId: "a" }))!;
    expect(tool.severityNumber).toBe(SEVERITY.INFO);
    expect(tool.attributes["gen_ai.tool.name"]).toBe("Bash");
    expect(tool.body).toContain("Bash");

    const edit = eventToLogRecord(ev("file_edit", { path: "/repo/a.ts", tool: "agy" }, { agentId: "a" }))!;
    expect(edit.attributes["loom.file.path"]).toBe("/repo/a.ts");
    expect(edit.body).toContain("/repo/a.ts");
  });

  it("maps a decision and a route step", () => {
    const d = eventToLogRecord(ev("decision", { text: "use delta temporality" }, { agentId: "a" }))!;
    expect(d.body).toContain("use delta temporality");
    const s = eventToLogRecord(ev("route_step", { routeId: "r1", step: "review" }))!;
    expect(s.severityNumber).toBe(SEVERITY.INFO);
    expect(s.attributes["loom.route.id"]).toBe("r1");
    expect(s.attributes["loom.route.phase"]).toBe("step");
  });

  it("maps severity honestly: error ERROR, notice WARN, message INFO, chatter DEBUG", () => {
    expect(eventToLogRecord(ev("error", { message: "agy exited 1" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.ERROR);
    expect(eventToLogRecord(ev("route_failed", { routeId: "r1", error: "no" }))!.severityNumber).toBe(SEVERITY.ERROR);
    expect(eventToLogRecord(ev("run_complete", { durationMs: 5, error: "boom" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.ERROR);

    expect(eventToLogRecord(ev("needs_input", { question: "which one?" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.WARN);
    expect(eventToLogRecord(ev("route_paused", { routeId: "r1" }))!.severityNumber).toBe(SEVERITY.WARN);

    expect(eventToLogRecord(ev("message", { text: "hi" }))!.severityNumber).toBe(SEVERITY.INFO);
    expect(eventToLogRecord(ev("handoff", { from: "a", to: "b" }))!.severityNumber).toBe(SEVERITY.INFO);
    expect(eventToLogRecord(ev("run_complete", { durationMs: 5 }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.INFO);

    expect(eventToLogRecord(ev("status", { state: "turn_started" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.DEBUG);
  });

  it("surfaces a budget pause at WARN with the real numbers", () => {
    const r = eventToLogRecord(ev("status", { state: "budget_exceeded", budgetUsd: 5, spentTodayUsd: 5.4 }, { agentId: "cc" }))!;
    expect(r.severityNumber).toBe(SEVERITY.WARN);
    expect(r.body).toContain("$5.40");
    expect(r.body).toContain("$5.00");
    expect(r.attributes["loom.budget.usd"]).toBe(5);
    expect(r.attributes["loom.budget.spent_today_usd"]).toBe(5.4);
    expect(eventToLogRecord(ev("status", { state: "budget_recovered", pausedMs: 60_000 }, { agentId: "cc" }))!.severityNumber).toBe(SEVERITY.INFO);
  });

  it("truncates an enormous body with a marker instead of shipping it whole", () => {
    const huge = "x".repeat(200_000);
    const r = eventToLogRecord(ev("message", { text: huge }, { agentId: "a" }))!;
    expect(r.body.length).toBeLessThan(9_000);
    expect(r.body).toMatch(/… \[truncated \d+ chars\]$/);
    expect(truncate("short", 100)).toBe("short"); // untouched when it fits
  });

  it("returns null for events with nothing a human would read", () => {
    expect(eventToLogRecord(ev("message", { text: "" }))).toBeNull();
    expect(eventToLogRecord(ev("agent_join", { id: "a" }))).toBeNull();
    expect(eventToLogRecord(ev("turn_diff", { files: 2 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LoomLogs — the OTLP wire shape
// ---------------------------------------------------------------------------

describe("LoomLogs (OTLP/HTTP JSON export)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts a log record with every field a backend needs, including trace linkage", async () => {
    const { calls } = stubFetch();
    const l = new LoomLogs(cfg());
    l.log({
      timeUnixNano: 1_700_000_000_000_000_000n,
      severityNumber: SEVERITY.INFO,
      body: "codex completed a turn in 1500ms",
      attributes: { "gen_ai.agent.id": "codex", "loom.turn.duration_ms": 1500 },
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    });
    l.flush();
    await settle();

    expect(calls[0]!.url).toBe("http://collector:4318/v1/logs");
    const rl = JSON.parse(calls[0]!.opts.body).resourceLogs[0];
    expect(rl.resource.attributes.find((a: { key: string }) => a.key === "service.name").value.stringValue).toBe("loom");
    const r = rl.scopeLogs[0].logRecords[0];
    expect(r.timeUnixNano).toBe("1700000000000000000"); // int64 as string
    expect(r.observedTimeUnixNano).toBe(r.timeUnixNano);
    expect(r.severityNumber).toBe(9);
    expect(r.severityText).toBe("INFO");
    expect(r.body.stringValue).toBe("codex completed a turn in 1500ms");
    expect(r.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(r.attributes.find((a: { key: string }) => a.key === "loom.turn.duration_ms").value.intValue).toBe("1500");
  });

  it("omits traceId/spanId rather than sending empty ones", async () => {
    const { calls } = stubFetch();
    const l = new LoomLogs(cfg());
    l.log({ timeUnixNano: 1n, severityNumber: SEVERITY.ERROR, body: "orphan", attributes: {} });
    l.flush();
    await settle();
    const r = JSON.parse(calls[0]!.opts.body).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(r.traceId).toBeUndefined();
    expect(r.spanId).toBeUndefined();
    expect(r.severityText).toBe("ERROR");
  });

  it("does not post when logs are switched off", async () => {
    const { fn } = stubFetch();
    const l = new LoomLogs(cfg({ logsEnabled: false }));
    expect(l.enabled).toBe(false);
    l.log({ timeUnixNano: 1n, severityNumber: SEVERITY.INFO, body: "x", attributes: {} });
    l.flush();
    await settle();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// recordAgentEvent — the single funnel, fanning one event out to three signals
// ---------------------------------------------------------------------------

describe("recordAgentEvent (one event -> span + metric + log)", () => {
  // Every other block here builds its exporter with an explicit config object,
  // so the suite-wide LOOM_TELEMETRY_DISABLED never reached them. These tests
  // are the exception: recordAgentEvent goes through the process-wide singleton,
  // which reads the environment, and a disabled singleton posts nothing — the
  // assertions then read [0] of an empty array. Cleared before the first `it`,
  // which is when the singleton first wakes, and restored afterwards so the
  // rest of the run stays hermetic.
  const wasDisabled = process.env.LOOM_TELEMETRY_DISABLED;
  beforeAll(() => {
    delete process.env.LOOM_TELEMETRY_DISABLED;
  });
  afterAll(() => {
    if (wasDisabled != null) process.env.LOOM_TELEMETRY_DISABLED = wasDisabled;
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Sort a batch of posts by signal, so a test can assert on one at a time. */
  function bySignal(calls: Array<{ url: string; opts: { body: string } }>) {
    const pick = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).map((c) => JSON.parse(c.opts.body));
    return { traces: pick("/v1/traces"), metrics: pick("/v1/metrics"), logs: pick("/v1/logs") };
  }

  it("emits a span, a log correlated to that exact span, and datapoints — from one event", async () => {
    const { calls } = stubFetch();
    recordAgentEvent(
      { id: 7, ts: 1_700_000_000_000, kind: "run_complete", agentId: "funnel-a", payload: { durationMs: 1500, model: "m1", adapter: "echo", costUsd: 0.002, inputTokens: 80, outputTokens: 20 } },
      { project: "acme" },
    );
    flushTelemetry();
    await settle();

    const { traces, metrics: mp, logs: lp } = bySignal(calls);
    const span = traces[0].resourceSpans[0].scopeSpans[0].spans[0];
    const record = lp[0].resourceLogs[0].scopeLogs[0].logRecords[0];
    // The log points at the span this same event produced — that is the link
    // that makes a trace clickable through to what the agent actually said.
    expect(record.traceId).toBe(span.traceId);
    expect(record.spanId).toBe(span.spanId);
    expect(record.body.stringValue).toContain("completed a turn in 1500ms");

    const names = mp[0].resourceMetrics[0].scopeMetrics[0].metrics.map((m: { name: string }) => m.name);
    expect(names).toContain("gen_ai.client.token.usage");
    expect(names).toContain("gen_ai.client.operation.duration");
    expect(names).toContain("loom.turns");
    expect(names).toContain("loom.cost.usd");
  });

  it("tracks the active-agents gauge for adapters that never emit turn_started", async () => {
    const { calls } = stubFetch();
    // echo / opencode / antigravity-cli announce no turn boundary at all; the
    // first event of a turn is all we get, and the gauge must still move.
    recordAgentEvent({ id: 1, ts: 1, kind: "message", agentId: "gauge-a", payload: { text: "working" } }, {});
    flushTelemetry();
    await settle();
    const opened = bySignal(calls).metrics.at(-1)!.resourceMetrics[0].scopeMetrics[0].metrics.find((m: { name: string }) => m.name === "loom.agents.active");
    expect(opened.gauge.dataPoints[0].asInt).toBe("1");

    recordAgentEvent({ id: 2, ts: 2, kind: "run_complete", agentId: "gauge-a", payload: { durationMs: 5 } }, {});
    flushTelemetry();
    await settle();
    const closed = bySignal(calls).metrics.at(-1)!.resourceMetrics[0].scopeMetrics[0].metrics.find((m: { name: string }) => m.name === "loom.agents.active");
    expect(closed.gauge.dataPoints[0].asInt).toBe("0");
  });

  it("brings the gauge back down when a turn dies instead of completing", async () => {
    const { calls } = stubFetch();
    recordAgentEvent({ id: 1, ts: 1, kind: "message", agentId: "gauge-b", payload: { text: "starting" } }, {});
    recordAgentEvent({ id: 2, ts: 2, kind: "error", agentId: "gauge-b", payload: { message: "agy exited 1" } }, {});
    flushTelemetry();
    await settle();
    const g = bySignal(calls).metrics.at(-1)!.resourceMetrics[0].scopeMetrics[0].metrics.find((m: { name: string }) => m.name === "loom.agents.active");
    // an errored turn is over; a gauge that only counts down on the happy path
    // ratchets up forever and stops being worth reading
    expect(g.gauge.dataPoints.at(-1).asInt).toBe("0");
  });

  it("gives a failed turn its own trace instead of folding it into the next one", async () => {
    const { calls } = stubFetch();
    recordAgentEvent({ id: 1, ts: 1, kind: "message", agentId: "trace-a", payload: { text: "one" } }, {});
    recordAgentEvent({ id: 2, ts: 2, kind: "error", agentId: "trace-a", payload: { message: "boom" } }, {});
    recordAgentEvent({ id: 3, ts: 3, kind: "message", agentId: "trace-a", payload: { text: "two" } }, {});
    flushTelemetry();
    await settle();
    const records = bySignal(calls).logs.flatMap((p) => p.resourceLogs[0].scopeLogs[0].logRecords);
    const [one, boom, two] = ["one", "boom", "two"].map((b) => records.find((r: { body: { stringValue: string } }) => r.body.stringValue.includes(b))!);
    expect(one.traceId).toBe(boom.traceId); // the failure belongs to the turn it killed
    expect(two.traceId).not.toBe(boom.traceId); // the next turn is a new trace
  });
});
