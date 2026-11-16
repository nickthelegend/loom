import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerAgentKind } from "../src/adapters/index.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { parseWorkerReports, type OrchestraRun } from "../src/core/orchestra.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environments = new Map<string, Record<string, string>>();
let daemon: LoomDaemon;
let client: DaemonClient;
let project: string;
let dir: string;
let admin: string;
const envFor = (run: OrchestraRun, task = run.tasks[0]!.id) => environments.get(`${run.id}/${task}`)!;
const reportPath = (run: OrchestraRun, task = run.tasks[0]!.id) => `/api/projects/${project}/orchestra/${run.id}/tasks/${task}/report`;
const request = (url: string, token: string | undefined, body?: unknown, method = "POST") => fetch(client.baseUrl + url, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (run: OrchestraRun, kind: string, text = "", token = envFor(run).LOOM_REPORT_TOKEN) => request(reportPath(run), token, { kind, text });
const get = async (run: OrchestraRun) => (await client.orchestraRun(project, run.id)).run;

async function start(prompts = ["sleep:60000"], race = false): Promise<OrchestraRun> {
  // Echo repeats a real actions block. Escaping the worker's sleep avoids making
  // the echo orchestrator sleep too; JSON parsing restores the worker prompt.
  const goal = race ? prompts[0]! : "```loom\n" + JSON.stringify({ actions: prompts.map((prompt, i) => ({
    type: "spawn", id: `t${i + 1}`, title: `Task ${i + 1}`, agent: "worker", prompt,
  })) }).replaceAll("sleep:", "\\u0073leep:") + "\n```";
  const { run } = await client.startOrchestra(project, { goal, orchestrator: "lead", workers: race ? ["worker", "lead"] : ["worker"], race });
  if (!race) {
    await waitUntil(async () => (await get(run)).status === "waiting_human");
    await client.orchestraAction(project, run.id, "reply", { text: goal });
  }
  await waitUntil(async () => {
    const current = await get(run);
    return current.tasks.length === (race ? 2 : prompts.length) && current.tasks.every(t => environments.has(`${run.id}/${t.id}`));
  });
  return get(run);
}

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const clean = { ...process.env };
    for (const key of ["LOOM_API", "LOOM_PROJECT_ID", "LOOM_RUN_ID", "LOOM_TASK_ID", "LOOM_REPORT_TOKEN"]) delete clean[key];
    execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args],
      { cwd: dir, env: { ...clean, ...env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: stdout + stderr }));
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("report-home");
  process.env.LOOM_NO_NOTIFY = "1";
  // Observe the actual options passed to real echo workers, without replacing
  // their send, streaming, interrupt or event behaviour.
  registerAgentKind("echo", (cfg, cwd) => {
    const env = cfg.options?.env as Record<string, string> | undefined;
    if (env?.LOOM_RUN_ID) environments.set(`${env.LOOM_RUN_ID}/${env.LOOM_TASK_ID}`, env);
    return new EchoAdapter(cfg.id, "echo", cwd);
  });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  dir = makeProjectDir({ agents: [{ id: "lead", kind: "echo", role: "orchestrator" }, { id: "worker", kind: "echo", role: "worker" }] });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  client = new DaemonClient(readDaemonConfig()!);
  admin = readDaemonConfig()!.adminToken;
  project = (await client.addProject(dir)).project.id;
});
afterEach(async () => {
  for (const run of (await client.orchestraRuns(project)).runs) {
    if (["planning", "running", "reviewing", "waiting_human"].includes(run.status)) await client.orchestraAction(project, run.id, "abort");
  }
});
afterAll(async () => {
  await daemon.close();
  registerAgentKind("echo", (cfg, cwd) => new EchoAdapter(cfg.id, "echo", cwd));
});

