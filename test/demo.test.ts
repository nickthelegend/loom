import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DemoAdapter, DEMO_LABEL } from "../src/adapters/demo.js";
import { ADES, defaultAgentConfigs } from "../src/core/ades.js";
import { probeAuth } from "../src/core/setup.js";
import { projectGit } from "../src/core/project-creation.js";
import { ensureDaemonConfig, readDaemonConfig, readProjectConfig, writeDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon, listModelsForKind } from "../src/daemon/server.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import type { AdapterEvent, StreamDelta } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon: LoomDaemon, client: DaemonClient, projectsRoot: string, base: string, token: string;
const fresh = () => client.tryProject({ dir: path.join(tmpDir("demo-parent"), "demo") });
const runtime = (id: string) => (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
const call = (route: string, body: unknown, auth = token) => fetch(base + route, {
  method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-demo");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_DEMO_DURATION_MS = "20";
  projectsRoot = tmpDir("demo-projects");
  writeDaemonConfig({ ...ensureDaemonConfig({ host: "127.0.0.1", port: 0 }), projectsRoot });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  client = new DaemonClient(cfg);
  base = client.baseUrl;
  token = cfg.adminToken;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await daemon?.close(); });

async function settled(project: string, id: string) {
  await waitUntil(async () => ["completed", "failed", "aborted", "waiting_human"].includes((await client.orchestraRun(project, id)).run.status));
  const { run } = await client.orchestraRun(project, id);
  expect(run.status, JSON.stringify(run)).toBe("completed");
  return run;
}

it("offers Demo and its models without silently adding it to real projects", async () => {
  const spec = ADES.find(a => a.kind === "demo")!;
  expect(spec.label).toBe(DEMO_LABEL);
  expect(spec.tier === "adapter" && await spec.probe()).toBe(true);
  expect(await probeAuth("demo")).toMatchObject({ authed: true });
  expect(defaultAgentConfigs({ demo: true })).toEqual([]);
  expect(await listModelsForKind("demo")).toEqual({ models: ["demo-smart", "demo-fast"], source: "builtin" });
});

it("creates a committed bundled project, seeds memory once, and reuses it concurrently", async () => {
  const [a, b] = await Promise.all([client.tryProject(), client.tryProject()]);
  expect(a).toEqual(b);
  expect(a.project.dir).toBe(path.join(projectsRoot, "loom-demo"));
  expect(a.project.agents.map(a => [a.id, a.kind, a.options?.model])).toEqual([
    ["demo-1", "demo", "demo-smart"], ["demo-2", "demo", "demo-fast"], ["demo-3", "demo", "demo-smart"],
  ]);
  expect(await projectGit(["rev-list", "--count", "HEAD"], a.project.dir)).toBe("1");
  expect(await projectGit(["status", "--porcelain"], a.project.dir)).toBe("");
  expect((await exec(process.execPath, ["test.mjs"], { cwd: a.project.dir })).stdout).toContain("PASS");
  fs.appendFileSync(path.join(a.project.dir, "TODO.md"), "\nKeep this edit.\n");
  expect(await client.tryProject({ agents: 1 })).toEqual(a);
  expect(fs.readFileSync(path.join(a.project.dir, "TODO.md"), "utf8")).toContain("Keep this edit.");
  const rt = await runtime(a.project.id);
  expect(rt.log.list({ kinds: ["decision"] }).filter(e => e.payload.source === "demo")).toHaveLength(1);
  expect(rt.brain.list().some(m => m.text.includes("dependency-free"))).toBe(true);
});

it("streams a real daemon turn, records zero cost and tokens, and rewinds the real edit", async () => {
  const { project } = await fresh();
  const before = fs.readFileSync(path.join(project.dir, "styles.css"), "utf8");
  const rt = await runtime(project.id);
  const streamed: StreamDelta[] = [];
  const off = rt.agent("demo-1")!.onStream(d => streamed.push(d));
  await client.send(project.id, "add dark mode", "demo-1");
  await waitUntil(() => rt.log.list({ kinds: ["turn_diff"] }).length === 1);
  off();
  const complete = rt.log.list({ kinds: ["run_complete"] })[0]!;
  expect(complete.payload).toMatchObject({ costUsd: 0, model: "demo-smart", simulated: true });
  expect(complete.payload.inputTokens).toBeGreaterThan(0);
  expect(complete.payload.outputTokens).toBeGreaterThan(0);
  const { costs } = await client.costs(project.id);
  expect(costs.totalUsd).toBe(0);
  expect(costs.tokensIn).toBeGreaterThan(0);
  expect(costs.tokensOut).toBeGreaterThan(0);
  expect(costs.byAgent[0]!.estUsd).toBeUndefined();
  expect(rt.log.list({ kinds: ["tool_call"] }).map(e => e.payload.tool)).toEqual(["read", "edit", "shell"]);
  expect(rt.log.list({ kinds: ["tool_call"] }).at(-1)!.payload).toMatchObject({ simulated: true, exitCode: 0 });
  expect(rt.log.list({ kinds: ["turn_diff"] })[0]!.payload.patch).toContain("prefers-color-scheme: dark");
  expect(streamed.some(d => d.reasoning)).toBe(true);
  expect(streamed.some(d => !d.reasoning)).toBe(true);
  expect(fs.readFileSync(path.join(project.dir, "styles.css"), "utf8")).not.toBe(before);
  const { checkpoints } = await client.checkpoints(project.id);
  expect(checkpoints.length).toBeGreaterThan(0);
  await client.rewind(project.id, checkpoints[0]!.id);
  expect(fs.readFileSync(path.join(project.dir, "styles.css"), "utf8")).toBe(before);
});

it("accepts steering in the same daemon turn and interrupts before any edit", async () => {
  vi.stubEnv("LOOM_DEMO_DURATION_MS", "600");
  const { project } = await fresh();
  const rt = await runtime(project.id);
  const agent = rt.agent("demo-1")!;
  await client.send(project.id, "add dark mode", "demo-1");
  await waitUntil(() => "busy" in agent && agent.busy());
  expect(await client.steer(project.id, "keep it accessible")).toEqual({ steered: true });
  await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length === 1);
  expect(rt.log.list({ kinds: ["message"] }).some(e => String(e.payload.text).includes("Steering received: keep it accessible"))).toBe(true);
  await waitUntil(() => rt.log.list({ kinds: ["turn_diff"] }).length === 1);
  await client.send(project.id, "add a todo filter", "demo-1");
  await waitUntil(() => "busy" in agent && agent.busy());
  await client.interrupt(project.id);
  expect(rt.log.list({ kinds: ["status"] }).some(e => e.payload.state === "interrupted")).toBe(true);
  expect(rt.log.list({ kinds: ["run_complete"] })).toHaveLength(1);
  expect(fs.readFileSync(path.join(project.dir, "filter.js"), "utf8")).not.toContain("todos.filter");
});

