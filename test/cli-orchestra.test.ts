/**
 * The orchestra and cloud commands, through the real CLI binary against a real
 * daemon. The orchestrator is an echo agent, which never writes a ```loom
 * block — so a run lands in waiting_human, which is exactly the path that
 * needs the CLI most (reply, abort).
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const cli = path.join(root, "src", "cli", "index.ts");

let daemon: LoomDaemon;
let projectDir: string;
let projectId: string;
let client: DaemonClient;

function runCli(args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile(tsx, [cli, ...args], { cwd: projectDir, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) =>
      resolve({ out: stdout + stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-cli-orch");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  projectDir = makeProjectDir({ agents: [{ id: "solo", kind: "echo", role: "worker" }] });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: projectDir });
  git("init", "-q");
  fs.writeFileSync(path.join(projectDir, ".gitignore"), ".loom/\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("loom orchestrate / orchestra", () => {
  it("starts a run, follows it, and shows it", async () => {
    const started = await runCli(["orchestrate", "do the thing", "-o", "solo", "-w", "solo", "-p", "3"]);
    expect(started.out).toContain("solo orchestrating solo (3 in parallel)");
    // echo never answers with actions → the run waits on the human
    expect(started.out).toContain("waiting_human");
    expect(started.out).toContain("asks:");

    const { runs } = await client.orchestraRuns(projectId);
    const runId = runs[0]!.id;
    const list = await runCli(["orchestra"]);
    expect(list.out).toContain(runId);
    expect(list.out).toContain("do the thing");
    const detail = await runCli(["orchestra", runId]);
    expect(detail.out).toContain("orchestrator solo");

    const reply = await runCli(["orchestra:reply", runId, "just finish please"]);
    expect(reply.out).toContain("sent to the orchestrator");
    await waitUntil(async () => (await client.orchestraRun(projectId, runId)).run.round >= 3);

    const aborted = await runCli(["orchestra:abort", runId]);
    expect(aborted.out).toContain(`abort ${runId}`);
    expect((await client.orchestraRun(projectId, runId)).run.status).toBe("aborted");
  });

  it("says why a run can't start", async () => {
    const r = await runCli(["orchestrate", "x", "-o", "nobody", "--no-watch"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no agent "nobody"');
  });
});

describe("loom cloud", () => {
  it("reports status, off by default, ready on Loom's hosted project", async () => {
    // One click: with no project of your own, Cloud relays through the hosted
    // one (ciphertext only), so status names it rather than asking for a URL.
    const r = await runCli(["cloud"]);
    expect(r.out).toContain("Loom Cloud");
    expect(r.out).toContain("off");
    expect(r.out).toMatch(/via https:\/\/\S+\.supabase\.co/);
    expect(r.out).not.toContain("loom cloud enable --url");
  });

  it("fails honestly when you name a project of your own but no key for it", async () => {
    const saved = { url: process.env.LOOM_SUPABASE_URL, key: process.env.LOOM_SUPABASE_ANON_KEY };
    delete process.env.LOOM_SUPABASE_URL;
    delete process.env.LOOM_SUPABASE_ANON_KEY;
    try {
      const r = await runCli(["cloud", "enable", "--url", "https://someone-elses-project.supabase.co"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/Supabase|key/i);
    } finally {
      if (saved.url) process.env.LOOM_SUPABASE_URL = saved.url;
      if (saved.key) process.env.LOOM_SUPABASE_ANON_KEY = saved.key;
    }
  });
});
