/**
 * One prompt, several models, a thread each.
 *
 * Against a real HTTP server standing in for a provider, so the concurrency is
 * real concurrency. What these hold: every model gets the same prompt, each
 * answer lands in its own thread and nowhere else, the agents that ran are not
 * added to the roster, and one model failing doesn't take the others with it.
 */

import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { setProvider } from "../src/core/providers.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | null = null;
let server: http.Server | null = null;

afterEach(async () => {
  await rt?.close();
  rt = null;
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A provider that answers in each model's own voice, and can refuse one. */
async function provider(opts: { failing?: string; delayMs?: number } = {}) {
  const asked: string[] = [];
  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}") as { model: string; messages: Array<{ content: string }> };
      asked.push(body.model);
      if (body.model === opts.failing) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no available channel" } }));
        return;
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${body.model} says hello.` } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port));
  });
  const id = `fan-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "Fan" });
  return { id, asked };
}

async function project() {
  process.env.LOOM_HOME = tmpDir("home-ask");
  process.env.LOOM_NO_NOTIFY = "1";
  const dir = makeProjectDir({
    name: "asked",
    agents: [{ id: "plannerbot", kind: "echo", role: "planner" }],
  });
  rt = await ProjectRuntime.open({ id: `ask-${Date.now()}`, name: "asked", dir });
  return rt!;
}

const textIn = (r: ProjectRuntime, chat: string) =>
  r.log
    .list({ kinds: ["message"], limit: 200 })
    .filter((e) => e.chat === chat && e.agentId)
    .map((e) => String(e.payload.text))
    .join("");

describe("asking several models at once", () => {
  it("gives each its own thread, with its own answer in it", async () => {
    const r = await project();
    const { id, asked: seen } = await provider();
    const asked = await r.askModels("what is a rebase?", [
      { model: "alpha", provider: id },
      { model: "beta", provider: id },
      { model: "gamma", provider: id },
    ]);

    expect(asked).toHaveLength(3);
    await waitUntil(async () => asked.every((a) => textIn(r, a.chat).length > 0));

    for (const a of asked) {
      expect(textIn(r, a.chat)).toBe(`${a.model} says hello.`);
      // …and nothing from another model leaked into this thread
      for (const other of asked) {
        if (other.model !== a.model) expect(textIn(r, a.chat)).not.toContain(other.model);
      }
    }
    expect(seen.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("names the threads after the models, because that's the point", async () => {
    const r = await project();
    const { id } = await provider();
    await r.askModels("q", [{ model: "vendor/alpha", provider: id }], { title: "rebase" });
    const titles = r.chats().map((c) => c.title);
    expect(titles.some((t) => t.includes("rebase") && t.includes("alpha"))).toBe(true);
  });

  it("asks them at the same time, not one after another", async () => {
    const r = await project();
    const { id } = await provider({ delayMs: 250 });
    const started = Date.now();
    const asked = await r.askModels("q", [
      { model: "alpha", provider: id },
      { model: "beta", provider: id },
      { model: "gamma", provider: id },
    ]);
    await waitUntil(async () => asked.every((a) => textIn(r, a.chat).length > 0));
    // Serial would be 750ms+. Generous bound: this is about concurrency, not
    // about how fast a laptop is.
    expect(Date.now() - started).toBeLessThan(650);
  });

  it("leaves the roster alone — five asks aren't five agents", async () => {
    const r = await project();
    const { id } = await provider();
    await r.askModels("q", [
      { model: "alpha", provider: id },
      { model: "beta", provider: id },
    ]);
    expect(r.config.agents.map((a) => a.id)).toEqual(["plannerbot"]);
  });

  it("one model failing doesn't take the others with it", async () => {
    const r = await project();
    const { id } = await provider({ failing: "beta" });
    const asked = await r.askModels("q", [
      { model: "alpha", provider: id },
      { model: "beta", provider: id },
    ]);
    const good = asked.find((a) => a.model === "alpha")!;
    const bad = asked.find((a) => a.model === "beta")!;

    await waitUntil(async () => textIn(r, good.chat).length > 0);
    expect(textIn(r, good.chat)).toBe("alpha says hello.");
    await waitUntil(
      async () => r.log.list({ kinds: ["error"], limit: 20 }).some((e) => e.chat === bad.chat),
    );
    const err = r.log.list({ kinds: ["error"], limit: 20 }).find((e) => e.chat === bad.chat)!;
    expect(String(err.payload.message)).toMatch(/no channel/);
  });

  it("refuses an ask with nothing to ask, or too much to ask", async () => {
    const r = await project();
    await expect(r.askModels("q", [])).rejects.toThrow(/at least one model/);
    const many = Array.from({ length: 9 }, (_, i) => ({ model: `m${i}` }));
    await expect(r.askModels("q", many)).rejects.toThrow(/at a time is the limit/);
  });
});