it("runs a demo planner and two workers, writes plan files and produces a merged diff", async () => {
  const { project } = await fresh();
  const { run } = await client.startOrchestra(project.id, { goal: "add dark mode and write tests", orchestrator: "demo-1", workers: ["demo-2", "demo-3"], plan: true });
  const done = await settled(project.id, run.id);
  expect(done.tasks.map(t => t.status)).toEqual(["done", "done"]);
  expect(new Set(done.tasks.map(t => t.agent)).size).toBe(2);
  expect(done.costUsd).toBe(0);
  for (const task of done.tasks) expect((await client.orchestraTaskDiff(project.id, run.id, task.id)).patch).toContain("diff --git");
  const patch = await projectGit(["diff", "HEAD", done.branch], project.dir);
  expect(patch).toContain("prefers-color-scheme: dark");
  expect(patch).toContain("PASS: explicit all filter");
  expect(patch).toContain("loom-plan: 1");
});

it.each(["race", "compare"])("runs demo %s entrants with multiple models and real diffs", async mode => {
  const { project } = await fresh();
  const entrants = ["demo@demo-smart x2", "demo@demo-fast x2"];
  const { run } = mode === "compare"
    ? await client.compare(project.id, { prompt: "add a todo filter", entrants })
    : await client.startOrchestra(project.id, { goal: "add a todo filter", workers: entrants, race: true });
  const done = await settled(project.id, run.id);
  expect(done.tasks).toHaveLength(4);
  expect(done.tasks.map(t => t.model)).toEqual(["demo-smart", "demo-smart", "demo-fast", "demo-fast"]);
  for (const task of done.tasks) {
    expect(task.status).toBe("done");
    expect(task.costUsd).toBe(0);
    expect((await client.orchestraTaskDiff(project.id, run.id, task.id)).patch).toContain("todos.filter");
    expect((await exec(process.execPath, ["test.mjs"], { cwd: task.dir })).stdout).toContain("PASS");
  }
});

