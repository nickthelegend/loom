import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterBase } from "../src/adapters/base.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { registerAgentKind } from "../src/adapters/index.js";
import { parseAgentSpec, parseOrchestraActions, type OrchestraRun } from "../src/core/orchestra.js";
import { readDaemonConfig, readProjectConfig, writeProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { AgentConfig, SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let script: unknown[][] = [];
const briefings: string[] = [];
const configs: AgentConfig[] = [];
let active = 0, peak = 0;

class Conductor extends AdapterBase {
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send(input: SendInput) {
    if (input.briefing) briefings.push(input.briefing);
    this.emit({ kind: "message", payload: { text: "```loom\n" + JSON.stringify({ actions: script.shift() ?? [{ type: "done", summary: "finished" }] }) + "\n```" } });
  }
}

/** Echo's real turns, with the configuration written into each task's worktree. */
class SelectedEcho extends EchoAdapter {
  constructor(private cfg: AgentConfig, dir: string) { super(cfg.id, cfg.kind, dir); }
  async send(input: SendInput) {
    active++;
    peak = Math.max(peak, active);
    const name = /write:([\w.-]+)/.exec(input.text)?.[1];
    if (name) fs.writeFileSync(path.join(this.projectDir, `${name}.selection.json`), JSON.stringify(this.cfg.options));
    try { await super.send(input); } finally { active--; }
  }
}
registerAgentKind("fleet-conductor", (cfg, dir) => {
  configs.push(structuredClone(cfg));
  return new Conductor(cfg.id, cfg.kind, dir);
});
registerAgentKind("fleet-echo", (cfg, dir) => {
  configs.push(structuredClone(cfg));
  return new SelectedEcho(cfg, dir);
});

let daemon: LoomDaemon, client: DaemonClient, dir: string, project: string;
async function listen() {
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
async function settled(id: string): Promise<OrchestraRun> {
  let run: OrchestraRun;
  await waitUntil(async () => {
    run = (await client.orchestraRun(project, id)).run;
    return ["completed", "failed", "waiting_human"].includes(run.status);
  }, { timeoutMs: 30_000 });
  expect(run!.status, JSON.stringify(run!)).toBe("completed");
  return run!;
}

beforeEach(async () => {
  process.env.LOOM_HOME = tmpDir("home-fleet");
  process.env.LOOM_NO_NOTIFY = "1";
  script = []; configs.length = 0; briefings.length = 0; active = 0; peak = 0;
  dir = makeProjectDir({ agents: [
    { id: "c", kind: "fleet-conductor", role: "orchestrator", options: { model: "planner-default", effort: "low" } },
    { id: "w", kind: "fleet-echo", role: "worker", options: { model: "worker-default", effort: "medium", extraArgs: ["keep-me"] } },
    { id: "e", kind: "echo", role: "worker" },
  ] });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  await listen();
  project = (await client.addProject(dir)).project.id;
});
afterEach(async () => { await daemon?.close(); });

describe("orchestra fleets", () => {
  it("expands mixed models, pins each spawn, and caps actual turns", async () => {
    const ids = ["w@Model-A:high", "w@Model-A:high#2", "w@Model-B", "w@Model-B#2", "e@Model-C", "e@Model-C#2"];
    script = [ids.map((agent, i) => ({ type: "spawn", id: `t${i}`, title: `task ${i}`, agent, prompt: `sleep:300 write:t${i}.txt`,
      ...(i === 1 ? { model: "Task-Override", effort: "low" } : {}) }))];
    const { run } = await client.startOrchestra(project, { goal: "mixed fleet", orchestrator: "c@Planner:high", workers: ["w@Model-A:highx2", "w@Model-B×2", "echo@Model-Cx2"], maxParallel: 2, plan: true });
    expect(run.workers).toEqual(ids);
    expect(run.orchestrator).toMatchObject({ model: "Planner", effort: "high" });
    expect(run.workerDetails?.map((w) => w.model)).toEqual(["Model-A", "Model-A", "Model-B", "Model-B", "Model-C", "Model-C"]);
    const done = await settled(run.id);
    expect(done.tasks.map((t) => t.model)).toEqual(["Model-A", "Task-Override", "Model-B", "Model-B", "Model-C", "Model-C"]);
    expect(peak).toBe(2);
    for (const t of done.tasks) {
      const overlapping = done.tasks.filter((other) => other.startedAt! <= t.startedAt! && other.finishedAt! > t.startedAt!);
      expect(overlapping.length).toBeLessThanOrEqual(2);
    }
    expect(configs.find((c) => c.id === "w@Model-A:high#2")?.options).toMatchObject({ model: "Task-Override", effort: "low", extraArgs: ["keep-me"] });
    expect(configs.find((c) => c.role === "orchestrator" && c.id === "c@Planner:high")?.options).toMatchObject({ model: "Planner", effort: "high" });
    expect(JSON.parse(git("show", `${done.branch}:t1.txt.selection.json`))).toMatchObject({ model: "Task-Override", effort: "low" });
    expect(git("show", `${done.branch}:plans/${run.id}/t1.md`)).toContain('model: "Task-Override"');
    expect(briefings[0]).toContain('"w@Model-B#2"');
    expect(briefings[0]).toContain("model: Model-B");
    expect(briefings[0]).toContain("effort: high");
    const events = (await client.events(project, undefined, 1000)).events;
    expect(events.find((e) => e.kind === "orchestra" && e.payload.phase === "started")?.payload.workerDetails).toEqual(run.workerDetails);
    expect(events.some((e) => e.kind === "orchestra" && e.payload.phase === "task" && (e.payload.task as { model?: string })?.model === "Task-Override")).toBe(true);
    expect(readProjectConfig(dir)!.agents).toHaveLength(3);
    expect(readProjectConfig(dir)!.agents[1]!.options?.model).toBe("worker-default");
    expect((await client.orchestraRuns(project)).runs[0]!.workerDetails).toEqual(run.workerDetails);
  });

  it("keeps inherited selections across a daemon restart and roster changes", async () => {
    script = [[
      { type: "spawn", id: "t1", title: "resume", agent: "w#2", prompt: "sleep:1500 write:resumed.txt", model: "Task-Pinned", effort: "high" },
      { type: "spawn", id: "t2", title: "queued", agent: "w", prompt: "write:queued.txt", dependsOn: ["t1"] },
    ]];
    const { run } = await client.startOrchestra(project, { goal: "resume a fleet", orchestrator: "c", workers: ["wx2"] });
    await waitUntil(() => active === 1);
    await daemon.close();
    const cfg = readProjectConfig(dir)!;
    for (const a of cfg.agents) a.options = { ...a.options, model: "changed", effort: "low" };
    writeProjectConfig(dir, cfg);
    configs.length = 0;
    await listen();
    await client.orchestraAction(project, run.id, "resume");
    const done = await settled(run.id);
    expect(done.tasks[0], JSON.stringify(done.tasks[0])).toMatchObject({ status: "done", agent: "w#2", model: "Task-Pinned", effort: "high", attempts: 2 });
    expect(JSON.parse(git("show", `${done.branch}:queued.txt.selection.json`))).toMatchObject({ model: "worker-default", effort: "medium" });
    expect(done.workerDetails?.[1]).toMatchObject({ id: "w#2", model: "worker-default", effort: "medium" });
    expect(JSON.parse(git("show", `${done.branch}:resumed.txt.selection.json`))).toMatchObject({ model: "Task-Pinned", effort: "high" });
    expect(configs.filter((c) => c.role === "orchestrator" && c.id === "c").at(-1)?.options).toMatchObject({ model: "planner-default", effort: "low" });
  });

  it("revises a pending task's selection and keeps it for follow-ups", async () => {
    script = [[
      { type: "spawn", id: "t1", title: "first", agent: "w", prompt: "write:old.txt", model: "Old" },
      { type: "spawn", id: "t1", title: "revised", agent: "w", prompt: "write:new.txt", model: "New", effort: "high" },
      { type: "send", task: "t1", message: "write:followup.txt" },
    ]];
    const { run } = await client.startOrchestra(project, { goal: "revise", orchestrator: "c", workers: ["w"] });
    const done = await settled(run.id);
    expect(done.tasks).toHaveLength(1);
    expect(done.tasks[0]).toMatchObject({ model: "New", effort: "high", attempts: 2 });
    expect(JSON.parse(git("show", `${done.branch}:followup.txt.selection.json`))).toMatchObject({ model: "New", effort: "high" });
    expect(git("ls-tree", "--name-only", done.branch)).not.toContain("old.txt");
  });

  it("expands repeated specs and keeps race ids unique while honoring parallelism", async () => {
    const model = "a-very-long-model-name-that-would-truncate-instance-suffixes";
    const { run } = await client.startOrchestra(project, { goal: "sleep:100 write:entry.txt", orchestrator: "c", workers: [`w@${model}x2`, `w@${model}`], race: true, maxParallel: 1 });
    const done = await settled(run.id);
    expect(new Set(done.workers).size).toBe(3);
    expect(new Set(done.tasks.map((t) => t.id)).size).toBe(3);
    expect(done.tasks.every((t) => t.model === model)).toBe(true);
    expect(peak).toBe(1);
  });

  it("keeps literal roster ids that look like counts and allows inline task specs", async () => {
    await client.addAgent(project, "echo", { as: "legacyx2" });
    script = [[
      { type: "spawn", id: "t1", title: "literal", agent: "legacyx2#2", prompt: "write:literal.txt" },
      { type: "spawn", id: "t2", title: "inline", agent: "w@Inline:high", prompt: "write:inline.txt" },
    ]];
    const { run } = await client.startOrchestra(project, { goal: "names", orchestrator: "c", workers: ["legacyx2", "legacyx2", "w"] });
    const done = await settled(run.id);
    expect(done.workers).toEqual(["legacyx2", "legacyx2#2", "w"]);
    expect(done.tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect(done.tasks[1]).toMatchObject({ agent: "w", model: "Inline", effort: "high" });
    expect(JSON.parse(git("show", `${done.branch}:inline.txt.selection.json`))).toMatchObject({ model: "Inline", effort: "high" });
  });

  it("rejects invalid specs before starting a run", async () => {
    for (const worker of ["w@", "w@model:", "wx0", "wx101", "missing@model"]) {
      await expect(client.startOrchestra(project, { goal: "bad", orchestrator: "c", workers: [worker] })).rejects.toThrow();
    }
    await expect(client.startOrchestra(project, { goal: "bad", orchestrator: "cx2", workers: ["w"] })).rejects.toThrow(/single agent/);
    expect((await client.orchestraRuns(project)).runs).toEqual([]);
  });
});

it("parses model and effort without lowercasing provider values", () => {
  expect(parseAgentSpec(" echo@Model/Version:HIGH×3 ")).toEqual({ agent: "echo", model: "Model/Version", effort: "HIGH", count: 3 });
  expect(parseAgentSpec("team:echo")).toEqual({ agent: "team:echo", count: 1 });
  expect(parseOrchestraActions('```loom\n{"actions":[{"type":"spawn","agent":"echo","prompt":"go","model":" Model-A ","effort":" high "}]}\n```')?.[0]).toMatchObject({ model: "Model-A", effort: "high" });
});
