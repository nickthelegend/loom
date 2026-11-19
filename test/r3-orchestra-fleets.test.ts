import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import type { OrchestraRun, OrchestraStartOptions } from "../src/core/orchestra.js";
import { orchestraGraph, runRecipeOptions } from "../src/core/orchestra-options.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, project: string, dir: string, admin: string;
const root = process.cwd();
const api = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = admin) => {
  const res = await fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
const base = () => `/api/projects/${project}`;
const runPath = (run: OrchestraRun) => `${base()}/orchestra/${run.id}`;
const get = async (run: OrchestraRun) => (await client.orchestraRun(project, run.id)).run;
const post = (run: OrchestraRun, action: string, body: unknown = {}) => api(`${runPath(run)}/${action}`, body);

async function start(options: Partial<OrchestraStartOptions> = {}): Promise<OrchestraRun> {
  return (await client.startOrchestra(project, { goal: "sleep:1000", orchestrator: "lead", workers: ["workerx3"], race: true, ...options })).run;
}
async function preview(prompt = "sleep:500", options: Partial<OrchestraStartOptions> = {}): Promise<OrchestraRun> {
  const run = await start({ goal: "Plan the work", race: false, planOnly: true, ...options });
  await waitUntil(async () => (await get(run)).status === "waiting_human");
  const actions = [{ type: "spawn", id: "first", title: "First task", agent: "worker", prompt },
    { type: "spawn", id: "second", title: "Second task", agent: "worker", prompt: "finished", dependsOn: ["first"] }];
  const text = "```loom\n" + JSON.stringify({ actions }).replaceAll("sleep:", "\\u0073leep:") + "\n```";
  expect((await post(run, "reply", { text })).status).toBe(200);
  await waitUntil(async () => (await get(run)).tasks.length === 2);
  return get(run);
}
const cli = (args: string[]) => new Promise<{ code: number; out: string }>(resolve => {
  execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args],
    { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: stdout + stderr }));
});

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  admin = readDaemonConfig()!.adminToken;
  dir = makeProjectDir({ agents: [{ id: "lead", kind: "echo", role: "planner" }, { id: "worker", kind: "echo", role: "worker" }] });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "seed");
  project = (await client.addProject(dir)).project.id;
}, 30_000);
afterEach(async () => {
  for (const run of (await client.orchestraRuns(project)).runs) {
    if (!["completed", "aborted", "failed", "moved"].includes(run.status)) await post(run, "abort");
  }
});
afterAll(async () => { await daemon.close(); });

