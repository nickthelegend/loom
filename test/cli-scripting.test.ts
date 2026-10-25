/**
 * The CLI as something a script drives (#254, #256, #258): `loom send --wait`
 * blocks until the turn ends and says how in its exit code; `loom init` offers
 * to keep .loom/ out of git; `loom ask` refuses up front when a provider has
 * no key, instead of opening threads that each fail.
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { providerOfModel } from "../src/core/providers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { exitCodeFor, turnOutcome } from "../src/core/turn-wait.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, agentId = "a", chat?: string): LoomEvent =>
  ({ id: ++n, ts: 0, kind, agentId, ...(chat ? { chat } : {}), payload } as LoomEvent);

describe("how a turn ended", () => {
  it("reads the reply, the cost and the status after the send", () => {
    n = 10;
    const before = ev("message", { text: "an older reply" });
    const after = [ev("message", { text: "thinking…", reasoning: true }), ev("message", { text: "Done." }), ev("message", { text: "other" }, "b"),
      ev("status", { state: "turn_cost", costUsd: 0.02 }), ev("run_complete", { durationMs: 1500 })];
    expect(turnOutcome([before, ...after], "a", before.id)).toEqual({ status: "ok", agent: "a", reply: "Done.", costUsd: 0.02, durationMs: 1500 });
    expect(turnOutcome([before], "a", before.id)).toBeNull(); // still going
    expect(exitCodeFor(turnOutcome([before, ...after], "a", before.id))).toBe(0);
  });

  it("a failure, a question, and a timeout each get their own exit code", () => {
    n = 0;
    const failed = turnOutcome([ev("error", { message: "codex exited 1" })], "a", 0);
    expect(failed).toMatchObject({ status: "error", error: "codex exited 1" });
    expect(turnOutcome([ev("run_complete", { error: "boom" })], "a", 0)).toMatchObject({ status: "error", error: "boom" });
    const asked = turnOutcome([ev("message", { text: "Which?" }), ev("needs_input", { question: "Postgres or SQLite?" }), ev("run_complete", {})], "a", 0);
    expect(asked).toMatchObject({ status: "needs_input", question: "Postgres or SQLite?", reply: "Which?" });
    expect([exitCodeFor(failed), exitCodeFor(asked), exitCodeFor(null)]).toEqual([1, 2, 124]);
  });

  it("only counts the chat it was sent in, when told", () => {
    n = 0;
    expect(turnOutcome([ev("run_complete", {}, "a", "side")], "a", 0, "main")).toBeNull();
    expect(turnOutcome([ev("run_complete", {}, "a")], "a", 0, "main")).toMatchObject({ status: "ok" });
  });

  it("knows which provider a model id goes to, the way the daemon does", () => {
    const known = new Set(["openrouter", "groq", "ollama"]);
    expect(providerOfModel("groq/llama-3.3-70b", known)).toBe("groq");
    expect(providerOfModel("meta-llama/llama-3.3-70b:free", known)).toBe("openrouter");
    expect(providerOfModel("gpt-5", known)).toBe("openrouter");
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli", "index.ts");
let daemon: LoomDaemon;
let projectDir: string;

function runCli(args: string[], cwd = projectDir): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), cli, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1", OPENROUTER_API_KEY: "" } }, (err, stdout, stderr) =>
        resolve({ out: stdout, err: stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-cli-scripting");
  process.env.LOOM_NO_NOTIFY = "1";
  delete process.env.OPENROUTER_API_KEY;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  projectDir = makeProjectDir({ agents: [{ id: "solo", kind: "echo" }], brain: { extractor: "off" } } as never);
  await new DaemonClient(readDaemonConfig()!).addProject(projectDir);
});

afterAll(async () => { await daemon.close(); });

describe("loom send --wait", () => {
  it("prints the reply and exits 0 when the turn is done", async () => {
    const r = await runCli(["send", "--wait", "hello there"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("echo(solo): hello there");
    expect(r.err).toMatch(/✓ solo/);
  });

  it("--json is one object a script can parse", async () => {
    const r = await runCli(["send", "--wait", "--json", "again"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: "ok", agent: "solo", reply: "echo(solo): again", costUsd: 0.001 });
  });

  it("exits 1 on a failed turn, 2 on a question, 124 on a timeout", async () => {
    const failed = await runCli(["send", "--wait", "fail:the CLI crashed"]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("the CLI crashed");
    const asked = await runCli(["send", "--wait", "--json", "ask: Postgres or SQLite?"]);
    expect(asked.code).toBe(2);
    expect(JSON.parse(asked.out)).toMatchObject({ status: "needs_input", question: "Postgres or SQLite?" });
    const slow = await runCli(["send", "--wait", "--timeout", "1", "--json", "slow sleep:4000"]);
    expect(slow.code).toBe(124);
    expect(JSON.parse(slow.out)).toEqual({ status: "timeout", agent: "solo" });
  }, 30_000);
});

describe("loom init and .gitignore", () => {
  const repo = () => {
    const dir = tmpDir("init-gitignore");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  };

  it("--gitignore adds .loom/ once, keeping what's there", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules");
    expect((await runCli(["init", "--gitignore"], dir)).out).toContain("added .loom/ to .gitignore");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toMatch(/^node_modules\n# Loom's local state.*\n\.loom\/\n$/);
    await runCli(["init", "--gitignore"], dir);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").match(/\.loom\//g)).toHaveLength(1);
  }, 30_000);

  it("without a terminal to ask, it adds .loom/ (logs and transcripts never belong in the repo); --no-gitignore leaves it alone", async () => {
    const off = repo();
    expect((await runCli(["init", "--no-gitignore"], off)).out).not.toContain(".gitignore");
    expect(fs.existsSync(path.join(off, ".gitignore"))).toBe(false);
    const dir = repo();
    const out = (await runCli(["init"], dir)).out;
    expect(out).toContain("added .loom/ to .gitignore");
    expect(out).toContain("--no-gitignore");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toMatch(/\.loom\/\n$/);
  }, 30_000);
});

describe("outside and inside a project (field feedback)", () => {
  it("loom agents outside a project shows what this machine can drive instead of failing", async () => {
    const out = await runCli(["agents"], tmpDir("not-a-project"));
    expect(out.code).toBe(0);
    expect(out.out).toContain("not in a Loom project");
    expect(out.out).toMatch(/codex|claude-code/);
    expect(out.out).toContain("loom init here");
    const js = JSON.parse((await runCli(["agents", "--json"], tmpDir("not-a-project-json"))).out);
    expect(js.project).toBeNull();
    expect(js.machine.some((a: { kind: string }) => a.kind === "codex")).toBe(true);
  }, 30_000);

  it("loom status inside a project lists that project first and marks it", async () => {
    const out = (await runCli(["status"], projectDir)).out.split("\n").filter((l) => l.trim() && !l.startsWith("daemon"));
    expect(out[0]).toContain("← here");
  }, 30_000);
});

describe("JSON for scripts (#314, #315)", () => {
  it("projects and status print one JSON value on stdout, nothing else", async () => {
    const p = await runCli(["projects", "--json"]);
    expect(p.code).toBe(0);
    expect(JSON.parse(p.out).some((x: { agents: unknown[] }) => Array.isArray(x.agents))).toBe(true);
    const st = await runCli(["status", "--json"]);
    expect(Array.isArray(JSON.parse(st.out))).toBe(true);
  }, 30_000);
});

describe("loom ask", () => {
  it("refuses before sending anything when a provider it needs has no key", async () => {
    const r = await runCli(["ask", "--models", "meta-llama/llama-3.3-70b:free", "what is 2+2"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/openrouter has no key in the daemon — nothing was sent/);
  });
});
