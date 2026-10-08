/**
 * The free pool: model agents spreading their turns across a provider's free
 * models. Against a fake provider on the wire, like model-adapter.test.ts.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModelAdapter } from "../src/adapters/model.js";
import { freeModels, freeUsage, isDailyCap, resetAt, resetPool, rest, rotation } from "../src/core/free-pool.js";
import { resolveProvider, setProvider } from "../src/core/providers.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

let server: http.Server | null = null;
beforeEach(() => resetPool());
afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const FREE = (id: string, ctx: number, tools = true) =>
  ({ id, context_length: ctx, pricing: { prompt: "0", completion: "0" }, supported_parameters: tools ? ["tools"] : [] });
const LIST = [
  FREE("big/model:free", 1_000_000), FREE("mid/model:free", 200_000), FREE("small/model:free", 60_000),
  FREE("google/lyria-3-pro-preview", 1_000_000), FREE("notools/model:free", 100_000, false),
  { id: "paid/model", context_length: 400_000, pricing: { prompt: "0.000001", completion: "0.000002" } },
];

async function provider(statusFor: (model: string) => { status: number; body?: string; headers?: Record<string, string> } = () => ({ status: 200 })) {
  const seen: string[] = [];
  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ data: LIST }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const model = String((JSON.parse(raw || "{}") as { model?: string }).model);
      seen.push(model);
      const r = statusFor(model);
      if (r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        return void res.end(r.body ?? JSON.stringify({ error: { message: "busy" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `hi from ${model}` } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  const port = await new Promise<number>((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port)));
  const id = `pool-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "Fake" });
  return { id, seen };
}

const listen = (a: ModelAdapter) => { const ev: AdapterEvent[] = []; a.onEvent((e) => ev.push(e)); return ev; };

describe("which models are in the pool", () => {
  it("free chat models only, most context first; tools when the agent uses them", async () => {
    process.env.LOOM_HOME = tmpDir("home-pool");
    const { id } = await provider();
    const p = resolveProvider(id)!;
    expect((await freeModels(p)).map((m) => m.id)).toEqual(["big/model:free", "mid/model:free", "notools/model:free", "small/model:free"]);
    expect((await freeModels(p, { tools: true })).map((m) => m.id)).toEqual(["big/model:free", "mid/model:free", "small/model:free"]);
  });

  it("rotates its starting point every turn, and puts a resting model last", () => {
    const ms = [{ id: "a", context: 3, tools: true }, { id: "b", context: 2, tools: true }, { id: "c", context: 1, tools: true }];
    expect(rotation(ms)).toEqual(["a", "b", "c"]);
    expect(rotation(ms)).toEqual(["b", "c", "a"]);
    rest("c");
    expect(rotation(ms)).toEqual(["a", "b", "c"]); // c's turn to lead, but it's resting
  });

  it("tells the daily cap from one busy model", () => {
    expect(isDailyCap(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}')).toBe(true);
    expect(isDailyCap(429, '{"error":{"message":"is temporarily rate-limited upstream"}}')).toBe(false);
    expect(resetAt(new Headers({ "x-ratelimit-reset": "1791500000000" }))).toBe(1791500000000);
    expect(resetAt(new Headers({ "x-ratelimit-reset": "1791500000" }))).toBe(1791500000000);
    expect(resetAt(new Headers())).toBeNull();
  });
});

describe("a model agent on pool:free", () => {
  it("spreads consecutive turns across different free models, and counts them", async () => {
    process.env.LOOM_HOME = tmpDir("home-pool-turns");
    const { id, seen } = await provider();
    const agent = new ModelAdapter("free", tmpDir("p"), { provider: id, model: "pool:free" });
    for (let i = 0; i < 3; i++) await agent.send({ text: `turn ${i}` });
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((m) => m.endsWith(":free"))).toBe(true);
    expect(freeUsage().used).toBe(3);
  });

  it("a busy model hands the turn to the next one", async () => {
    process.env.LOOM_HOME = tmpDir("home-pool-busy");
    const { id, seen } = await provider((m) => (m === "big/model:free" ? { status: 429, headers: { "retry-after": "30" } } : { status: 200 }));
    const agent = new ModelAdapter("free", tmpDir("p"), { provider: id, model: "pool:free" });
    const ev = listen(agent);
    await agent.send({ text: "go" });
    expect(seen).toEqual(["big/model:free", "mid/model:free"]);
    expect(ev.find((e) => e.kind === "run_complete")!.payload.model).toBe("mid/model:free");
    // and it rests: the next turn doesn't lead with it
    await agent.send({ text: "again" });
    expect(seen[2]).not.toBe("big/model:free");
  });

  it("skips a model the provider keeps from Loom, and leaves it out of later turns", async () => {
    process.env.LOOM_HOME = tmpDir("home-pool-closed");
    const { id, seen } = await provider((m) => (m === "big/model:free"
      ? { status: 403, body: '{"error":{"message":"big/model:free is only available on agentic harnesses. Try plugging it into a coding agent"}}' }
      : { status: 200 }));
    const agent = new ModelAdapter("free", tmpDir("p"), { provider: id, model: "pool:free" });
    const ev = listen(agent);
    await agent.send({ text: "go" });
    expect(seen).toEqual(["big/model:free", "mid/model:free"]);
    expect(String(ev.find((e) => e.payload.state === "model_fallback")!.payload.reason)).toMatch(/isn't open to Loom/);
    resetPool(); // even with a fresh rotation, it stays out
    await agent.send({ text: "again" });
    expect(seen.slice(2)).not.toContain("big/model:free");
  });

  it("stops at the daily cap instead of asking every model, says when it resets, and remembers", async () => {
    process.env.LOOM_HOME = tmpDir("home-pool-cap");
    const reset = Date.now() + 3 * 3600_000;
    const { id, seen } = await provider(() => ({ status: 429, body: '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}',
      headers: { "x-ratelimit-reset": String(reset) } }));
    const agent = new ModelAdapter("free", tmpDir("p"), { provider: id, model: "pool:free" });
    const ev = listen(agent);
    await agent.send({ text: "go" });
    expect(seen).toHaveLength(1);
    expect(String(ev.find((e) => e.kind === "error")!.payload.message)).toMatch(/free requests for today are used up.*resets/);
    expect(freeUsage().cappedUntil).toBe(reset);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.LOOM_HOME!, "free-usage.json"), "utf8")).capped).toBe(reset);
    // the next turn doesn't spend a request finding out again
    await expect(agent.send({ text: "again" })).rejects.toThrow(/used up/);
    expect(seen).toHaveLength(1);
  });
});