describe("Orchestra 2.1 batch", () => {
  it("previews task prompts and dependencies without starting any worker, then approves exactly once", async () => {
    const run = await preview("sleep:800", { plan: true });
    expect(run.status).toBe("waiting_human");
    expect(run.tasks.map(t => [t.status, t.attempts, t.dir])).toEqual([["pending", 0, undefined], ["pending", 0, undefined]]);
    expect((await post(run, "reply", { text: "go" })).status).toBe(400);
    const approved = await post(run, "approve-plan");
    expect(approved.status).toBe(200);
    expect(approved.body.run.planApprovedAt).toBeTypeOf("number");
    expect((await post(run, "approve-plan")).status).toBe(400);
    await waitUntil(async () => (await get(run)).tasks[0]!.status === "running");
    expect(fs.existsSync(path.join(run.dir, "plans", run.id, "PLAN.md"))).toBe(true);
    expect((await get(run)).tasks[1]!.attempts).toBe(0);
  });

  it("limits same-kind instances while recording complete start, report and end history", async () => {
    const run = await start({ kindLimits: { echo: 1 }, maxParallel: 3 });
    await waitUntil(async () => (await get(run)).tasks.some(t => t.status === "running"));
    const first = (await get(run)).tasks.find(t => t.status === "running")!;
    expect((await get(run)).tasks.filter(t => t.status === "running")).toHaveLength(1);
    expect((await post(run, `tasks/${first.id}/report`, { kind: "checkpoint", text: "progress" })).status).toBe(200);
    await waitUntil(async () => (await get(run)).status === "completed");
    const events = (await api(`${runPath(run)}/timeline`)).body.events;
    expect(events.filter((e: { phase: string }) => e.phase === "task_started")).toHaveLength(3);
    expect(events.filter((e: { phase: string }) => e.phase === "task_finished")).toHaveLength(3);
    expect(events.some((e: { text: string }) => e.text === "progress")).toBe(true);
    let running = 0;
    for (const e of events) {
      if (e.phase === "task_started") running++;
      if (e.phase === "task_finished") running--;
      expect(running).toBeLessThanOrEqual(1);
    }
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, ".loom/orchestra", `${run.id}.json`), "utf8"));
    expect(persisted.timeline).toEqual(events);
  });

  it("pauses at the existing budget cap and resumes pending workers after an explicit budget increase", async () => {
    const run = await start({ goal: "finished", kindLimits: { echo: 1 }, maxUsd: 0.001 });
    await waitUntil(async () => (await get(run)).status === "waiting_human");
    const paused = await get(run);
    expect(paused.costUsd).toBe(0.001);
    expect(paused.tasks.filter(t => t.attempts === 0)).toHaveLength(2);
    expect(paused.question).toContain("budget");
    expect((await post(run, "budget", { maxUsd: 0.01 })).status).toBe(200);
    await waitUntil(async () => (await get(run)).status === "completed");
    expect((await get(run)).costUsd).toBe(0.003);
  });

  it("detects idle workers, clears stalls on reports and safely reassigns just one task", async () => {
    // the task must outlive two stall windows and a report even on a slow runner; the run is aborted at the end
    const run = await start({ goal: "sleep:10000", workers: ["worker", "lead"], stallMinutes: 0.005 });
    await waitUntil(async () => (await get(run)).tasks.every(t => Boolean(t.stalledAt)));
    const task = (await get(run)).tasks[0]!;
    const originalDir = task.dir;
    await post(run, `tasks/${task.id}/report`, { kind: "checkpoint", text: "still working" });
    expect((await get(run)).tasks[0]!.stalledAt).toBeUndefined();
    await waitUntil(async () => Boolean((await get(run)).tasks[0]!.stalledAt));
    const result = await post(run, `tasks/${task.id}/retry`, { agent: "lead@new-model:high" });
    expect(result.status).toBe(200);
    await waitUntil(async () => (await get(run)).tasks[0]!.attempts === 2);
    const current = await get(run);
    expect(current.tasks[0]).toMatchObject({ agent: "lead@new-model:high", model: "new-model", effort: "high", dir: originalDir });
    expect(current.tasks[1]!.attempts).toBe(1);
    expect(current.timeline!.some(e => e.phase === "task_reassigned")).toBe(true);
    await post(run, "abort");
    expect((await get(run)).tasks.every(t => !t.stalledAt)).toBe(true);
  });

  it("retries a failed task while preserving successful siblings and rejecting merged tasks", async () => {
    const run = await start({ goal: "fail:requested", workers: ["worker", "lead"] });
    await waitUntil(async () => (await get(run)).status === "completed");
    const task = (await get(run)).tasks[0]!;
    expect(task.status).toBe("failed");
    expect((await post(run, `tasks/${task.id}/retry`, { agent: "lead@replacement" })).status).toBe(200);
    await waitUntil(async () => (await get(run)).tasks[0]!.attempts === 2 && (await get(run)).status === "completed");
    expect((await get(run)).tasks[1]!.attempts).toBe(1);
    const completed = await start({ goal: "finished" });
    await waitUntil(async () => (await get(completed)).status === "completed");
    expect((await post(completed, `tasks/${(await get(completed)).tasks[0]!.id}/retry`, { agent: "lead" })).status).toBe(400);
  });

  it("keeps streamed workers active rather than marking them stalled", async () => {
    // 1.8s without progress counts as stalled; output arrives every 30ms (a slow Windows runner can pause well over 0.3s)
    const run = await start({ goal: "stream:30 " + "working ".repeat(100), stallMinutes: 0.03 });
    await waitUntil(async () => (await get(run)).status === "completed");
    expect((await get(run)).timeline!.some(e => e.phase === "task_stalled")).toBe(false);
  });

  it("exports safe Mermaid with dependency edges through API and CLI", async () => {
    const run = await preview();
    const graph = (await api(`${runPath(run)}/graph`)).body.mermaid;
    expect(graph).toContain("flowchart TD");
    expect(graph).toContain("t0 --> t1");
    expect((await cli(["orchestra:graph", run.id])).out).toContain(graph.trim());
    const hostile = structuredClone(run);
    hostile.tasks[0]!.title = '\"] --> evil["<script>';
    expect(orchestraGraph(hostile)).not.toContain("<script>");
    expect(orchestraGraph(hostile)).not.toContain('evil["');
  });

  it("saves resolved fleet and options as a recipe and runs it via CLI", async () => {
    const run = await start({ goal: "finished", workers: ["worker@echo-model:lowx2"], maxUsd: 5, maxParallel: 2,
      kindLimits: { echo: 1 }, stallMinutes: 3 });
    await waitUntil(async () => (await get(run)).status === "completed");
    const result = await post(run, "recipe", { name: "Daily fleet" });
    expect(result.status).toBe(200);
    expect(result.body.recipe.options).toMatchObject({ maxUsd: 5, kindLimits: { echo: 1 }, stallMinutes: 3, workers: ["worker@echo-model:low", "worker@echo-model:low"] });
    expect(runRecipeOptions(await get(run)).workers).toHaveLength(2);
    const launched = await cli(["recipes", "run", "Daily fleet"]);
    expect(launched.code, launched.out).toBe(0);
    expect(launched.out).toContain("echo-model");
    expect((await api("/api/orchestra-recipes")).body.recipes.some((r: { name: string }) => r.name === "Daily fleet")).toBe(true);
  });

  it("signs exactly one completion webhook with the project's private secret", async () => {
    const requests: { body: string; signature: string | undefined }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", b => { body += b; });
      req.on("end", () => { requests.push({ body, signature: req.headers["x-loom-signature-256"] as string }); res.end("ok"); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const run = await start({ goal: "finished", webhookUrl: `http://127.0.0.1:${port}/complete` });
      await waitUntil(() => requests.length === 1);
      const secret = (await api(`${base()}/orchestra-webhook-secret`)).body.secret;
      expect(requests[0]!.signature).toBe("sha256=" + createHmac("sha256", secret).update(requests[0]!.body).digest("hex"));
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ runId: run.id, status: "completed", event: "orchestra.completed" });
      expect(JSON.stringify(await get(run))).not.toContain(secret);
      expect((await get(run)).webhookDelivery?.error).toBeUndefined();
      await post(run, "abort");
      expect(requests).toHaveLength(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("records webhook failure without failing a completed run", async () => {
    const server = createServer((_req, res) => { res.writeHead(503); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const run = await start({ goal: "finished", webhookUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/` });
      await waitUntil(async () => (await get(run)).webhookDelivery?.state === "failed");
      expect((await get(run)).status).toBe("completed");
      expect((await get(run)).webhookDelivery?.error).toContain("503");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("refuses Share-live guests and accepts an owner phone for approval", async () => {
    const run = await preview();
    const invitation = await api("/api/pair/new", { guest: { project, chat: run.chat, role: "approve", name: "Guest" } });
    const pair = new URLSearchParams(invitation.body.link.split("#")[1]).get("pair");
    const guest = (await api("/api/pair/claim", { token: pair, name: "guest" })).body.clientToken;
    for (const route of ["approve-plan", "budget", "recipe", "tasks/first/retry"]) {
      expect((await api(`${runPath(run)}/${route}`, {}, "POST", guest)).status).toBe(403);
    }
    expect((await api(`${runPath(run)}/graph`, undefined, "GET", guest)).status).toBe(403);
    const ownerPair = await api("/api/pair/new", { owner: true });
    const owner = (await api("/api/pair/claim", { token: ownerPair.body.token, name: "owner phone" })).body.clientToken;
    expect((await api(`${runPath(run)}/approve-plan`, {}, "POST", owner)).status).toBe(200);
  });

  it("keeps unapproved plans waiting through a daemon restart", async () => {
    const run = await preview();
    await daemon.close();
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    client = new DaemonClient(readDaemonConfig()!);
    admin = readDaemonConfig()!.adminToken;
    const restored = await get(run);
    expect(restored.status).toBe("waiting_human");
    expect(restored.tasks.every(t => t.attempts === 0 && t.status === "pending")).toBe(true);
    expect((await post(restored, "approve-plan")).status).toBe(200);
    await waitUntil(async () => (await get(run)).tasks[0]!.attempts === 1);
  });

  it("validates options and refuses scoped callers for new mutations and machine recipes", async () => {
    for (const bad of [{ maxUsd: -1 }, { stallMinutes: 0 }, { kindLimits: { echo: 0 } }, { kindLimits: [] }, { webhookUrl: "file:///tmp/no" }, { planOnly: true, race: true }]) {
      expect((await api(`${base()}/orchestra`, { goal: "test", ...bad })).status).toBe(400);
    }
    const run = await preview();
    const pairing = await api("/api/pair/new", { owner: false, host: "127.0.0.1", projects: [project] });
    const claim = await api("/api/pair/claim", { token: pairing.body.token, name: "scoped" });
    const token = claim.body.clientToken;
    for (const [route, body] of [[`${runPath(run)}/approve-plan`, {}], [`${runPath(run)}/budget`, { maxUsd: 10 }],
      [`${runPath(run)}/recipe`, { name: "Denied" }], [`${runPath(run)}/tasks/first/retry`, { agent: "lead" }],
      [`${base()}/orchestra`, { goal: "no", webhookUrl: "https://example.com/hook" }], [`${base()}/orchestra-recipes/Daily%20fleet/run`, {}]] as const) {
      expect((await api(route, body, "POST", token)).status).toBe(403);
    }
    expect((await api("/api/orchestra-recipes", undefined, "GET", token)).status).toBe(403);
    expect((await api(`${base()}/orchestra-webhook-secret`, undefined, "GET", token)).status).toBe(403);
  });
});
