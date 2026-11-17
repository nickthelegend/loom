import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { bestFleet, modelScoreboard, scoreboardWindow, type ScoreboardSource } from "../src/core/scoreboard.js";
import { expandSavedFleets, listFleets, removeFleet, saveFleet } from "../src/core/fleets.js";
import { expandWorkerSpecs, parseAgentSpec, type OrchestraRun, type OrchestraTask } from "../src/core/orchestra.js";
import { readDaemonConfig, registerProject } from "../src/core/registry.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const DAY = 86_400_000;
const now = Date.now() - 1000;
const task = (id: string, model: string, at = now): OrchestraTask => ({ id, title: id, prompt: "go", agent: id, kind: "echo", model,
  chat: id, dependsOn: [], status: "done", attempts: 1, queued: [], startedAt: at, finishedAt: at });
const race = (id: string, at = now, picked = "a"): OrchestraRun => ({ id, goal: "go", orchestrator: { agent: "a", kind: "echo" },
  workers: ["a", "b"], status: "completed", chat: "main", baseBranch: "main", baseCommit: "seed", branch: "race", dir: "",
  tasks: [task("a", "A", at), task("b", "B", at)], round: 0, maxRounds: 1, maxParallel: 2,
  race: true, compare: true, costUsd: 0, createdAt: at, updatedAt: at,
  ...(picked ? { applied: { task: picked, at, into: "main" } } : {}) });
let eventId = 0;
const event = (kind: LoomEvent["kind"], model: string | undefined, payload = {}, at = now, adapter = "echo"): LoomEvent =>
  ({ id: ++eventId, ts: at, agentId: "same-id", kind, payload: { adapter, ...(model ? { model } : {}), ...payload } });
function sources(): ScoreboardSource[] {
  const work = race("work");
  delete work.race; delete work.compare; delete work.applied;
  work.tasks = [task("worker", "A")];
  work.landing = { pr: 1, url: "", state: "green", fixAttempts: 0, reruns: [], flaky: [], reviews: 1, updatedAt: now,
    review: { state: "success", reviewer: "reviewer", high: 0, findings: 0, at: now } };
  return [
    { id: "one", agents: [], events: [
      event("run_complete", "A", { durationMs: 100, costUsd: 1, inputTokens: 10, outputTokens: 5 }),
      event("run_complete", "A", { durationMs: 300, costUsd: 3 }),
      event("error", "A", { durationMs: 500, costUsd: 2 }),
      event("status", "A", { state: "interrupted", durationMs: 700 }),
      event("status", "A", { state: "turn_cost", costUsd: 999 }),
      event("run_complete", "B", { durationMs: 10, costUsd: 0 }),
      event("run_complete", "Old", { costUsd: 100 }, now - 31 * DAY),
      event("run_complete", "Month", {}, now - 10 * DAY),
    ], runs: [race("one"), race("unpicked", now, ""), race("old", now - 31 * DAY), work] },
    { id: "two", agents: [], events: [
      event("run_complete", "A", { durationMs: 900, costUsd: 4, inputTokens: 20 }),
      event("run_complete", "A", { costUsd: 5 }, now, "other-echo"),
      event("run_complete", undefined),
    ], runs: [race("two", now, "b")] },
  ];
}

beforeEach(() => { process.env.LOOM_HOME = tmpDir("home-scoreboard"); process.env.LOOM_NO_NOTIFY = "1"; });

