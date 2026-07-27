import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { AgentStatus } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const cli = path.join(root, "src", "cli", "index.ts");

let daemon: LoomDaemon;
let projectDir: string;

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tsx, [cli, ...args], { cwd: projectDir, env: process.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-cli-agents");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();

  projectDir = makeProjectDir({
    agents: [{ id: "machine", kind: "echo", role: "executor" }],
  });
  await new DaemonClient(readDaemonConfig()!).addProject(projectDir);
});

afterAll(async () => {
  await daemon.close();
});

describe("loom agents --json", () => {
  it("prints the current roster as machine-readable JSON", async () => {
    const agents = JSON.parse(await runCli(["agents", "--json"])) as AgentStatus[];

    expect(agents).toEqual([
      expect.objectContaining({
        id: "machine",
        kind: "echo",
        role: "executor",
        tier: "adapter",
        available: true,
        busy: false,
        holdsBaton: false,
      }),
    ]);
  });
});
