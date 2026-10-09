/**
 * One-shot completions from a configured provider, so Loom's own small jobs
 * (the memory extractor) can run on a local or free model instead of Claude.
 */

import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetPool } from "../src/core/free-pool.js";
import { providerModel, providerText } from "../src/core/provider-text.js";
import { setProvider } from "../src/core/providers.js";
import { tmpDir } from "./helpers.js";

let server: http.Server | null = null;
beforeEach(() => { resetPool(); process.env.LOOM_HOME = tmpDir("home-ptext"); });
afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const FREE = (id: string) => ({ id, context_length: 100_000, pricing: { prompt: "0", completion: "0" } });

async function fake(answer: (model: string) => { status: number; text?: string }) {
  const seen: string[] = [];
  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ data: [FREE("a/one:free"), FREE("b/two:free")] }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; stream: boolean };
      seen.push(body.model);
      const r = answer(body.model);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.status === 200 ? JSON.stringify({ choices: [{ message: { content: r.text ?? "ok" } }] }) : JSON.stringify({ error: { message: "busy" } }));
    });
  });
  const port = await new Promise<number>((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port)));
  setProvider(`fake${port}`, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "Fake" });
  return { id: `fake${port}`, seen };
}

describe("providerText", () => {
  it("only treats a configured provider prefix as a provider (haiku stays Claude's)", async () => {
    const { id } = await fake(() => ({ status: 200 }));
    expect(providerModel("haiku")).toBeNull();
    expect(providerModel("nope/model")).toBeNull();
    expect(providerModel(`${id}/qwen3:4b`)).toEqual({ provider: id, model: "qwen3:4b" });
  });

  it("asks the named model, non-streaming, and returns its text", async () => {
    const { id, seen } = await fake(() => ({ status: 200, text: "ADD: a fact" }));
    expect(await providerText(`${id}/qwen3:4b`, "learn this")).toBe("ADD: a fact");
    expect(seen).toEqual(["qwen3:4b"]);
  });

  it("on pool:free, a busy model hands the job to the next free one", async () => {
    const { id, seen } = await fake((m) => (m === "a/one:free" ? { status: 429 } : { status: 200, text: "done" }));
    expect(await providerText(`${id}/pool:free`, "learn this")).toBe("done");
    expect(seen).toEqual(["a/one:free", "b/two:free"]);
  });
});