it("rejects invalid input and unrelated folders without changing them", async () => {
  for (const body of [{ agents: 0 }, { agents: 9 }, { agents: 1.5 }, { agents: "3" }, { dir: "relative" }, { dir: 7 }, []]) {
    expect((await call("/api/try", body)).status).toBe(400);
  }
  const dir = tmpDir("occupied-demo");
  fs.writeFileSync(path.join(dir, "keep"), "safe");
  expect((await call("/api/try", { dir })).status).toBe(409);
  expect(fs.readdirSync(dir)).toEqual(["keep"]);
});

it("allows unscoped own devices and refuses scoped devices, guests and unauthenticated callers", async () => {
  const { project } = await fresh();
  async function pair(body: unknown) {
    const minted = await call("/api/pair/new", body);
    const { token } = await minted.json() as { token: string };
    const claimed = await call("/api/pair/claim", { token, name: "Demo phone" });
    return (await claimed.json() as { clientToken: string }).clientToken;
  }
  const phone = await pair({});
  expect((await call("/api/try", { dir: project.dir }, phone)).status).toBe(200);
  const scoped = await pair({ projects: [project.id] });
  const guest = await pair({ guest: { project: project.id, chat: "main", role: "approve", name: "Guest" } });
  for (const auth of [scoped, guest]) expect((await call("/api/try", {}, auth)).status).toBe(403);
  expect((await call("/api/try", {}, "invalid")).status).toBe(401);
});

it("runs loom try --no-open from outside a project using a temporary LOOM_HOME", async () => {
  const dir = path.join(tmpDir("cli-demo"), "demo with spaces");
  const { stdout } = await exec(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), "try", "--no-open", "--dir", dir, "--agents", "2"], {
    cwd: tmpDir("outside-demo"), env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  expect(stdout).toContain("/app?tour=1#p/");
  expect(stdout).toContain("demo-1@demo-smart, demo-2@demo-fast");
  expect(stdout).toContain('loom send "add dark mode"');
  expect(readProjectConfig(dir)!.agents).toHaveLength(2);
});

describe("scripted intents", () => {
  it("makes a generic safe edit, explains without edits, and saves a plan in the existing format", async () => {
    const { project } = await fresh();
    const adapter = new DemoAdapter("demo", project.dir, { model: "demo-fast" });
    const events: AdapterEvent[] = [];
    adapter.onEvent(e => events.push(e));
    await adapter.send({ text: "build a spaceship" });
    expect(fs.readFileSync(path.join(project.dir, "DEMO-NOTES.md"), "utf8")).toContain("Connect a real agent");
    expect(events.find(e => e.kind === "message")!.payload.text).toContain("I'm Loom's demo agent");
    const before = await projectGit(["diff"], project.dir);
    await adapter.send({ text: "explain this repo" });
    expect(await projectGit(["diff"], project.dir)).toBe(before);
    await adapter.send({ text: "make a plan for this app" });
    const plan = fs.readFileSync(path.join(project.dir, ".loom/plans/demo.md"), "utf8");
    for (const section of ["status: proposed", "## Goal", "## Context", "## Tasks", "## Risks", "## Verification"]) expect(plan).toContain(section);
    await adapter.send({ text: "write tests" });
    expect((await exec(process.execPath, ["test.mjs"], { cwd: project.dir })).stdout).toContain("PASS: explicit all filter");
  });

  it("does not follow a script target symlink outside the project", async () => {
    const { project } = await fresh();
    const outside = path.join(tmpDir("demo-outside"), "keep.css");
    fs.writeFileSync(outside, "untouched");
    fs.unlinkSync(path.join(project.dir, "styles.css"));
    fs.symlinkSync(outside, path.join(project.dir, "styles.css"));
    const adapter = new DemoAdapter("demo", project.dir);
    const events: AdapterEvent[] = [];
    adapter.onEvent(e => events.push(e));
    await adapter.send({ text: "add dark mode" });
    expect(events.some(e => e.kind === "error")).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
  });
});