describe("model scoreboard", () => {
  it("aggregates two projects by kind/model and model, with observed costs and durations", () => {
    const board = modelScoreboard(sources(), "30d", now);
    const a = board.byKindModel.find(r => r.key === "echo@A")!;
    expect(a).toMatchObject({ turns: 5, finished: 3, interrupted: 1, errored: 1, finishedRate: 0.6, interruptedRate: 0.2, erroredRate: 0.2,
      medianMs: 500, p90Ms: 900, totalCostUsd: 10, costedTurns: 4, avgCostUsd: 2.5, tokens: 35,
      entries: 3, wins: 1, tasksDone: 1, reviews: 1, reviewsPassed: 1, reviewPassRate: 1 });
    expect(a.winRate).toBeCloseTo(1 / 3);
    expect(board.byModel.find(r => r.model === "A")).toMatchObject({ turns: 6, totalCostUsd: 15, avgCostUsd: 3 });
    expect(board.byKindModel[0]?.key).toBe("echo@B"); // same win rate, lower cost
    expect(board.byKindModel.find(r => r.model === "unknown")).toMatchObject({ avgCostUsd: null, medianMs: null, winRate: null, reviewPassRate: null });
    expect(board.byKindModel.some(r => r.model === "Old")).toBe(false);
  });

  it("uses inclusive windows, excludes future events, and keeps entry cohorts for late picks", () => {
    const src = sources();
    src[0]!.events.push(event("run_complete", "Boundary", {}, now - 7 * DAY), event("run_complete", "Future", {}, now + 1));
    src[0]!.runs[2]!.applied!.at = now; // a recent pick of an old entry stays outside the window
    const week = modelScoreboard(src, "7d", now);
    expect(week.byModel.map(r => r.model)).toContain("Boundary");
    expect(week.byModel.map(r => r.model)).not.toContain("Month");
    expect(week.byModel.map(r => r.model)).not.toContain("Future");
    expect(week.byModel.find(r => r.model === "A")).toMatchObject({ entries: 3, wins: 1 });
    expect(modelScoreboard(src, "all", now).byModel.find(r => r.model === "A")).toMatchObject({ entries: 4, wins: 2 });
    expect(modelScoreboard(src, "all", now).since).toBeNull();
    expect(() => scoreboardWindow("1d")).toThrow(/window/);
  });

  it("uses pinned selections for old orchestra turns and counts only recorded review outcomes", () => {
    const src = sources()[0]!;
    src.events = [event("run_complete", undefined, { orchestra: { runId: "work", taskId: "worker" } })];
    src.runs = src.runs.filter(r => r.id === "work");
    expect(modelScoreboard([src], "all", now).byModel[0]).toMatchObject({ model: "A", turns: 1, reviews: 1 });
    src.runs[0]!.landing!.review!.state = "failure";
    expect(modelScoreboard([src], "all", now).byModel[0]).toMatchObject({ reviewPassRate: 0 });
    src.runs[0]!.landing!.review!.state = "skipped";
    expect(modelScoreboard([src], "all", now).byModel[0]).toMatchObject({ reviews: 0, reviewPassRate: null });
  });

  it("selects only eligible top models and falls back to the full configured fleet", () => {
    const src = sources()[0]!;
    src.runs = Array.from({ length: 5 }, (_, i) => race(`r${i}`));
    const rows = modelScoreboard([src], "30d", now).byKindModel;
    expect(bestFleet(rows, 2, ["@fallback"], () => true)).toEqual(["echo@A", "echo@B"]);
    expect(bestFleet(rows, 3, ["@fallback"], () => true)).toEqual(["@fallback"]);
    expect(bestFleet(rows, 2, ["@fallback"], () => false)).toEqual(["@fallback"]);
    src.runs.pop();
    expect(bestFleet(modelScoreboard([src], "30d", now).byKindModel, 2, ["echo"], () => true)).toEqual(["echo"]);
    expect(() => bestFleet(rows, 1.5, [], () => true)).toThrow(/integer/);
  });
});

describe("saved fleets", () => {
  it("validates, persists, replaces, expands copies, and removes per-user specs", () => {
    saveFleet("mixed", " echo@A:highx2, echo@B×2 ");
    expect(listFleets()).toEqual([{ name: "mixed", spec: "echo@A:highx2,echo@B×2" }]);
    const workers = expandWorkerSpecs(["@mixed"], name => {
      const s = parseAgentSpec(name); return { id: name, kind: "echo", role: "worker", options: { model: s.model, effort: s.effort } };
    });
    expect(workers.map(w => w.options?.model)).toEqual(["A", "A", "B", "B"]);
    expect(new Set(workers.map(w => w.id)).size).toBe(4);
    saveFleet("mixed", "echo@C");
    expect(expandSavedFleets(["echo@A", "@mixed"])).toEqual(["echo@A", "echo@C"]);
    expect(removeFleet("mixed")).toBe(true);
    expect(removeFleet("mixed")).toBe(false);
    expect(() => expandSavedFleets(["@mixed"])).toThrow(/unknown fleet/);
  });

  it("rejects invalid names, specs and references without replacing a valid fleet", () => {
    saveFleet("valid", "echo@A");
    for (const spec of ["", "echo@", "echox0", "echox101", "echo@A,", "@valid", "echo@A:highx0"]) {
      expect(() => saveFleet("valid", spec), spec).toThrow();
    }
    for (const name of ["../bad", "@bad", "", "a".repeat(65)]) expect(() => saveFleet(name, "echo")).toThrow();
    expect(listFleets()).toEqual([{ name: "valid", spec: "echo@A" }]);
  });
});

