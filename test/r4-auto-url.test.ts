import http from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readWatchUrl } from "../src/core/auto-r4/watch.js";
import { AutomationEngine } from "../src/core/auto-r4/engine.js";
import { automationTrigger } from "../src/core/auto-r4/validation.js";
import { readAutomation } from "../src/core/auto-r4/state.js";
import { writeTriggers } from "../src/core/triggers.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { TriggerRunner } from "../src/daemon/triggers.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

// Only the network boundary is redirected. Validation, streams, selection and
// change detection execute normally against a real HTTP server.
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: async () => [{ address: "203.0.113.10", family: 4 }] }));
let server: http.Server, port: number, value = 1;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/large") { res.end("x".repeat(1_000_001)); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1/private" }); res.end(); return; }
    if (req.url === "/slow") return;
    if (req.url === "/html") { res.setHeader("content-type", "text/html"); res.end("<h1>Public page</h1>"); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: { value }, ignored: Date.now() }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); port = (server.address() as { port: number }).port;
  const get = http.get;
  vi.spyOn(http, "get").mockImplementation(((url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => get(new URL(url.pathname, `http://127.0.0.1:${port}`), { ...options, lookup: undefined }, callback)) as typeof http.get);
});
afterAll(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

it("accepts HTML and selected JSON while enforcing size, redirects and time limits", async () => {
  expect(await readWatchUrl("http://watch.example/html")).toContain("Public page");
  expect(await readWatchUrl("http://watch.example/json", "result.value")).toBe("1");
  await expect(readWatchUrl("http://watch.example/json", "missing.path")).rejects.toThrow(/not found/);
  await expect(readWatchUrl("http://watch.example/large")).rejects.toThrow(/1 MB/);
  await expect(readWatchUrl("http://watch.example/redirect")).rejects.toThrow(/public/);
  const before = Date.now(); await expect(readWatchUrl("http://watch.example/slow")).rejects.toThrow(); expect(Date.now() - before).toBeLessThan(12_000);
}, 15_000);

it("baselines a URL, persists it across engine restarts and queues only selected value changes", async () => {
  process.env.LOOM_HOME = tmpDir("a4-url"); process.env.LOOM_NO_NOTIFY = "1";
  const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const internals = daemon as unknown as { triggers: TriggerRunner; runtime(id: string): Promise<ProjectRuntime> }; internals.triggers.stop();
  try {
    const dir = makeProjectDir(), client = new DaemonClient(readDaemonConfig()!), pid = (await client.addProject(dir)).project.id, rt = await internals.runtime(pid);
    rt.queue.setPaused(true);
    const trigger = automationTrigger({ watchUrl: "http://watch.example/json", select: "result.value", every: "1m", prompt: "{{old}} -> {{new}}" });
    writeTriggers(dir, { triggers: [trigger], runs: [] });
    const runner = new TriggerRunner(id => internals.runtime(id));
    const engine = () => new AutomationEngine((...args) => runner.fire(...args));
    const now = Date.now(); await engine().tick(rt, now); expect(rt.queue.length).toBe(0);
    await waitUntil(() => readAutomation(dir).watches[trigger.id]?.value === "1");
    const second = engine(); await second.tick(rt, now + 60_000);
    await waitUntil(() => (second as any).urlChecks.size === 0); expect(rt.queue.length).toBe(0);
    value = 2; await engine().tick(rt, now + 120_000);
    await waitUntil(() => rt.queue.snapshot().items[0]?.text.includes("1 -> 2") ?? false);
  } finally { await daemon.close(); }
});
