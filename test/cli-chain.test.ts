/**
 * #340: goals across several projects, one after another — each completed run scanned for
 * secrets and merged before the next starts. Real CLI against a real daemon; the orchestrator
 * is scripted (registered in this process, which hosts the daemon) and the worker writes files.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { findSecrets } from "../src/core/secret-scan.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";

/** Plans one task that writes what the goal names ("write <file> <content…>"), then finishes. */
class Conductor extends AdapterBase {
  private turns = 0;
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send(input: SendInput) {
    this._busy = true;
    const goal = /The goal: (.+)/.exec(`${input.briefing ?? ""}\n${input.text}`)?.[1] ?? input.text;
    const m = /write (\S+) (.+)/.exec(goal);
    const text = this.turns++ === 0 && m
      ? loom([{ type: "spawn", id: "t1", title: "write", agent: "w", prompt: `put:${m[1]}:${m[2]}`, touches: [m[1]] }])
      : loom([{ type: "done", summary: "written" }]);
    this.emit({ kind: "message", payload: { text } });
    this._busy = false;
  }
}
class Writer extends AdapterBase {
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send(input: SendInput) {
    this._busy = true;
    const m = /put:([^:]+):(.+)/.exec(input.text);
    if (m) {
      fs.writeFileSync(path.join(this.projectDir, m[1]!), `${m[2]}\n`);
      this.emit({ kind: "file_edit", payload: { path: m[1] } });
    }
    this.emit({ kind: "message", payload: { text: "done" } });
    this._busy = false;
  }
}
registerAgentKind("chain-conductor", (cfg, dir) => new Conductor(cfg.id, "chain-conductor", dir));
registerAgentKind("chain-writer", (cfg, dir) => new Writer(cfg.id, "chain-writer", dir));

let daemon: LoomDaemon;
const dirs: Record<string, string> = {};

function project(name: string): string {
  const dir = makeProjectDir({ name, agents: [{ id: "c", kind: "chain-conductor", role: "orchestrator" }, { id: "w", kind: "chain-writer", role: "worker" }], brain: { extractor: "off" } } as never);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  return dir;
}

function runCli(args: string[], input?: string): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "cli", "index.ts"), ...args],
      { cwd: dirs.a, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ out: stdout + stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
    if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-cli-chain");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const client = new DaemonClient(readDaemonConfig()!);
  for (const n of ["a", "b", "c"]) { dirs[n] = project(`chain-${n}`); await client.addProject(dirs[n]!); }
}, 60_000);

afterAll(async () => { await daemon.close(); });

describe("secrets in a diff", () => {
  it("finds keys, hard-coded credentials and secret files; not example files", () => {
    const diff = [
      "+++ b/src/aws.ts", "@@ -0,0 +1,2 @@", "+const ok = 1;", "+const key = \"AKIAABCDEFGHIJKLMNOP\";",
      "+++ b/config.ts", "@@ -3,0 +4,1 @@", "+password = \"hunter2hunter\"",
      "+++ b/.env", "@@ -0,0 +1 @@", "+X=1",
      "+++ b/.env.example", "@@ -0,0 +1 @@", "+X=",
    ].join("\n");
    expect(findSecrets(diff)).toEqual([
      { file: "src/aws.ts", line: 2, what: "what looks like a secret key" },
      { file: "config.ts", line: 4, what: "a hard-coded credential" },
      { file: ".env", what: "a file that holds secrets by its name" },
    ]);
  });
});

describe("loom chain (#340)", () => {
  it("runs each project's goal, merges a clean run, and stops at one with a secret", async () => {
    const plan = [
      "# one per line",
      "chain-a :: write hello.txt hi there",
      "chain-b :: write leak.ts AKIAABCDEFGHIJKLMNOP",
      "chain-c :: write never.txt not reached",
    ].join("\n");
    const r = await runCli(["chain", "--json"], plan);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(out.ok).toBe(false);
    expect(out.steps.map((s: { project: string; ok: boolean }) => [s.project, s.ok])).toEqual([["chain-a", true], ["chain-b", false]]);
    expect(out.steps[1].secrets[0]).toMatchObject({ file: "leak.ts", what: "what looks like a secret key" });
    // a's run is on a's branch now; b's isn't; c never ran
    expect(fs.readFileSync(path.join(dirs.a!, "hello.txt"), "utf8")).toBe("hi there\n");
    expect(fs.existsSync(path.join(dirs.b!, "leak.ts"))).toBe(false);
    expect(fs.existsSync(path.join(dirs.c!, "never.txt"))).toBe(false);
  }, 120_000);

  it("--keep-going carries on past a failure, and an unknown project says so", async () => {
    const r = await runCli(["chain", "--json", "--keep-going"], "nope :: anything\nchain-c :: write two.txt second\n");
    const out = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(out.steps.map((s: { project: string; ok: boolean }) => [s.project, s.ok])).toEqual([["nope", false], ["chain-c", true]]);
    expect(out.steps[0].error).toMatch(/no project "nope"/);
    expect(fs.readFileSync(path.join(dirs.c!, "two.txt"), "utf8")).toBe("second\n");
  }, 120_000);

  it("--progress prints one line per task event as each run goes", async () => {
    const r = await runCli(["chain", "--progress"], "chain-c :: write three.txt third\n");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/chain-c t1 planned for w: write/);
    expect(r.out).toMatch(/chain-c t1 \[w\] done — 1 file/);
    expect(r.out).toMatch(/chain-c \S+ completed/);
  }, 120_000);

  it("run options apply to every line, and a line's own [ … ] wins (no claude-code planning unless asked)", async () => {
    const r = await runCli(["chain", "--json", "-p", "3"], "chain-a :: [-o c -w w -p 2] write opts.txt chosen\n");
    expect(r.code).toBe(0);
    const client = new DaemonClient(readDaemonConfig()!);
    const { projects } = await client.listProjects();
    const id = projects.find((p) => p.name === "chain-a")!.id;
    const run = (await client.orchestraRuns(id)).runs.find((x) => x.goal.includes("opts.txt"))!;
    expect(run.orchestrator.agent).toBe("c");
    expect(run.workers).toEqual(["w"]);
    expect(run.maxParallel).toBe(2);
    const bad = await runCli(["chain"], "chain-a :: [--nope] write z.txt z\n");
    expect(bad.code).not.toBe(0);
    expect(bad.out).toMatch(/unknown run option --nope/);
  }, 120_000);
});