let daemon: LoomDaemon | undefined;
afterEach(async () => { await daemon?.close(); daemon = undefined; });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function cli(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args],
      { cwd, env: { ...process.env, LOOM_NO_AUTO_RESTART: "1" }, timeout: 60_000 }, (err, out, stderr) => resolve({ code: err ? 1 : 0, out, err: stderr }));
  });
}
async function seed() {
  const projects = [];
  for (const src of sources()) {
    const dir = makeProjectDir({ name: src.id, agents: [{ id: "same-id", kind: "echo", role: "worker" }, { id: "b", kind: "echo", role: "worker" }] });
    const info = registerProject(dir, src.id);
    const log = await EventLog.open(path.join(dir, ".loom"));
    for (const e of src.events) log.append(e);
    log.close();
    fs.mkdirSync(path.join(dir, ".loom/orchestra"), { recursive: true });
    for (const run of src.runs) fs.writeFileSync(path.join(dir, ".loom/orchestra", `${run.id}.json`), JSON.stringify(run));
    projects.push(info);
  }
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const config = readDaemonConfig()!;
  const client = new DaemonClient(config);
  const call = (method: string, route: string, body?: unknown, token = config.adminToken) => fetch(client.baseUrl + route, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { client, call, projects };
}

describe("scoreboard and fleets API / CLI", () => {
  it("reads persisted results across projects and windows and exposes both JSON and table CLI output", async () => {
    const { client, projects, call } = await seed();
    const all = await client.scoreboard("all", "30d");
    expect(all.projects).toEqual(projects.map(p => p.id));
    expect(all.byKindModel.find(r => r.key === "echo@A")).toMatchObject({ turns: 5, entries: 3, wins: 1 });
    expect((await client.scoreboard(projects[0]!.id, "7d")).byKindModel.find(r => r.key === "echo@A")).toMatchObject({ turns: 4, entries: 2, wins: 1 });
    expect((await client.scoreboard("all", "all")).byModel.some(r => r.model === "Old")).toBe(true);
    expect((await call("GET", "/api/scoreboard?window=nope")).status).toBe(400);
    expect((await call("GET", "/api/scoreboard?project=missing")).status).toBe(404);
    const json = await cli(["scoreboard", "--all", "--window", "30d", "--json"], projects[0]!.dir);
    expect(json.code, json.err).toBe(0);
    expect(JSON.parse(json.out).byKindModel).toEqual(all.byKindModel);
    const table = await cli(["scoreboard", "--window", "7d"], projects[0]!.dir);
    expect(table.code, table.err).toBe(0);
    expect(table.out).toContain("echo@A");
    expect(table.out).toContain("win rate");
  }, 90_000);

  it("shares fleet CRUD between CLI and API and refuses guests and unrelated project scopes", async () => {
    const { client, projects, call } = await seed();
    const dir = projects[0]!.dir;
    expect((await cli(["fleets:save", "mixed", "echo@Ax2,echo@B"], dir)).code).toBe(0);
    expect((await client.fleets()).fleets).toEqual([{ name: "mixed", spec: "echo@Ax2,echo@B" }]);
    await client.saveFleet("mixed", "echo@Cx2");
    const listed = await cli(["fleets", "--json"], projects[1]!.dir);
    expect(JSON.parse(listed.out).fleets[0].spec).toBe("echo@Cx2");
    expect((await call("PUT", "/api/fleets", { name: "mixed", spec: "echo@" })).status).toBe(400);
    expect((await call("GET", "/api/fleets", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/api/scoreboard", undefined, "wrong")).status).toBe(401);
    async function pair(body: unknown) {
      const made = await (await call("POST", "/api/pair/new", body)).json() as { token: string };
      const claimed = await (await call("POST", "/api/pair/claim", { token: made.token, name: "test" })).json() as { clientToken: string };
      return claimed.clientToken;
    }
    const guest = await pair({ guest: { project: projects[0]!.id, chat: "main", role: "view", name: "Guest" } });
    const scoped = await pair({ projects: [projects[0]!.id] });
    for (const token of [guest, scoped]) {
      for (const method of ["GET", "PUT", "DELETE"]) expect((await call(method, "/api/fleets", method === "GET" ? undefined : { name: "mixed", spec: "echo" }, token)).status).toBe(403);
    }
    expect((await call("GET", "/api/scoreboard", undefined, guest)).status).toBe(403);
    expect((await call("GET", `/api/scoreboard?project=${projects[1]!.id}`, undefined, scoped)).status).toBe(403);
    const scopedBoard = await (await call("GET", "/api/scoreboard?project=all", undefined, scoped)).json() as { projects: string[] };
    expect(scopedBoard.projects).toEqual([projects[0]!.id]);
    expect((await cli(["fleets:rm", "mixed"], dir)).code).toBe(0);
    expect((await client.fleets()).fleets).toEqual([]);
    await client.saveFleet("api", "echo");
    expect(await client.removeFleet("api")).toEqual({ removed: true });
    expect((await call("DELETE", "/api/fleets?name=api")).status).toBe(404);
  }, 90_000);

  it("retains per-turn models on real failed and interrupted Echo turns", async () => {
    const { client, projects } = await seed();
    const p = projects[0]!;
    await client.send(p.id, "fail:deliberate", "same-id", { model: "Failed-Selection" });
    await waitUntil(async () => (await client.scoreboard(p.id)).byKindModel.some(r => r.key === "echo@Failed-Selection" && r.errored === 1));
    await client.send(p.id, "sleep:5000", "same-id", { model: "Interrupted-Selection" });
    await client.interrupt(p.id);
    await waitUntil(async () => (await client.scoreboard(p.id)).byKindModel.some(r => r.key === "echo@Interrupted-Selection" && r.interrupted === 1));
    const rows = (await client.scoreboard(p.id)).byKindModel;
    expect(rows.find(r => r.key === "echo@Failed-Selection")).toMatchObject({ turns: 1, errored: 1, finished: 0 });
    expect(rows.find(r => r.key === "echo@Interrupted-Selection")).toMatchObject({ turns: 1, interrupted: 1, finished: 0 });
  });

  it("expands saved fleets in real comparisons and orchestra, records picks, and opts into best selection", async () => {
    const { client, projects } = await seed();
    const p = projects[0]!;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: p.dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(p.dir, ".gitignore"), ".loom/\n");
    git("add", ".gitignore"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
    await client.saveFleet("duo", "echo@First,echo@Second");
    const settled = async (id: string) => {
      await waitUntil(async () => (await client.orchestraRun(p.id, id)).run.status === "completed");
      return (await client.orchestraRun(p.id, id)).run;
    };
    const run = await settled((await client.compare(p.id, { prompt: "write:entry.txt", entrants: ["@duo"], best: 2 })).run.id);
    expect(run.workerDetails?.map(w => w.model)).toEqual(["First", "Second"]); // insufficient history retains configured fleet
    await client.orchestraAction(p.id, run.id, "apply", { task: run.tasks[0]!.id });
    const row = (await client.scoreboard(p.id)).byKindModel.find(r => r.key === "echo@First")!;
    expect(row).toMatchObject({ entries: 1, wins: 1, winRate: 1, turns: 1, totalCostUsd: 0.001 });
    await client.saveFleet("planner", "echo@Plan");
    const orch = await settled((await client.startOrchestra(p.id, { goal: "hello", orchestrator: "@planner", workers: ["@duo"], race: true })).run.id);
    expect(orch.orchestrator.model).toBe("Plan");
    expect(orch.workerDetails?.map(w => w.model)).toEqual(["First", "Second"]);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(p.dir, ".loom/orchestra", `eligible-${i}.json`), JSON.stringify(race(`eligible-${i}`)));
    const best = await settled((await client.compare(p.id, { prompt: "hello", best: 2 })).run.id);
    expect(best.workerDetails?.map(w => w.model)).toEqual(["A", "B"]);
    const auto = await settled((await client.startOrchestra(p.id, { goal: "hello", workers: ["best:2"], race: true })).run.id);
    expect(auto.workerDetails?.map(w => w.model)).toEqual(["A", "B"]);
    const bestCli = await cli(["compare", "hello", "--best", "2", "--wait"], p.dir);
    expect(bestCli.code, bestCli.err).toBe(0);
    const bestId = /comparison (\S+)/.exec(bestCli.out)![1]!;
    expect((await client.orchestraRun(p.id, bestId)).run.workerDetails?.map(w => w.model)).toEqual(["A", "B"]);
    const goals = path.join(p.dir, "goals.txt");
    fs.writeFileSync(goals, `${p.name} :: hello\n`);
    const check = await cli(["chain", goals, "--check", "--json", "-w", "@duo", "-o", "@planner"], p.dir);
    expect(check.code, check.out + check.err).toBe(0);
    expect(check.out).toContain("same-id@First");
    expect(check.out).toContain("same-id@Second");
    await expect(client.startOrchestra(p.id, { goal: "hello", orchestrator: "@duo", workers: ["echo"] })).rejects.toThrow(/exactly one/);
    await expect(client.compare(p.id, { prompt: "hello", best: 1 })).rejects.toThrow(/2 to 8/);
    await expect(client.startOrchestra(p.id, { goal: "hello", workers: ["best:0"] })).rejects.toThrow(/integer/);
    await expect(client.compare(p.id, { prompt: "hello", entrants: ["@missing"] })).rejects.toThrow(/unknown fleet/);
  }, 90_000);
});
