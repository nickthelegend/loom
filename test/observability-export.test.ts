/**
 * Observability integration test: the full path from a real agent turn to a
 * conformant OTLP span. A stand-in OTLP collector (a local HTTP server)
 * receives the daemon's exports; we assert that driving echo agents through the
 * daemon produces gen_ai.agent.turn and loom.baton.handoff spans with the right
 * attributes, and that the /metrics endpoint reports the same numbers.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/core/registry.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

type OtlpSpan = { name: string; traceId: string; spanId: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status?: { code: number } };

let daemon: LoomDaemon;
let client: DaemonClient;
let cfg: DaemonConfig;
let baseUrl: string;
let projectId: string;
let collector: http.Server;
const received: OtlpSpan[] = [];
const services = new Set<string>();

function attrVal(v: Record<string, unknown>): unknown {
  return v.stringValue ?? (v.intValue != null ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue;
}
function spanAttrs(s: OtlpSpan): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const a of s.attributes || []) o[a.key] = attrVal(a.value);
  return o;
}

beforeAll(async () => {
  delete process.env.DO_NOT_TRACK;
  delete process.env.LOOM_TELEMETRY_DISABLED;
  delete process.env.LOOM_OTEL;

  collector = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        for (const rs of j.resourceSpans || []) {
          const svc = (rs.resource?.attributes || []).find((a: { key: string }) => a.key === "service.name");
          if (svc) services.add(String(svc.value.stringValue));
          for (const ss of rs.scopeSpans || []) received.push(...(ss.spans || []));
        }
      } catch {
        /* ignore malformed */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", () => r()));
  process.env.LOOM_OTEL_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  cfg = readDaemonConfig()!;
  client = new DaemonClient(cfg);
  projectId = (await client.addProject(makeProjectDir({ name: "obs" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
  await new Promise<void>((r) => collector.close(() => r()));
});

describe("Loom -> OTLP export (end to end)", () => {
  it("exports a gen_ai.agent.turn span to the collector on a real turn", async () => {
    await client.send(projectId, "hello");
    await waitUntil(async () => received.some((s) => s.name === "gen_ai.agent.turn"), { timeoutMs: 12_000 });
    const turn = received.find((s) => s.name === "gen_ai.agent.turn")!;
    expect(turn.traceId).toMatch(/^[0-9a-f]{32}$/);
    const a = spanAttrs(turn);
    expect(a["gen_ai.operation.name"]).toBe("chat");
    expect(a["gen_ai.agent.id"]).toBeTruthy();
    expect(a["loom.project"]).toBe("obs");
    // the export identifies itself to the backend as the `loom` service
    expect(services.has("loom")).toBe(true);
    // the turn span carries the full GenAI shape, not just tokens: the runtime
    // stamps the adapter kind (→ gen_ai.system) and correlates the turn's model
    // and cost onto run_complete so they ride the span.
    expect(a["gen_ai.system"]).toBe("echo"); // the adapter kind, not the fallback "loom"
    expect(a["gen_ai.request.model"]).toBe("echo-1");
    expect(Number(a["gen_ai.usage.cost_usd"])).toBeGreaterThan(0);
    expect(Number(a["gen_ai.usage.input_tokens"])).toBeGreaterThan(0);
    expect(Number(a["gen_ai.usage.output_tokens"])).toBeGreaterThan(0);
  });

  it("gives each turn its own trace id (per-turn correlation)", async () => {
    // one turn already ran in the first test; drive a second and compare.
    await client.send(projectId, "again");
    await waitUntil(async () => received.filter((s) => s.name === "gen_ai.agent.turn").length >= 2, { timeoutMs: 12_000 });
    const traces = received.filter((s) => s.name === "gen_ai.agent.turn").map((s) => s.traceId);
    expect(new Set(traces).size).toBeGreaterThanOrEqual(2); // distinct turns → distinct traces
    for (const t of traces) expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it("exports a loom.baton.handoff span after the baton moves", async () => {
    await client.handoff(projectId, "execbot");
    const toExec = () =>
      received.filter((s) => s.name === "loom.baton.handoff").map(spanAttrs).find((a) => a["loom.handoff.to"] === "execbot");
    await waitUntil(async () => !!toExec(), { timeoutMs: 12_000 });
    expect(toExec()!["loom.handoff.from"]).toBe("plannerbot");
  });

  it("serves per-agent metrics (cost + tokens) at /api/projects/:id/metrics", async () => {
    await waitUntil(async () => (await client.costs(projectId)).costs.turns >= 1, { timeoutMs: 8000 });
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/metrics`, {
      headers: { authorization: `Bearer ${cfg.adminToken}` },
    });
    expect(r.status).toBe(200);
    const { metrics } = (await r.json()) as { metrics: { totalUsd: number; tokensIn: number; tokensOut: number; byAgent: Array<Record<string, number>> } };
    expect(metrics.totalUsd).toBeGreaterThan(0);
    expect(metrics.tokensIn).toBeGreaterThan(0); // echo now reports deterministic tokens too
    expect(metrics.tokensOut).toBeGreaterThan(0);
    expect(Array.isArray(metrics.byAgent)).toBe(true);
    expect(metrics.byAgent[0]).toHaveProperty("tokensIn");
    expect(metrics.byAgent[0]).toHaveProperty("usd");
  });
});
