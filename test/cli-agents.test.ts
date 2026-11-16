import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { AgentStatus } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = process.execPath;
const cli = path.join(root, "src", "cli", "index.ts");

let daemon: LoomDaemon;
let projectDir: string;

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tsx, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), cli, ...args], { cwd: projectDir, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }, (err, stdout, stderr) => {
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


describe("chat selection commands", () => {
  it("creates, changes and clears a chat's model and effort", async () => {
    const chat = JSON.parse(await runCli(["chat:create", "review", "--agent", "machine", "--model", "echo-fast", "--effort", "low", "--json"]));
    expect(chat).toMatchObject({ title: "review", agentId: "machine", model: "echo-fast", effort: "low" });
    const changed = JSON.parse(await runCli(["chat:agent", chat.id, "machine", "--model", "echo-deep", "--effort", "high", "--json"]));
    expect(changed).toMatchObject({ model: "echo-deep", effort: "high" });
    const defaults = JSON.parse(await runCli(["chat:agent", "review", "machine", "--json"]));
    expect(defaults.agentId).toBe("machine");
    expect(defaults).not.toHaveProperty("model");
    expect(defaults).not.toHaveProperty("effort");
    const cleared = JSON.parse(await runCli(["chat:agent", chat.id, "--clear", "--json"]));
    expect(cleared).not.toHaveProperty("agentId");
  });
});

describe("loom agents:add", () => {
  it("prints every named session and pins its model, including for non-model kinds", async () => {
    const output = await runCli(["agents:add", "echo", "--as", "opus", "--model", "claude-opus-5-5", "--count", "3", "--role", "worker"]);
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const [i, id] of ["opus", "opus-2", "opus-3"].entries()) {
      expect(lines[i]).toContain(`+ ${id} (echo · worker)`);
      expect(readProjectConfig(projectDir)!.agents.find((a) => a.id === id)).toEqual({
        id, kind: "echo", role: "worker", options: { model: "claude-opus-5-5" },
      });
    }
  });

  it("still adds one session by default", async () => {
    const output = await runCli(["agents:add", "echo", "--as", "solo"]);
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(output).toContain("+ solo (echo · echo)");
  });

  it.each(["0", "9", "1.5", "many"])("rejects --count %s", async (count) => {
    const before = readProjectConfig(projectDir)!.agents;
    await expect(runCli(["agents:add", "echo", "--count", count])).rejects.toThrow(/--count.*integer.*1.*8/);
    expect(readProjectConfig(projectDir)!.agents).toEqual(before);
  });

  it("keeps the model and tool requirements", async () => {
    await expect(runCli(["agents:add", "model", "--count", "3"])).rejects.toThrow(/a model agent needs a model/);
    for (const args of [["--write"], ["--run", "npm test"]]) {
      await expect(runCli(["agents:add", "model", "--model", "test-model", ...args])).rejects.toThrow(/--write and --run need --tools/);
    }
  });
});
