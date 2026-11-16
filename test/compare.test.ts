import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgentSpec, type CompareOptions, type OrchestraRun } from "../src/core/orchestra.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, dir: string, project: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
async function listen() {
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
}
async function settled(id: string): Promise<OrchestraRun> {
  let run: OrchestraRun;
  await waitUntil(async () => {
    run = (await client.orchestraRun(project, id)).run;
    return ["completed", "failed", "aborted"].includes(run.status);
  });
  expect(run!.status).toBe("completed");
  return run!;
}

beforeEach(async () => {
  process.env.LOOM_HOME = tmpDir("home-compare");
  process.env.LOOM_NO_NOTIFY = "1";
  dir = makeProjectDir({ agents: [
    { id: "a", kind: "echo", role: "worker" },
    { id: "b", kind: "echo", role: "worker", options: { model: "default-b" } },
    { id: "disabled", kind: "echo", role: "worker", enabled: false },
  ] });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "entry.txt"), "old line\nanother old line\n");
  fs.writeFileSync(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2]));
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  await listen();
  project = (await client.addProject(dir)).project.id;
});
afterEach(async () => { await daemon?.close(); });

describe("Ask several through Orchestra races", () => {
  it("expands selections into isolated worktrees and persists results, stats and events", async () => {
    const { run } = await client.compare(project, { prompt: "write:entry.txt", entrants: ["a@m1", "b@m2:highx2"], chat: "main" });
    expect(run).toMatchObject({ race: true, compare: true, chat: "main", inPlace: true, round: 0 });
    expect(run.workers).toEqual(["a@m1", "b@m2:high", "b@m2:high#2"]);
    const done = await settled(run.id);
    expect(new Set(done.tasks.map((t) => t.dir)).size).toBe(3);
    expect(new Set(done.tasks.map((t) => t.chat)).size).toBe(3);
    for (const task of done.tasks) {
      expect(task).toMatchObject({ status: "done", prompt: "write:entry.txt", files: ["entry.txt"], diffStat: { files: 1, insertions: 1, deletions: 2 } });
      expect(task.model).toBe(task.agent.startsWith("a") ? "m1" : "m2");
      expect(task.result).toContain(`echo(${task.agent})`);
      expect(task.costUsd).toBeGreaterThan(0);
      expect(task.finishedAt).toBeGreaterThanOrEqual(task.startedAt!);
      const { patch } = await client.orchestraTaskDiff(project, run.id, task.id);
      expect(patch).toContain(`+echo(${task.agent}) wrote this`);
      expect(patch).toContain("-another old line");
      expect(fs.readFileSync(path.join(task.dir!, "entry.txt"), "utf8")).toBe(`echo(${task.agent}) wrote this\n`);
    }
    expect(fs.readFileSync(path.join(dir, "entry.txt"), "utf8")).toBe("old line\nanother old line\n");
    expect(git("diff", run.baseCommit, done.branch)).toBe("");
    const events = (await client.events(project, undefined, 1000)).events.filter((e) => e.kind === "orchestra");
    expect(events.find((e) => e.payload.phase === "started")?.payload).toMatchObject({ compare: true, race: true });
    expect(events.filter((e) => e.payload.phase === "task").map((e) => e.payload.task)).toContainEqual(expect.objectContaining({ status: "done", diffStat: { files: 1, insertions: 1, deletions: 2 }, result: expect.any(String), finishedAt: expect.any(Number) }));
    await daemon.close();
    await listen();
    expect((await client.orchestraRun(project, run.id)).run).toMatchObject({ compare: true, tasks: done.tasks });
    expect((await client.orchestraRuns(project)).runs[0]!.compare).toBe(true);
  });

  it("keeps only the picked worktree and retains discarded diffs", async () => {
    const { run } = await client.compare(project, { prompt: "write:new.txt", entrants: ["a@m1", "b@m2x2"] });
    const done = await settled(run.id);
    const pick = done.tasks[1]!;
    await expect(client.orchestraAction(project, run.id, "apply")).rejects.toThrow(/pick an entrant/);
    await expect(client.orchestraAction(project, run.id, "apply", { task: "missing" })).rejects.toThrow(/pick an entrant/);
    await client.orchestraAction(project, run.id, "apply", { task: pick.id });
    expect(fs.readFileSync(path.join(dir, "new.txt"), "utf8")).toBe(`echo(${pick.agent}) wrote this\n`);
    expect((await client.orchestraRun(project, run.id)).run.applied?.task).toBe(pick.id);
    for (const task of done.tasks) {
      expect(fs.existsSync(task.dir!)).toBe(task.id === pick.id);
      expect((await client.orchestraTaskDiff(project, run.id, task.id)).patch).toContain(`+echo(${task.agent}) wrote this`);
    }
    await expect(client.orchestraAction(project, run.id, "apply", { task: done.tasks[0]!.id })).rejects.toThrow(/already applied/);
  });

  it("resolves kinds through the project and accepts eight expanded entrants", async () => {
    const { run } = await client.compare(project, { prompt: "hello", entrants: ["echo@m1x7", "b"] });
    const done = await settled(run.id);
    expect(done.tasks).toHaveLength(8);
    expect(done.tasks[0]).toMatchObject({ agent: "a@m1", kind: "echo", model: "m1" });
    expect(done.tasks[7]).toMatchObject({ agent: "b", model: "default-b" });
    expect(done.tasks.every((t) => t.diffStat?.files === 0 && t.diffStat.insertions === 0 && t.diffStat.deletions === 0)).toBe(true);
    expect((await client.orchestraTaskDiff(project, run.id, done.tasks[0]!.id)).patch).toBe("");
  });

  it("counts changed binary files without inventing line counts", async () => {
    const { run } = await client.compare(project, { prompt: "write:binary.bin", entrants: ["ax2"] });
    const done = await settled(run.id);
    expect(done.tasks.map((t) => t.diffStat)).toEqual([
      { files: 1, insertions: 0, deletions: 0 }, { files: 1, insertions: 0, deletions: 0 },
    ]);
    expect((await client.orchestraTaskDiff(project, run.id, done.tasks[0]!.id)).patch).toContain("Binary files");
  });

  it("preserves all worktrees when applying conflicts with the project", async () => {
    const { run } = await client.compare(project, { prompt: "write:entry.txt", entrants: ["a", "b"] });
    const done = await settled(run.id);
    fs.writeFileSync(path.join(dir, "entry.txt"), "my own change\n");
    git("add", "entry.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "local edit");
    await expect(client.orchestraAction(project, run.id, "apply", { task: done.tasks[0]!.id })).rejects.toThrow(/merge into main failed/);
    expect((await client.orchestraRun(project, run.id)).run.applied).toBeUndefined();
    expect(done.tasks.every((t) => fs.existsSync(t.dir!))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "entry.txt"), "utf8")).toBe("my own change\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("serializes simultaneous picks so only one entrant is applied", async () => {
    const { run } = await client.compare(project, { prompt: "write:new.txt", entrants: ["a", "b"] });
    const done = await settled(run.id);
    const picks = await Promise.allSettled(done.tasks.map((t) => client.orchestraAction(project, run.id, "apply", { task: t.id })));
    expect(picks.filter((p) => p.status === "fulfilled")).toHaveLength(1);
    expect(picks.find((p) => p.status === "rejected")).toMatchObject({ reason: { message: expect.stringContaining("already applied") } });
    const kept = (await client.orchestraRun(project, run.id)).run.applied!.task;
    expect(done.tasks.filter((t) => fs.existsSync(t.dir!)).map((t) => t.id)).toEqual([kept]);
  });

  it("rejects malformed, unknown, disabled and out-of-range entrants before creating runs", async () => {
    const invalid: unknown[] = [
      {}, { prompt: 3, entrants: ["a", "b"] }, { prompt: " ", entrants: ["a", "b"] },
      { prompt: "x", entrants: "a,b" }, { prompt: "x", entrants: ["a", 2] },
      { prompt: "x", entrants: ["a", "b"], chat: 3 },
      ...[[], ["a"], ["ax9"], ["ax0"], ["a@", "b"], ["a", "missing"], ["a", "disabled"], ["a", "team:echo"], ["a", "acp:gemini"], ["a", ""]].map((entrants) => ({ prompt: "x", entrants })),
    ];
    for (const body of invalid) await expect(client.compare(project, body as CompareOptions)).rejects.toMatchObject({ status: 400 });
    await expect(client.compare(project, { prompt: "x", entrants: ["a", "missing"] })).rejects.toThrow(/unknown worker agent "missing"/);
    expect((await client.orchestraRuns(project)).runs).toEqual([]);
  });

  it("records failed and questioning entrants without making them applicable", async () => {
    for (const prompt of ["fail:unavailable", "write:question.txt ask: what next?"]) {
      const { run } = await client.compare(project, { prompt, entrants: ["a", "b"] });
      const done = await settled(run.id);
      expect(done.tasks.every((t) => t.status === (prompt.startsWith("fail:") ? "failed" : "needs_input"))).toBe(true);
      expect(done.tasks.every((t) => t.diffStat?.files === (prompt.startsWith("fail:") ? 0 : 1))).toBe(true);
      await expect(client.orchestraAction(project, run.id, "apply", { task: done.tasks[0]!.id })).rejects.toThrow(/didn't finish/);
    }
  });
});

it("parses ACP preset selectors with model, effort and copies", () => {
  expect(parseAgentSpec("acp:gemini@Model:highx2")).toEqual({ agent: "acp:gemini", model: "Model", effort: "high", count: 2 });
});
