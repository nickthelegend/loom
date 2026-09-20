/**
 * An agent that is a model endpoint.
 *
 * Against a real HTTP server speaking the real protocol — a fake provider, not
 * a mocked fetch, because the things most likely to be wrong are on the wire:
 * SSE framing that splits a JSON frame across two chunks, a usage block that
 * only arrives at the end, and the four ways a provider says no.
 */

import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { ModelAdapter } from "../src/adapters/model.js";
import { setProvider } from "../src/core/providers.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

interface FakeOpts {
  /** Text the model "says", one SSE frame per element. */
  say?: string[];
  reasoning?: string[];
  status?: number;
  body?: string;
  usage?: Record<string, number>;
  /** Status per model name, so a fallback chain can be exercised. */
  perModel?: Record<string, number>;
  /** Split every frame across two TCP writes — the real-world hazard. */
  fragment?: boolean;
  models?: string[];
  delayMs?: number;
}

/** A provider, as far as the adapter can tell. */
async function fakeProvider(opts: FakeOpts = {}): Promise<{ id: string; seen: Array<Record<string, unknown>> }> {
  const seen: Array<Record<string, unknown>> = [];
  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: (opts.models ?? ["fast", "slow"]).map((id) => ({ id })) }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push({ ...body, headers: req.headers });
      const status = opts.perModel?.[String(body.model)] ?? opts.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(opts.body ?? JSON.stringify({ error: { message: "no" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (frame: unknown) => {
        const line = `data: ${JSON.stringify(frame)}\n\n`;
        if (opts.fragment) {
          const cut = Math.floor(line.length / 2);
          res.write(line.slice(0, cut));
          res.write(line.slice(cut));
        } else {
          res.write(line);
        }
      };
      for (const r of opts.reasoning ?? []) {
        send({ choices: [{ delta: { reasoning_content: r } }] });
      }
      for (const piece of opts.say ?? ["Hello. ", "This is the answer.\n"]) {
        send({ choices: [{ delta: { content: piece } }] });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.usage !== undefined) send({ choices: [{ delta: {} }], usage: opts.usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port));
  });
  const id = `test-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "test-key", label: "Fake" });
  return { id, seen };
}

/** Collect an agent's events for one turn. */
function listen(agent: ModelAdapter): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  agent.onEvent((e) => events.push(e));
  return events;
}

const text = (events: AdapterEvent[]) =>
  events
    .filter((e) => e.kind === "message" && !e.payload.reasoning)
    .map((e) => String(e.payload.text))
    .join("");

describe("a model agent takes a turn", () => {
  it("streams the answer and completes with what it used", async () => {
    process.env.LOOM_HOME = tmpDir("home-model");
    const { id, seen } = await fakeProvider({
      say: ["The answer ", "is forty-two.\n"],
      usage: { prompt_tokens: 30, completion_tokens: 7 },
    });
    const agent = new ModelAdapter("cheap", tmpDir("proj-model"), { provider: id, model: "fast" });
    const events = listen(agent);

    await agent.send({ text: "what is the answer?" });

    expect(text(events)).toBe("The answer is forty-two.\n");
    const done = events.find((e) => e.kind === "run_complete")!;
    expect(done.payload).toMatchObject({ model: "fast", inputTokens: 30, outputTokens: 7 });
    expect(agent.busy()).toBe(false);
    // What went out is the conversation, with the system line first.
    const sent = seen[0]!.messages as Array<{ role: string; content: string }>;
    expect(sent[0]!.role).toBe("system");
    expect(sent[0]!.content).toContain("cheap");
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "what is the answer?" });
  });

  it("survives a frame split across two chunks", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-frag");
    const { id } = await fakeProvider({ say: ["one ", "two ", "three."], fragment: true });
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: id, model: "fast" });
    const events = listen(agent);
    await agent.send({ text: "count" });
    expect(text(events)).toBe("one two three.");
  });

  it("keeps thinking out of the answer", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-think");
    const { id } = await fakeProvider({ reasoning: ["Let me see. "], say: ["Yes."] });
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: id, model: "fast" });
    const events = listen(agent);
    await agent.send({ text: "well?" });
    expect(text(events)).toBe("Yes.");
    const thought = events.find((e) => e.payload.reasoning);
    expect(String(thought!.payload.text)).toBe("Let me see. ");
  });

  it("remembers the conversation, and carries a briefing only for its turn", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-hist");
    const { id, seen } = await fakeProvider({ say: ["ok"] });
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: id, model: "fast" });
    await agent.send({ text: "first", briefing: "[the briefing]" });
    await agent.send({ text: "second" });

    const first = seen[0]!.messages as Array<{ role: string; content: string }>;
    expect(first.at(-1)!.content).toContain("[the briefing]");
    expect(first.at(-1)!.content).toContain("first");

    const second = seen[1]!.messages as Array<{ role: string; content: string }>;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second.at(-1)!.content).toBe("second"); // no briefing this time
    expect(second[2]!.content).toBe("ok"); // and it remembers what it said
  });
});

describe("when the provider says no", () => {
  it("names an exhausted pool as exhausted, not as a bad key", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-402");
    const { id } = await fakeProvider({
      status: 402,
      body: JSON.stringify({ error: { message: "Budget pool quota has been exhausted" } }),
    });
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: id, model: "fast" });
    const events = listen(agent);
    await agent.send({ text: "hi" });
    const err = events.find((e) => e.kind === "error")!;
    expect(String(err.payload.message)).toMatch(/no quota left/);
    // It may mention the key — "another model on the same key may work" is
    // the useful next step — but it must never suggest the key is the problem.
    expect(String(err.payload.message)).not.toMatch(/rejected|invalid|check it/i);
  });

  it("moves to the next model when the pool is dry, and says which", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-fall");
    const { id, seen } = await fakeProvider({ perModel: { fast: 402, slow: 200 }, say: ["from the spare"] });
    const agent = new ModelAdapter("cheap", tmpDir("p"), {
      provider: id,
      model: "fast",
      fallbacks: ["slow"],
    });
    const events = listen(agent);
    await agent.send({ text: "hi" });

    expect(text(events)).toBe("from the spare");
    const moved = events.find((e) => e.payload.state === "model_fallback")!;
    expect(moved.payload).toMatchObject({ from: "fast", to: "slow" });
    expect(events.find((e) => e.kind === "run_complete")!.payload.model).toBe("slow");
    expect(seen.map((s) => s.model)).toEqual(["fast", "slow"]);
  });

  it("does not fall back when the model name is simply wrong", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-503");
    const { id, seen } = await fakeProvider({ perModel: { ghost: 503, slow: 200 } });
    const agent = new ModelAdapter("cheap", tmpDir("p"), {
      provider: id,
      model: "ghost",
      fallbacks: ["slow"],
    });
    const events = listen(agent);
    await agent.send({ text: "hi" });
    // Trying another model would hide the typo rather than fix it.
    expect(seen).toHaveLength(1);
    expect(String(events.find((e) => e.kind === "error")!.payload.message)).toMatch(/no channel/);
  });

  it("refuses to start without a key, in words that say what to do", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-nokey");
    setProvider("keyless", { baseUrl: "http://127.0.0.1:1", label: "Keyless" });
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: "keyless", model: "fast" });
    await expect(agent.send({ text: "hi" })).rejects.toThrow(/no key/);
  });

  it("refuses a provider nobody has configured", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-noprov");
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: "nowhere", model: "fast" });
    await expect(agent.send({ text: "hi" })).rejects.toThrow(/isn't configured/);
  });
});

describe("stopping it", () => {
  it("keeps what was already said, and doesn't report an error", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-stop");
    const { id } = await fakeProvider({
      say: ["one. ", "two. ", "three. ", "four. ", "five. "],
      delayMs: 120,
    });
    const agent = new ModelAdapter("cheap", tmpDir("p"), { provider: id, model: "fast" });
    const events = listen(agent);
    const turn = agent.send({ text: "count slowly" });
    await new Promise((r) => setTimeout(r, 200));
    expect(agent.busy()).toBe(true);
    await agent.interrupt();
    await turn;

    expect(events.some((e) => e.payload.state === "interrupted")).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.some((e) => e.kind === "run_complete")).toBe(false);
    expect(agent.busy()).toBe(false);
  });
});

describe("is it usable", () => {
  it("asks the provider what it has, rather than what's on PATH", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-avail");
    const { id } = await fakeProvider({ models: ["fast", "slow"] });
    expect(await new ModelAdapter("a", tmpDir("p"), { provider: id, model: "fast" }).available()).toBe(true);
    expect(await new ModelAdapter("a", tmpDir("p"), { provider: id, model: "ghost" }).available()).toBe(false);
  });
});

describe("adding one from the terminal", () => {
  it("carries the model into the agent's config, and refuses one without", async () => {
    process.env.LOOM_HOME = tmpDir("home-model-add");
    process.env.LOOM_NO_NOTIFY = "1";
    const { ProjectRuntime } = await import("../src/daemon/runtime.js");
    const { makeProjectDir } = await import("./helpers.js");
    const dir = makeProjectDir({ name: "adding", agents: [{ id: "plannerbot", kind: "echo", role: "planner" }] });
    const rt = await ProjectRuntime.open({ id: `add-${Date.now()}`, name: "adding", dir });
    try {
      const cfg = rt.addAgent("model", {
        id: "cheap",
        role: "reviewer",
        options: { provider: "openrouter", model: "a/b:free", tools: true },
      });
      // An agent whose options didn't survive being added is an agent that
      // refuses every turn for a reason nobody can see.
      expect(cfg.options).toEqual({ provider: "openrouter", model: "a/b:free", tools: true });
      expect(rt.config.agents.find((a) => a.id === "cheap")!.options).toMatchObject({ model: "a/b:free" });
    } finally {
      await rt.close();
    }
  });
});
