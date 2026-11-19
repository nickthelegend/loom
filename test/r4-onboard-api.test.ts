import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, writeDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { readTriggers, writeTriggers } from "../src/core/triggers.js";
import { demoMemory } from "../src/core/help/scenarios.js";
import { readModelRouting } from "../src/core/model-routing-settings.js";
import { tmpDir, makeProjectDir, waitUntil } from "./helpers.js";
import { waitForLesson } from "../src/cli/r4-onboard.js";

let daemon: LoomDaemon, client: DaemonClient, pid: string, dir: string, owner: string, scoped: string;
let provider: Server, providerUrl: string;
let providerAuth = "";
const requestedModels: string[] = [];
const originalHome = process.env.LOOM_HOME;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-api-home"); process.env.LOOM_NO_NOTIFY = "1"; process.env.LOOM_DEMO_DURATION_MS = "80";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, setup: { agents: async () => [] } }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!);
  const cfg = readDaemonConfig()!; cfg.projectsRoot = tmpDir("r4-api-projects"); writeDaemonConfig(cfg);
  dir = makeProjectDir(); pid = (await client.addProject(dir)).project.id;
  owner = await pair({}); scoped = await pair({ projects: [pid] });
  provider = createServer((req, res) => {
    providerAuth = req.headers.authorization ?? "";
    if (providerAuth !== "Bearer test-key") { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); return; }
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end('{"data":[{"id":"tiny"},{"id":"second"}]}'); return; }
    let raw = ""; req.on("data", b => { raw += b; }); req.on("end", () => {
      requestedModels.push(JSON.parse(raw).model);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"fake reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r)); providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
});
afterAll(async () => { await daemon.close(); if (provider) await new Promise<void>(r => provider.close(() => r())); if (originalHome === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = originalHome; delete process.env.LOOM_DEMO_DURATION_MS; });
async function request(route: string, body?: object, token = readDaemonConfig()!.adminToken) {
  return fetch(client.baseUrl + route, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function pair(body: object) { const token = await (await request("/api/pair/new", body)).json(); return (await (await request("/api/pair/claim", { token: token.token, name: "r4-phone" })).json()).clientToken; }
it("serves bundled help, release notes, prompts and readiness to scoped devices within their project", async () => {
  const help = await request("/api/help?q=memory", undefined, scoped); expect(help.status).toBe(200); expect((await help.json()).guides.length).toBeGreaterThan(0);
  expect((await client.onboard.whatsnew()).version).toBe("2.1.0");
  expect((await client.onboard.starters(pid)).prompts).toHaveLength(5);
  const starters = await (await request("/api/init-templates", undefined, owner)).json();
  expect(starters.templates.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["web", "node", "library", "api", "cli", "static", "python"]));
  expect((await request(`/api/projects/${pid}/ready`, undefined, scoped)).status).toBe(200);
  const fixed = await request(`/api/projects/${pid}/ready`, { fix: true }, scoped); expect(fixed.status).toBe(200); expect((await fixed.json()).applied).toHaveLength(2);
  const other = (await client.addProject(makeProjectDir())).project.id;
  expect((await request(`/api/projects/${other}/ready`, undefined, scoped)).status).toBe(403);
  expect((await request(`/api/projects/${pid}/ready`, {}, scoped)).status).toBe(400);
});
it("accepts owner phones for machine-wide installs and rejects scoped trigger installs", async () => {
  for (const token of [readDaemonConfig()!.adminToken, owner]) expect((await request("/api/help/examples/explain-code/install", {}, token)).status).toBe(200);
  expect((await request("/api/help/examples/small-change/install", {}, scoped)).status).toBe(403);
  expect((await request(`/api/projects/${pid}/examples/daily-review/install`, {}, scoped)).status).toBe(403);
  expect((await request(`/api/projects/${pid}/examples/explain-code/install`, {}, owner)).status).toBe(400);
  expect((await request(`/api/projects/${pid}/demo-scenarios/fleet`, {}, scoped)).status).toBe(400);
  expect((await client.onboard.examples()).examples).toHaveLength(4);
});
it("refuses share-live guests on help and project readiness", async () => {
  const made = await (await request("/api/pair/new", { guest: { project: pid, chat: "main", role: "view", name: "guest" } })).json();
  const token = (await (await request("/api/pair/claim", { token: made.token, name: "guest" })).json()).clientToken;
  expect((await request("/api/help", undefined, token)).status).toBe(403);
  expect((await request(`/api/projects/${pid}/ready`, undefined, token)).status).toBe(403);
});
it("runs all four provider steps with real HTTP auth, invalidates changed keys and never returns a secret", async () => {
  expect((await request("/api/help/provider/key", { provider: "r4local", key: "test-key", baseUrl: providerUrl }, scoped)).status).toBe(403);
  const call = (step: string, body: object) => request(`/api/help/provider/${step}`, { provider: "r4local", ...body }, owner);
  expect((await call("default", { model: "tiny" })).status).toBe(400);
  const saved = await call("key", { key: "test-key", baseUrl: providerUrl }); expect(saved.status).toBe(200); expect(await saved.text()).not.toContain("test-key");
  const tested = await call("test", {}); expect(tested.status).toBe(200); expect(await tested.json()).toMatchObject({ step: "default", models: ["second", "tiny"] }); expect(providerAuth).toBe("Bearer test-key");
  expect((await call("default", { model: "unknown" })).status).toBe(400);
  expect((await call("default", { model: "tiny" })).status).toBe(200); expect(readModelRouting().aliases.default).toBe("r4local/tiny");
  const agent = await (await call("agent", { project: pid })).json(); expect(agent.step).toBe("done");
  expect(readProjectConfig(dir)?.agents.find(a => a.id === agent.agent.id)).toMatchObject({ kind: "model", options: { model: "default" } });
  expect(readProjectConfig(dir)?.defaultAgent).toBe(agent.agent.id);
  expect((await (await call("agent", { project: pid })).json()).agent.id).toBe(agent.agent.id);
  expect(agent.model).toBe("r4local/tiny");
  await client.send(pid, "First default", agent.agent.id); await waitUntil(async () => requestedModels.length === 1 && !(await client.project(pid)).project.agents.some(a => a.busy));
  expect(requestedModels.at(-1)).toBe("tiny");
  expect((await call("default", { model: "second" })).status).toBe(200);
  await client.send(pid, "Changed default", agent.agent.id); await waitUntil(async () => requestedModels.length === 2 && !(await client.project(pid)).project.agents.some(a => a.busy));
  expect(requestedModels.at(-1)).toBe("second");
  const again = await (await call("agent", { project: pid })).json();
  expect(again.agent.id).toBe(agent.agent.id); expect(again.model).toBe("r4local/second");
  await call("key", { key: "wrong" }); expect((await call("default", { model: "tiny" })).status).toBe(400); expect((await call("test", {})).status).toBe(400);
});
it("creates a real offline Orchestra run, review findings and a memory reused through another agent's briefing", async () => {
  const { project } = await client.tryProject();
  expect((await request(`/api/projects/${project.id}/demo-scenarios/unknown`, {})).status).toBe(400);
  const fleet = await client.onboard.scenario(project.id, "fleet"); expect(fleet.run).toBeDefined();
  await waitForLesson(client, project.id, { run: fleet.run });
  const run = (await client.orchestraRun(project.id, fleet.run!.id)).run; expect(run.workers.length).toBeGreaterThanOrEqual(2); expect(run.tasks.filter(t => t.startedAt).length).toBeGreaterThanOrEqual(2);
  const review = await client.onboard.scenario(project.id, "review");
  await waitUntil(async () => (await client.review(project.id, review.review!.reviewId)).review.status === "done");
  const reviewed = (await client.review(project.id, review.review!.reviewId)).review;
  expect(reviewed.results).toHaveLength(2); expect(reviewed.findings?.length).toBeGreaterThan(0);
  const memory = await client.onboard.scenario(project.id, "memory");
  await waitForLesson(client, project.id, { chat: memory.chat });
  const events = (await client.events(project.id)).events;
  expect(events.some(e => e.chat === memory.chat && e.kind === "message" && String(e.payload.text).includes("The release codename is copper lantern"))).toBe(true);
  const repeated = await client.onboard.scenario(project.id, "memory");
  await waitForLesson(client, project.id, { chat: repeated.chat });
  expect((await client.events(project.id)).events.filter(e => e.kind === "decision" && e.payload.text === demoMemory)).toHaveLength(1);
  expect(fs.existsSync(path.join(project.dir, ".loom", "demo.json"))).toBe(true);
});
it("tutorial send and steer start Demo turns that actually finish", async () => {
  const { project } = await client.tryProject();
  for (const lesson of ["send", "steer"]) {
    const result = await client.onboard.lesson(project.id, lesson); await waitForLesson(client, project.id, result);
    if (lesson === "steer") expect(JSON.stringify(result.steer)).toContain("steered");
  }
});

it("allows owner trigger examples and enforces the existing 50-trigger limit", async () => {
  const project = (await client.addProject(makeProjectDir())).project;
  for (const token of [owner, readDaemonConfig()!.adminToken]) expect((await request(`/api/projects/${project.id}/examples/daily-review/install`, {}, token)).status).toBe(200);
  const data = readTriggers(project.dir), trigger = data.triggers[0]!;
  data.triggers = Array.from({ length: 50 }, (_, i) => ({ ...trigger, id: `limit-${i}`, name: `limit-${i}` }));
  writeTriggers(project.dir, data);
  const denied = await request(`/api/projects/${project.id}/examples/daily-review/install`, {}, owner);
  expect(denied.status).toBe(400); expect(await denied.json()).toEqual({ error: "50 triggers per project is the limit" });
  expect(readTriggers(project.dir).triggers).toHaveLength(50);
});
