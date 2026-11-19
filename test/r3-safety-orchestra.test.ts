import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const secret = "AKIAABCDEFGHIJKLMNOP";
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const loom = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";
let repair = false;
let precommit = false;

class Conductor extends AdapterBase {
  private turns = 0;
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send() {
    const turn = this.turns++;
    const actions = turn === 0
      ? [{ type: "spawn", id: "t1", title: "write", agent: "w", prompt: "write" }]
      : repair && turn === 1
        ? [{ type: "send", task: "t1", message: "repair" }]
        : [{ type: "done", summary: "written" }];
    this.emit({ kind: "message", payload: { text: loom(actions) } });
  }
}
class Writer extends AdapterBase {
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() { return ""; }
  async send(input: SendInput) {
    fs.writeFileSync(path.join(this.projectDir, "leak.ts"), input.text === "repair" ? "safe\n" : `${secret}\n`);
    if (precommit) {
      // An external agent can commit independently of Loom's process guard.
      git(this.projectDir, "add", "leak.ts");
      git(this.projectDir, "-c", "user.name=w", "-c", "user.email=w@w", "commit", "-qm", "worker commit");
    }
    this.emit({ kind: "message", payload: { text: "done" } });
  }
}
registerAgentKind("safety-conductor", (cfg, dir) => new Conductor(cfg.id, "safety-conductor", dir));
registerAgentKind("safety-writer", (cfg, dir) => new Writer(cfg.id, "safety-writer", dir));

let rt: ProjectRuntime | undefined;
const previousHome = process.env.LOOM_HOME;
afterEach(async () => {
  await rt?.close(); rt = undefined;
  if (previousHome === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = previousHome;
});

async function run(fix = false, committed = false) {
  repair = fix; precommit = committed;
  process.env.LOOM_HOME = tmpDir("safety-orchestra-home");
  process.env.LOOM_NO_NOTIFY = "1";
  const dir = makeProjectDir({ agents: [
    { id: "c", kind: "safety-conductor", role: "orchestrator" },
    { id: "w", kind: "safety-writer", role: "worker" },
  ] });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git(dir, "add", ".gitignore");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  rt = await ProjectRuntime.open({ id: path.basename(dir), name: "safety", dir });
  const started = await rt.orchestra.start({ goal: "write a file", orchestrator: "c", workers: ["w"] });
  await waitUntil(() => ["completed", "failed"].includes(rt!.orchestra.get(started.id)!.status));
  return { run: rt.orchestra.get(started.id)!, dir };
}

it.each([false, true])("fails a run when its orchestrator says done after a blocked Git operation (precommitted: %s)", async committed => {
  const { run: result, dir } = await run(false, committed);
  expect(result.status).toBe("failed");
  expect(result.error).toBe("secrets in the run's changes — not applied");
  expect(result.tasks[0]!.status).toBe("failed");
  expect(result.tasks[0]!.secrets).toEqual([{ file: "leak.ts", line: 1, what: "what looks like a secret key" }]);
  expect(JSON.stringify(result.tasks[0]!.secrets)).not.toContain(secret);
  expect(git(dir, "diff", `${result.baseCommit}..${result.branch}`)).toBe("");
  expect(fs.existsSync(path.join(dir, "leak.ts"))).toBe(false);
  expect(result.applied).toBeUndefined();
  // Findings survive persistence, even though the integration diff is empty.
  await rt!.close();
  rt = await ProjectRuntime.open({ id: path.basename(dir), name: "safety", dir });
  expect(rt.orchestra.get(result.id)!.tasks[0]!.secrets).toEqual(result.tasks[0]!.secrets);
});

it("allows completion after a worker removes the secret and passes the guarded retry", async () => {
  const { run: result, dir } = await run(true);
  expect(result.status).toBe("completed");
  expect(result.tasks[0]!.attempts).toBe(2);
  expect(result.tasks[0]!.secrets).toBeUndefined();
  await rt!.orchestra.apply(result.id);
  expect(fs.readFileSync(path.join(dir, "leak.ts"), "utf8")).toBe("safe\n");
});
