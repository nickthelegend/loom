/**
 * Plan mode, git delivery, the fleet view and the prompt manager.
 *
 * Same harness as orchestra.test.ts: a scripted orchestrator and echo workers,
 * with every git step real — here including a bare "origin" to push to, and a
 * stand-in `gh` on PATH that records how a PR would have been opened.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { renderPlanIndex, renderTaskFile } from "../src/core/orchestra.js";
import { clearRecent, listPrompts, recordRecent, savePrompt, updatePrompt, deletePrompt } from "../src/core/prompts.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { planModeBriefing, ProjectRuntime } from "../src/daemon/runtime.js";
import type { GitDelivery, SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

let script: string[] = [];
const seen: SendInput[] = [];
class Scripted extends AdapterBase {
  async available() {
    return true;
  }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() {
    return "";
  }
  async send(input: SendInput): Promise<void> {
    this._busy = true;
    seen.push(input);
    await new Promise((r) => setTimeout(r, 10));
    this.emit({ kind: "message", payload: { text: script.shift() ?? '```loom\n{"actions":[{"type":"done","summary":"ok"}]}\n```' } });
    this._busy = false;
  }
}
registerAgentKind("scripted2", (cfg, dir) => new Scripted(cfg.id, "scripted2", dir));
const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

let rt: ProjectRuntime | undefined;
let dir: string;
let origin: string;

async function openProject(delivery?: GitDelivery): Promise<void> {
  dir = tmpDir("orch-pd");
  origin = tmpDir("orch-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  writeProjectConfig(dir, {
    name: "pd",
    agents: [
      { id: "conductor", kind: "scripted2", role: "orchestrator" },
      { id: "alpha", kind: "echo", role: "worker" },
      { id: "beta", kind: "echo", role: "worker" },
    ],
    brain: { extractor: "off" },
    ...(delivery ? { git: { delivery } } : {}),
  });
  rt = await ProjectRuntime.open({ id: `pd-${path.basename(dir)}`, name: "pd", dir });
}

const settle = (id: string) =>
  waitUntil(() => ["completed", "failed", "aborted", "waiting_human"].includes(rt!.orchestra.get(id)!.status), { timeoutMs: 30_000 });
const delivered = (id: string) =>
  waitUntil(() => {
    const r = rt!.orchestra.get(id)!;
    return Boolean(r.delivered || r.deliveryError);
  });

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-pd");
  process.env.LOOM_NO_NOTIFY = "1";
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  script = [];
  seen.length = 0;
});

describe("plan mode", () => {
  it("writes PLAN.md and one spec per task before workers start, then records results", async () => {
    await openProject();
    script = [
      loom([
        { type: "spawn", id: "t1", title: "api", agent: "alpha", prompt: "## Goal\nbuild api\nwrite:api.txt" },
        { type: "spawn", id: "t2", title: "ui", agent: "beta", prompt: "## Goal\nbuild ui\nwrite:ui.txt", dependsOn: ["t1"] },
      ]),
      loom([{ type: "done", summary: "api and ui built" }]),
    ];
    const run = await rt!.orchestra.start({ goal: "ship the feature", orchestrator: "conductor", plan: true });
    await settle(run.id);
    const r = rt!.orchestra.get(run.id)!;
    expect(r.status).toBe("completed");
    expect(seen[0]!.briefing).toContain("PLAN MODE is on");

    // the worker's worktree already had its spec, and its briefing pointed at it
    const t1 = r.tasks[0]!;
    expect(fs.existsSync(path.join(t1.dir!, `plans/${run.id}/t1.md`))).toBe(true);

    const files = git(dir, "ls-tree", "-r", "--name-only", r.branch).split("\n");
    expect(files).toEqual(expect.arrayContaining([`plans/${run.id}/PLAN.md`, `plans/${run.id}/t1.md`, `plans/${run.id}/t2.md`, "api.txt", "ui.txt"]));
    const plan = git(dir, "show", `${r.branch}:plans/${run.id}/PLAN.md`);
    expect(plan).toContain("loom-plan: 1");
    expect(plan).toContain("| [t2](t2.md) | ui | beta | t1 | done |");
    expect(plan).toContain("api and ui built");
    const spec = git(dir, "show", `${r.branch}:plans/${run.id}/t2.md`);
    expect(spec).toContain("depends_on: [t1]");
    expect(spec).toContain("- [t1](t1.md)");
    expect(spec).toContain("status: done");
    expect(spec).toContain("## Result");
  });

  it("renders valid front matter even for awkward titles", () => {
    const run = {
      id: "o1", goal: 'fix "quotes" | and pipes', orchestrator: { agent: "c", kind: "c" }, workers: ["a"],
      status: "running", chat: "x", baseBranch: "main", baseCommit: "0", branch: "b", dir: "/", round: 1,
      maxRounds: 1, maxParallel: 1, costUsd: 0, createdAt: 0, updatedAt: 0,
      tasks: [{ id: "t1", title: "a | b", prompt: "p", agent: "a", kind: "echo", dependsOn: [], status: "pending", chat: "c", attempts: 0, queued: [] }],
    } as never;
    expect(renderPlanIndex(run)).toContain('goal: "fix \\"quotes\\" | and pipes"');
    expect(renderPlanIndex(run)).toContain("| [t1](t1.md) | a \\| b |");
    expect(renderTaskFile(run, (run as { tasks: never[] }).tasks[0]!)).toContain('title: "a | b"');
  });

  it("chat plan mode asks for a plan file, not code", () => {
    const b = planModeBriefing("Add dark mode to settings!");
    expect(b).toContain("Do NOT change any code");
    expect(b).toMatch(/plans\/\d{4}-\d{2}-\d{2}-add-dark-mode-to-settings\.md/);
  });
});

describe("git delivery", () => {
  it("none leaves the work on its branch", async () => {
    await openProject();
    script = [loom([{ type: "spawn", title: "a", agent: "alpha", prompt: "write:a.txt" }]), loom([{ type: "done", summary: "ok" }])];
    const run = await rt!.orchestra.start({ goal: "g", orchestrator: "conductor" });
    await settle(run.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(rt!.orchestra.get(run.id)!.delivered).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
  });

  it("push merges into the current branch and pushes it", async () => {
    await openProject("push");
    script = [loom([{ type: "spawn", title: "a", agent: "alpha", prompt: "write:a.txt" }]), loom([{ type: "done", summary: "ok" }])];
    const run = await rt!.orchestra.start({ goal: "g", orchestrator: "conductor" });
    await settle(run.id);
    await delivered(run.id);
    const r = rt!.orchestra.get(run.id)!;
    expect(r.deliveryError).toBeUndefined();
    expect(r.delivered).toMatchObject({ mode: "push", into: "main", pushed: "main" });
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(true);
    expect(git(origin, "ls-tree", "-r", "--name-only", "main")).toContain("a.txt");
  });

  it("pr pushes the run's own branch and opens a PR with gh", async () => {
    const bin = tmpDir("fake-gh");
    const log = path.join(bin, "gh.log");
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\necho https://github.com/acme/app/pull/42\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      await openProject("pr");
      script = [loom([{ type: "spawn", title: "a", agent: "alpha", prompt: "write:a.txt" }]), loom([{ type: "done", summary: "built a" }])];
      const run = await rt!.orchestra.start({ goal: "add a", orchestrator: "conductor" });
      await settle(run.id);
      await delivered(run.id);
      const r = rt!.orchestra.get(run.id)!;
      expect(r.deliveryError).toBeUndefined();
      expect(r.delivered).toMatchObject({ mode: "pr", pushed: r.branch, prUrl: "https://github.com/acme/app/pull/42" });
      expect(git(origin, "branch", "--list", "loom/*")).toContain(r.branch);
      const call = fs.readFileSync(log, "utf8");
      expect(call).toContain(`pr create --head ${r.branch} --base main --title add a`);
      expect(call).toContain("built a");
      // the user's branch is untouched: the PR is the delivery
      expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
    } finally {
      process.env.PATH = PATH;
    }
  });

  it("a failed push is reported, and the run stays completed", async () => {
    await openProject("push");
    git(dir, "remote", "set-url", "origin", "/nonexistent/remote.git");
    script = [loom([{ type: "spawn", title: "a", agent: "alpha", prompt: "write:a.txt" }]), loom([{ type: "done", summary: "ok" }])];
    const run = await rt!.orchestra.start({ goal: "g", orchestrator: "conductor" });
    await settle(run.id);
    await delivered(run.id);
    const r = rt!.orchestra.get(run.id)!;
    expect(r.status).toBe("completed");
    expect(r.deliveryError).toBeTruthy();
  });

  it("validates the policy in project config", async () => {
    await openProject();
    expect(() => rt!.patchConfig({ git: { delivery: "yolo" } })).toThrow(/git.delivery/);
    rt!.patchConfig({ git: { delivery: "pr" } });
    expect(rt!.settings().git.delivery).toBe("pr");
    rt!.patchConfig({ git: { delivery: "none" } });
    expect(rt!.settings().git.delivery).toBe("none");
  });
});

describe("fleet activity", () => {
  it("shows each agent's thread and last step, and each orchestra task's", async () => {
    await openProject();
    const main = rt!.chats()[0]!.id;
    await rt!.sendMessage("write:hello.txt", "alpha", { chat: main });
    await waitUntil(() => rt!.log.list({}).some((e) => e.kind === "run_complete" && e.agentId === "alpha"));
    script = [loom([{ type: "spawn", title: "slowpoke", agent: "beta", prompt: "sleep:800 write:s.txt" }])];
    const run = await rt!.orchestra.start({ goal: "g", orchestrator: "conductor" });
    await waitUntil(() => rt!.orchestra.get(run.id)!.tasks[0]?.status === "running");
    const a = rt!.activity() as {
      agents: Array<{ id: string; chat: string; last: { line: string } | null; permissions: string }>;
      orchestra: { tasks: Array<{ title: string; agent: string; status: string }> };
    };
    const alpha = a.agents.find((x) => x.id === "alpha")!;
    expect(alpha.chat).toBe(main);
    expect(alpha.last?.line).toBeTruthy();
    expect(a.orchestra.tasks[0]).toMatchObject({ title: "slowpoke", agent: "beta", status: "running" });
    await rt!.orchestra.abort(run.id);
  });
});

describe("prompt manager", () => {
  it("saves, pins, counts uses, searches, and keeps a de-duplicated history", () => {
    clearRecent();
    const a = savePrompt({ text: "Review this diff for security issues" });
    const b = savePrompt({ text: "Write tests for the changed files", pinned: true });
    expect(savePrompt({ text: "Review this diff for security issues" }).id).toBe(a.id); // no dupes
    updatePrompt(a.id, { used: true });
    let l = listPrompts();
    expect(l.saved[0]!.id).toBe(b.id); // pinned first
    expect(l.saved.find((p) => p.id === a.id)!.uses).toBe(1);
    expect(listPrompts("security").saved.map((p) => p.id)).toEqual([a.id]);

    recordRecent("first", { mode: "chat" });
    recordRecent("second", { mode: "orchestrate" });
    recordRecent("first", { mode: "chat" });
    l = listPrompts();
    expect(l.recent.map((r) => r.text)).toEqual(["first", "second"]);
    expect(deletePrompt(a.id)).toBe(true);
    expect(() => savePrompt({ text: "   " })).toThrow();
  });
});
