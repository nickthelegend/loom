/**
 * Observability unit tests: env-driven config + consent gating, the pure
 * LoomEvent -> OTel span mapper (GenAI semantic conventions), and the OTLP/HTTP
 * exporter's payload shape (hex ids, int64-as-string, service.name, batching).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { LoomTelemetry, resolveTelemetryConfig } from "../src/observability/otlp.js";
import { eventToSpan } from "../src/observability/index.js";

const ev = (
  kind: string,
  payload: Record<string, unknown> = {},
  extra: Partial<LoomEvent> = {},
): LoomEvent => ({ id: 1, ts: 1_000, kind: kind as LoomEvent["kind"], payload, ...extra });

describe("resolveTelemetryConfig", () => {
  it("defaults to localhost:4318, service 'loom', enabled", () => {
    const c = resolveTelemetryConfig({});
    expect(c.endpoint).toBe("http://localhost:4318");
    expect(c.serviceName).toBe("loom");
    expect(c.enabled).toBe(true);
  });

  it("honors each endpoint env var and trims a trailing slash", () => {
    expect(resolveTelemetryConfig({ LOOM_OTEL_ENDPOINT: "http://a:4318/" }).endpoint).toBe("http://a:4318");
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://b:4318" }).endpoint).toBe("http://b:4318");
  });

  it("prefers the loom-specific endpoint over the generic one", () => {
    const c = resolveTelemetryConfig({
      LOOM_OTEL_ENDPOINT: "http://mine:4318",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://theirs:4318",
    });
    expect(c.endpoint).toBe("http://mine:4318");
  });

  it("disables under every consent opt-out", () => {
    expect(resolveTelemetryConfig({ DO_NOT_TRACK: "1" }).enabled).toBe(false);
    expect(resolveTelemetryConfig({ LOOM_TELEMETRY_DISABLED: "1" }).enabled).toBe(false);
    expect(resolveTelemetryConfig({ LOOM_OTEL: "0" }).enabled).toBe(false);
  });

  it("carries a backend's ingestion key via the standard OTLP headers var", () => {
    // Whatever header the destination wants — an access token, an API key —
    // arrives as data. Hardcoding one vendor's header name would have meant a
    // code change per backend.
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_HEADERS: "signoz-access-token=secret,x-api-key=other",
    });
    expect(c.headers["signoz-access-token"]).toBe("secret");
    expect(c.headers["x-api-key"]).toBe("other");
    expect(c.headers["content-type"]).toBe("application/json");
  });

  it("url-decodes a header value and ignores malformed pairs", () => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc,garbage,=novalue,nokey=",
    });
    expect(c.headers.authorization).toBe("Bearer abc");
    expect(Object.keys(c.headers)).toEqual(["content-type", "authorization"]);
  });
});

describe("eventToSpan (LoomEvent -> OTel span)", () => {
  it("maps run_complete to gen_ai.agent.turn with cost, tokens, model, and a duration window", () => {
    const s = eventToSpan(
      ev(
        "run_complete",
        { durationMs: 1500, costUsd: 0.02, inputTokens: 100, outputTokens: 50, model: "claude-opus-4-8", adapter: "codex" },
        { agentId: "codex", chat: "main" },
      ),
      { project: "acme" },
    )!;
    expect(s.name).toBe("gen_ai.agent.turn");
    expect(s.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(s.attributes["gen_ai.system"]).toBe("codex");
    expect(s.attributes["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(s.attributes["gen_ai.usage.cost_usd"]).toBe(0.02);
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(s.attributes["gen_ai.agent.id"]).toBe("codex");
    expect(s.attributes["loom.project"]).toBe("acme");
    expect(s.endNs - s.startNs).toBe(1500n * 1_000_000n);
  });

  it("reads tokensIn/tokensOut as an alias for input/output tokens", () => {
    const s = eventToSpan(ev("run_complete", { tokensIn: 7, tokensOut: 3 }))!;
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(7);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(3);
  });

  it("maps handoff to loom.baton.handoff with from/to", () => {
    const s = eventToSpan(ev("handoff", { from: "planner", to: "exec" }))!;
    expect(s.name).toBe("loom.baton.handoff");
    expect(s.attributes["loom.handoff.from"]).toBe("planner");
    expect(s.attributes["loom.handoff.to"]).toBe("exec");
  });

  it("maps route_failed to an errored route span", () => {
    const s = eventToSpan(ev("route_failed", { routeId: "r1", error: "boom" }))!;
    expect(s.name).toBe("loom.route.failed");
    expect(s.attributes["loom.route.id"]).toBe("r1");
    expect(s.error).toBe("boom");
  });

  it("maps memory + tool + error kinds", () => {
    expect(eventToSpan(ev("memory_add", { kind: "fact" }))!.name).toBe("loom.memory.add");
    expect(eventToSpan(ev("tool_call", { tool: "grep" }))!.attributes["gen_ai.tool.name"]).toBe("grep");
    const e = eventToSpan(ev("error", { message: "nope" }))!;
    expect(e.name).toBe("loom.error");
    expect(e.error).toBe("nope");
  });

  it("returns null for non-telemetry kinds (message, status)", () => {
    expect(eventToSpan(ev("message", { text: "hi" }))).toBeNull();
    expect(eventToSpan(ev("status", { state: "turn_cost", costUsd: 0.001 }))).toBeNull();
  });
});

describe("LoomTelemetry (OTLP/HTTP JSON export)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const calls: Array<{ url: string; opts: { headers: Record<string, string>; body: string } }> = [];
    const fn = vi.fn(async (url: string, opts: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, opts });
      return { ok: true } as Response;
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls };
  }

  it("posts one valid OTLP payload on flush: service.name, hex ids, int64-as-string", async () => {
    const { fn, calls } = stubFetch();
    const t = new LoomTelemetry({
      endpoint: "http://collector:4318",
      serviceName: "loom",
      headers: { "content-type": "application/json" },
      enabled: true,
    });
    t.span({
      name: "gen_ai.agent.turn",
      startNs: 0n,
      endNs: 1_000_000n,
      attributes: { "gen_ai.usage.input_tokens": 100, "gen_ai.usage.cost_usd": 0.02, "gen_ai.agent.id": "codex", flagged: true },
    });
    t.flush();
    await new Promise((r) => setTimeout(r, 10));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("http://collector:4318/v1/traces");
    const body = JSON.parse(calls[0].opts.body);
    const rs = body.resourceSpans[0];
    expect(rs.resource.attributes.find((a: { key: string }) => a.key === "service.name").value.stringValue).toBe("loom");
    const span = rs.scopeSpans[0].spans[0];
    expect(span.name).toBe("gen_ai.agent.turn");
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.status.code).toBe(1);
    const attr = (k: string) => span.attributes.find((a: { key: string }) => a.key === k).value;
    expect(attr("gen_ai.usage.input_tokens").intValue).toBe("100"); // int64 -> string
    expect(attr("gen_ai.usage.cost_usd").doubleValue).toBe(0.02);
    expect(attr("flagged").boolValue).toBe(true);
  });

  it("marks a span with an error message as ERROR status", async () => {
    const { calls } = stubFetch();
    const t = new LoomTelemetry({ endpoint: "http://c:4318", serviceName: "loom", headers: {}, enabled: true });
    t.span({ name: "loom.error", startNs: 0n, endNs: 1n, attributes: {}, error: "kaboom" });
    t.flush();
    await new Promise((r) => setTimeout(r, 10));
    const span = JSON.parse(calls[0].opts.body).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe("kaboom");
  });

  it("does not post when disabled (consent gate)", async () => {
    const { fn } = stubFetch();
    const t = new LoomTelemetry({ endpoint: "http://c:4318", serviceName: "loom", headers: {}, enabled: false });
    expect(t.enabled).toBe(false);
    t.span({ name: "x", startNs: 0n, endNs: 1n, attributes: {} });
    t.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
  });

  it("drops undefined/empty attributes instead of emitting them", async () => {
    const { calls } = stubFetch();
    const t = new LoomTelemetry({ endpoint: "http://c:4318", serviceName: "loom", headers: {}, enabled: true });
    t.span({ name: "s", startNs: 0n, endNs: 1n, attributes: { keep: "yes", drop1: undefined, drop2: null, drop3: "" } });
    t.flush();
    await new Promise((r) => setTimeout(r, 10));
    const keys = JSON.parse(calls[0].opts.body).resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: { key: string }) => a.key);
    expect(keys).toContain("keep");
    expect(keys).not.toContain("drop1");
    expect(keys).not.toContain("drop2");
    expect(keys).not.toContain("drop3");
  });
});
