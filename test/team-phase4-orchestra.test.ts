/**
 * Loom Teams, Phase 4 — the orchestra's side of landing: per-goal and daily
 * budgets (D64), and a big goal delivered as a stack of PRs cut along its
 * merge commits (D59). One project, a stand-in coordinator, a real bare
 * origin, and a `gh` stub on PATH that records the PRs it's asked to open.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import type { OrchestraCoordinator } from "../src/core/orchestra.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { Landing, type Exec } from "../src/daemon/landing.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

const script: Array<(input: string) => string> = [];
class Conductor extends AdapterBase {
  async available() {
    return true;
  }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() {
    return "";
  }
  async send(_input: SendInput) {
    this._busy = true;
    await new Promise((r) => setTimeout(r, 5));
    const next = script.shift();
    this.emit({ kind: "message", payload: { text: next ? next(_input.text) : loom([]) } });
    this._busy = false;
  }
}
registerAgentKind("p4o-conductor", (cfg, dir) => new Conductor(cfg.id, "p4o-conductor", dir));

class Writer extends AdapterBase {
  async available() {
    return true;
  }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() {
    return "";
  }
  async send(input: SendInput) {
    this._busy = true;
    for (const m of input.text.matchAll(/write:([\w./-]+):(\d+)/g)) {
      const f = path.join(this.projectDir, m[1]!);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Array.from({ length: Number(m[2]) }, (_, i) => `line ${i}`).join("\n") + "\n");
    }
    this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: 1 } });
    this.emit({ kind: "message", payload: { text: "done" } });
    this._busy = false;
  }
}
registerAgentKind("p4o-writer", (cfg, dir) => new Writer(cfg.id, "p4o-writer", dir));

let rt: ProjectRuntime;
let origin = "";
let ghLog = "";
let oldPath: string | undefined;
const coord: OrchestraCoordinator & { budget: number | null; blocked: string | null; stack: "auto" | "off" } = {
  budget: null,
  blocked: null,
  stack: "off",
  admit: async () => ({ go: true }),
  goalBudgetUsd() {
    return this.budget;
  },
  canStart() {
    return this.blocked;
  },
  stackMode() {
    return this.stack;
  },
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-p4o");
  process.env.LOOM_NO_NOTIFY = "1";
  const bin = tmpDir("p4o-bin");
  ghLog = path.join(bin, "calls.log");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\necho "$@" >> "${ghLog}"\ncase "$*" in\n  *"pr create"*) n=$(cat "${bin}/n" 2>/dev/null || echo 20); n=$((n+1)); echo $n > "${bin}/n"; echo "https://github.com/acme/app/pull/$n" ;;\nesac\n`,
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  const seed = tmpDir("p4o-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("p4o-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "push", "-q", origin, "main");
  const dir = tmpDir("p4o-proj");
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "user.email", "o@t");
  git(dir, "config", "user.name", "o");
  writeProjectConfig(dir, {
    name: "p4o",
    agents: [
      { id: "conductor", kind: "p4o-conductor", role: "orchestrator" },
      { id: "writer", kind: "p4o-writer", role: "worker" },
    ],
    brain: { extractor: "off" },
    git: { delivery: "pr" },
  });
  rt = await ProjectRuntime.open({ id: "p4o", name: "p4o", dir });
  rt.coordinator = coord;
}, 60_000);

afterAll(async () => {
  process.env.PATH = oldPath;
  await rt.close();
});

const settle = (id: string) => waitUntil(() => ["completed", "failed", "waiting_human"].includes(rt.orchestra.get(id)!.status), { timeoutMs: 15_000 });

describe("Phase 4 in the orchestra", () => {
  it("a member over the daily budget can't start a goal (D64)", async () => {
    coord.blocked = "you've spent $60.00 of your $60.00 daily budget";
    await expect(rt.orchestra.start({ goal: "More work", orchestrator: "conductor" })).rejects.toThrow(/daily budget/);
    coord.blocked = null;
  });

  it("a goal over its cap pauses for a human; continuing allows one more budget (D64)", async () => {
    coord.budget = 1.5;
    script.push(() => loom([{ type: "spawn", id: "t1", title: "a", agent: "writer", prompt: "write:a.txt:3" }]));
    script.push(() => loom([{ type: "spawn", id: "t2", title: "b", agent: "writer", prompt: "write:b.txt:3" }]));
    script.push(() => loom([{ type: "done", summary: "both" }]));
    const run = await rt.orchestra.start({ goal: "Two files", orchestrator: "conductor" });
    await settle(run.id);
    let r = rt.orchestra.get(run.id)!;
    expect(r.status).toBe("waiting_human"); // t2 took it to $2 of $1.50
    expect(r.question).toMatch(/spent \$2\.00 of its \$1\.50 budget/);
    expect(r.tasks.map((t) => t.status)).toEqual(["done", "done"]);
    await rt.orchestra.reply(run.id, "continue");
    await waitUntil(() => rt.orchestra.get(run.id)!.status === "completed" && Boolean(rt.orchestra.get(run.id)!.delivered), { timeoutMs: 15_000 });
    r = rt.orchestra.get(run.id)!;
    expect(r.budgetUsd).toBeCloseTo(3.5);
    coord.budget = null;
  });

  it("a big goal is delivered as a stack: one PR per slice, each based on the one below (D59)", async () => {
    coord.stack = "auto";
    fs.writeFileSync(ghLog, "");
    script.push(() => loom([{ type: "spawn", id: "t1", title: "models", agent: "writer", prompt: "write:src/models.ts:300" }]));
    script.push(() => loom([{ type: "spawn", id: "t2", title: "api", agent: "writer", prompt: "write:src/api.ts:300", dependsOn: ["t1"] }]));
    script.push(() => loom([{ type: "done", summary: "models and api" }]));
    const run = await rt.orchestra.start({ goal: "Models and API", orchestrator: "conductor" });
    await waitUntil(() => Boolean(rt.orchestra.get(run.id)!.landing), { timeoutMs: 15_000 });
    const r = rt.orchestra.get(run.id)!;
    const stack = r.landing!.stack!;
    expect(stack).toHaveLength(2);
    const lower = `${r.branch.replace(/\/main$/, "")}/stack-1`;
    expect(stack[0]).toMatchObject({ branch: lower, base: "main" });
    expect(stack[1]).toMatchObject({ branch: r.branch, base: lower });
    expect(r.landing!.pr).toBe(stack[1]!.pr);
    // the lower slice is exactly t1's merge: models, and not the api
    expect(git(origin, "show", `${lower}:src/models.ts`).split("\n").filter(Boolean)).toHaveLength(300);
    expect(() => git(origin, "show", `${lower}:src/api.ts`)).toThrow();
    expect(git(origin, "rev-parse", lower).trim()).toBe(r.tasks.find((t) => t.id === "t1")!.mergeCommit);
    const creates = fs.readFileSync(ghLog, "utf8").split("\n").filter((l) => l.startsWith("pr create"));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain(`--head ${lower} --base main`);
    expect(creates[1]).toContain(`--head ${r.branch} --base ${lower}`);
    expect(r.tasks.map((t) => t.lines)).toEqual([300, 300]);
    coord.stack = "off";
  });

  it("a lower slice that keeps failing folds the stack into one PR the fix loop can fix (D59, D55)", async () => {
    const run = rt.orchestra.list().find((r) => r.landing?.stack?.length)!;
    const [lower, top] = run.landing!.stack!;
    const calls: string[][] = [];
    const fake: Exec = async (cmd, args) => {
      if (cmd !== "gh") return { code: 0, out: "", err: "" };
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") return { code: 0, out: JSON.stringify({ state: "OPEN", headRefOid: `sha-${args[2]}` }), err: "" };
      if (args[0] === "pr" && args[1] === "checks") {
        const fail = Number(args[2]) === lower!.pr;
        return { code: fail ? 1 : 0, out: JSON.stringify([{ name: "test", bucket: fail ? "fail" : "pass", link: "https://github.com/acme/app/actions/runs/77/job/1" }]), err: "" };
      }
      return { code: 0, out: "", err: "" };
    };
    const l = new Landing(rt, {
      hub: () => null, deviceId: () => null, github: () => "o", share: async () => null, keys: () => [], feed: () => [], presence: () => [],
      policy: async () => null, exec: fake, rerunSettleMs: 0,
    });
    await l.poll(rt.orchestra.get(run.id)!); // first failure: rerun once
    expect(calls.some((c) => c[0] === "run" && c[1] === "rerun")).toBe(true);
    expect(rt.orchestra.get(run.id)!.landing!.stack).toHaveLength(2);
    const st = await l.poll(rt.orchestra.get(run.id)!); // still failing: fold
    expect(st).toMatchObject({ pr: top!.pr, state: "failing" });
    expect(st.stack).toBeUndefined();
    expect(calls.some((c) => c[0] === "pr" && c[1] === "close" && c[2] === String(lower!.pr))).toBe(true);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "edit" && c[2] === String(top!.pr) && c.includes("--base") && c.includes("main"))).toBe(true);
  });
});