describe("worker reports", () => {
  it("parses complete fences and ignores malformed or incomplete reports", () => {
    expect(parseWorkerReports("```loom-report\r\nneeds_input: choose a name\r\n```\n```loom-report\ndone:\n```"))
      .toEqual([{ kind: "needs_input", text: "choose a name" }, { kind: "done", text: "" }]);
    expect(parseWorkerReports("```loom-report\ncheckpoint: partial")).toEqual([]);
    expect(parseWorkerReports("```loom-report\nwrong: no\n```\n```loom-report\nstuck: \n```" )).toEqual([]);
    expect(parseWorkerReports(`\`\`\`loom-report\ncheckpoint: ${"x".repeat(4001)}\n\`\`\``)).toEqual([]);
  });

  it("records streamed fences live, deduplicates final messages, and leaves the transcript intact", async () => {
    const block = "```loom-report\ncheckpoint: tests pass\n```";
    const prompt = `${block}\n${block}\n\`\`\`loom-report\ndone:\n\`\`\`\nstream:10 ${"still working ".repeat(80)}`;
    const run = await start([prompt], true);
    await waitUntil(async () => (await get(run)).tasks[0]!.reports!.length === 3);
    expect((await get(run)).tasks[0]!.status).toBe("running");
    await waitUntil(async () => (await get(run)).status === "completed");
    const task = (await get(run)).tasks[0]!;
    expect(task.reports?.map(r => r.kind)).toEqual(["checkpoint", "checkpoint", "done"]);
    expect(task.lastReport).toEqual(task.reports?.at(-1));
    const events = (await client.events(project, undefined, 1000)).events;
    expect(events.some(e => e.chat === task.chat && e.kind === "message" && String(e.payload.text).includes(prompt))).toBe(true);
    const finalOnly = await start([block], true);
    await waitUntil(async () => (await get(finalOnly)).status === "completed");
    expect((await get(finalOnly)).tasks[0]!.reports).toHaveLength(1);
  });

  it("authenticates only report POSTs, broadcasts and persists bounded report history", async () => {
    const other = await start(["a completed run"], true);
    await waitUntil(async () => (await get(other)).status === "completed");
    const run = await start();
    const env = envFor(run);
    expect(env).toMatchObject({ LOOM_API: client.baseUrl, LOOM_PROJECT_ID: project, LOOM_RUN_ID: run.id, LOOM_TASK_ID: "t1" });
    expect(env.LOOM_REPORT_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(env.LOOM_REPORT_TOKEN).not.toBe(admin);
    const ws = new WebSocket(client.baseUrl.replace("http:", "ws:") + `/ws?token=${admin}&project=${project}`);
    const received: LoomEvent[] = [];
    ws.on("message", data => { const f = JSON.parse(String(data)); if (f.event) received.push(f.event); });
    await new Promise<void>(resolve => ws.once("open", resolve));
    try {
      expect((await post(run, "checkpoint", "first")).status).toBe(200);
      await waitUntil(() => received.some(e => e.kind === "orchestra" && e.payload.phase === "task_report"));
      const event = received.find(e => e.payload.phase === "task_report")!;
      expect(event.payload).toMatchObject({ runId: run.id, taskId: "t1", report: { kind: "checkpoint", text: "first" },
        task: { reports: [{ kind: "checkpoint", text: "first" }], lastReport: { kind: "checkpoint", text: "first" } } });
      expect((await post(run, "done", "", admin)).status).toBe(200);
      for (const owner of [true, false]) {
        const pairing = await (await request("/api/pair/new", admin, { owner, host: "127.0.0.1" })).json();
        const claimed = await (await request("/api/pair/claim", undefined, { token: pairing.token, name: "report-test" })).json();
        expect((await post(run, "checkpoint", "paired caller", claimed.clientToken)).status).toBe(owner ? 200 : 403);
      }
      expect((await request(reportPath(run), undefined, { kind: "done" })).status).toBe(401);
      expect((await post(run, "done", "", "wrong")).status).toBe(401);
      expect((await request(`/api/projects/${project}/orchestra`, env.LOOM_REPORT_TOKEN, undefined, "GET")).status).toBe(401);
      expect((await request(`/api/projects/${project}/orchestra/${run.id}/abort`, env.LOOM_REPORT_TOKEN, {})).status).toBe(401);
      expect((await request(reportPath(run, "other-run-task"), env.LOOM_REPORT_TOKEN, { kind: "done" })).status).toBe(404);
      expect((await request(reportPath(other), env.LOOM_REPORT_TOKEN, { kind: "done" })).status).toBe(401);
      for (const body of [{ kind: ["done"] }, { kind: "bogus" }, { kind: "stuck", text: " " }, { kind: "done", text: 42 }, { kind: "checkpoint", text: "x".repeat(4001) }]) {
        expect((await request(reportPath(run), admin, body)).status).toBe(400);
      }
      for (let i = 0; i < 23; i++) expect((await post(run, "checkpoint", `step ${i}`)).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 5200));
      const current = await get(run);
      expect(current.tasks[0]!.reports).toHaveLength(20);
      expect(current.tasks[0]!.reports![0]!.text).toBe("step 3");
      expect(current.tasks[0]!.lastReport?.text).toBe("step 22");
      expect(current.tasks[0]!.status).toBe("running");
      expect(current.round).toBe(run.round);
      const saved = fs.readFileSync(path.join(dir, ".loom/orchestra", `${run.id}.json`), "utf8");
      expect(JSON.parse(saved).tasks[0].reports).toEqual(current.tasks[0]!.reports);
      expect(JSON.stringify(current) + saved + JSON.stringify(received)).not.toContain(env.LOOM_REPORT_TOKEN);
    } finally { ws.close(); }
  });

  it("batches needs_input and stuck into one early note while workers are still busy", async () => {
    const run = await start(["sleep:60000", "sleep:60000"]);
    expect(envFor(run, "t1").LOOM_REPORT_TOKEN).toBe(envFor(run, "t2").LOOM_REPORT_TOKEN);
    await post(run, "needs_input", "Which version?");
    await post(run, "stuck", "Waiting for version");
    await request(reportPath(run, "t2"), envFor(run).LOOM_REPORT_TOKEN, { kind: "stuck", text: "Build is blocked" });
    expect((await get(run)).round).toBe(run.round);
    await waitUntil(async () => (await get(run)).round > run.round);
    const current = await get(run);
    expect(current.tasks.every(t => t.status === "running")).toBe(true);
    const notes = (await client.events(project, undefined, 1000)).events.filter(e => e.chat === run.chat &&
      e.kind === "message" && e.payload.author === "loom" && String(e.payload.text).includes("Worker progress reports:"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload.text).toContain("t1 (needs_input): Which version?");
    expect(notes[0]!.payload.text).toContain("t2 (stuck): Build is blocked");
    expect(notes[0]!.payload.text).toContain("t1 (stuck): Waiting for version");
  });

  it("delivers a pending batch after a busy orchestrator turn and respects a human pause", async () => {
    const run = await start();
    await client.orchestraAction(project, run.id, "reply", { text: 'sleep:6500\n```loom\n{"actions": []}\n```' });
    await waitUntil(async () => (await get(run)).round === run.round + 1);
    await post(run, "needs_input", "Need a decision while you review");
    await waitUntil(async () => (await get(run)).status === "waiting_human");
    const current = await get(run);
    expect(current.error).toBeUndefined();
    expect(current.tasks[0]!.status).toBe("running");
    const notes = (await client.events(project, undefined, 1000)).events.filter(e => e.chat === run.chat &&
      e.kind === "message" && e.payload.author === "loom" && String(e.payload.text).includes("Worker progress reports:"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload.text).toContain("Need a decision while you review");
    await post(run, "stuck", "Waiting for human");
    await new Promise(resolve => setTimeout(resolve, 5200));
    expect((await get(run)).round).toBe(current.round);
    expect((await get(run)).status).toBe("waiting_human");
  });

  it("runs the report CLI from worker env and explains invalid flags or missing env", async () => {
    const run = await start();
    const progress = cli(["orchestra", run.id, "--wait", "--progress", "--json"]);
    const watched = cli(["orchestra", run.id, "--watch", "--progress"]);
    for (const [flag, text, kind] of [["--checkpoint", "Checked tests", "checkpoint"], ["--needs-input", "Choose name", "needs_input"], ["--stuck", "No dependency", "stuck"], ["--done", "", "done"]]) {
      const result = await cli(["report", flag!, ...(text ? [text] : [])], envFor(run));
      expect(result).toMatchObject({ code: 0 });
      expect(result.out).toContain(`reported ${kind}`);
      expect((await get(run)).tasks[0]!.lastReport).toMatchObject({ kind, text });
    }
    const missing = await cli(["report", "--done"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("missing LOOM_API, LOOM_PROJECT_ID, LOOM_RUN_ID, LOOM_TASK_ID, LOOM_REPORT_TOKEN");
    for (const args of [["report"], ["report", "--done", "--checkpoint", "both"]]) {
      expect((await cli(args, envFor(run))).out).toContain("choose exactly one");
    }
    await client.orchestraAction(project, run.id, "abort");
    const observed = await progress;
    expect(observed.code).toBe(1);
    expect(observed.out).toContain('"kind":"report"');
    expect(observed.out).toContain("Checked tests");
    expect((await watched).out).toContain("checkpoint: Checked tests");
    expect((await post(run, "done")).status).toBe(401);
    expect((await post(run, "done", "", admin)).status).toBe(400);
  });

  it("preserves reports across restart and replaces the old worker credential on resume", async () => {
    const run = await start();
    const old = envFor(run).LOOM_REPORT_TOKEN;
    await post(run, "checkpoint", "Saved progress");
    await daemon.close();
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    client = new DaemonClient(readDaemonConfig()!);
    expect((await get(run)).tasks[0]!.lastReport?.text).toBe("Saved progress");
    expect((await post(run, "done", "", old)).status).toBe(401);
    await client.orchestraAction(project, run.id, "resume");
    await waitUntil(() => envFor(run).LOOM_REPORT_TOKEN !== old);
    expect((await post(run, "checkpoint", "Resumed")).status).toBe(200);
    expect((await get(run)).tasks[0]!.reports).toHaveLength(2);
  });
});
