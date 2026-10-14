import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

describe("OpenCode's npm HTTP API", () => {
  it.each([false, true])("handles asynchronous prompts, replies and aborts (providerError=%s)", async (providerError) => {
    let prompt: Record<string, unknown> = {};
    let completed = false;
    let aborted = false;
    const info = () => ({ id: "m1", role: "assistant", time: { created: 1, ...(completed ? { completed: 2 } : {}) }, finish: providerError ? "error" : "stop", ...(providerError ? { error: { name: "APIError", data: { message: "OpenCode 1.18.0 or newer is required to use the free tier" } } } : {}), modelID: "big-pickle", providerID: "opencode", tokens: { input: 12, output: 4, cache: { read: 0 } } });
    const reply = () => ({ info: info(), parts: [{ type: "text", text: "Windows works" }] });
    const server = http.createServer((req, res) => {
      const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
      const p = new URL(req.url!, "http://localhost").pathname;
      if (p === "/api/health") { res.setHeader("content-type", "text/html"); res.end("<!doctype html>spa"); return; }
      if (p === "/global/health") return json({ healthy: true, version: "1.14.33" });
      if (p === "/provider") return json({ connected: ["opencode"], all: [{ id: "opencode", models: { "big-pickle": {} } }] });
      if (p === "/event") { res.statusCode = 503; res.end(); return; }
      if (p === "/session" && req.method === "POST") return json({ id: "s1" });
      if (p === "/session/status") return json({ s1: { type: completed ? "idle" : "busy" } });
      if (p === "/session/s1/message") return json(Object.keys(prompt).length ? [reply()] : []);
      if (p === "/session/s1/message/m1") return json(reply());
      if (p === "/session/s1/prompt_async") {
        let body = "";
        req.on("data", d => body += String(d));
        req.on("end", () => { prompt = JSON.parse(body); completed = true; res.writeHead(204); res.end(); });
        return;
      }
      if (p === "/session/s1/abort") { aborted = true; return json(true); }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const agent = new OpenCodeAdapter("oc", tmpDir("opencode-http"), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: "opencode/big-pickle", pollMs: 5 });
    const events: AdapterEvent[] = [];
    agent.onEvent(e => events.push(e));
    try {
      await agent.send({ text: "Test Windows" });
      expect(prompt).toEqual({ parts: [{ type: "text", text: "Test Windows" }], model: { providerID: "opencode", modelID: "big-pickle" } });
      expect(events.some(e => e.kind === "message" && (e.payload as { text?: string }).text === "Windows works")).toBe(!providerError);
      expect(events.some(e => e.kind === "run_complete")).toBe(true);
      expect(events.filter(e => e.kind === "error").map(e => (e.payload as { message: string }).message)).toEqual(providerError ? ["OpenCode 1.18.0 or newer is required to use the free tier"] : []);
      await agent.interrupt();
      expect(aborted).toBe(true);
    } finally {
      await agent.stop();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
