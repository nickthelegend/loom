import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { ensureDaemonConfig, listProjects, readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { tmpDir, waitUntil } from "./helpers.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("loom try --no-open starts its own daemon in a temporary LOOM_HOME and reuses its demo", async () => {
  const home = tmpDir("home-try-cli");
  vi.stubEnv("LOOM_HOME", home);
  const projectsRoot = tmpDir("try-cli-projects");
  // Port zero keeps even the cold-start test away from a user's real daemon.
  writeDaemonConfig({ ...ensureDaemonConfig({ host: "127.0.0.1", port: 0 }), projectsRoot });
  const cli = (args: string[]) => exec(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], {
    cwd: tmpDir("try-cli-outside"),
    env: { ...process.env, LOOM_NO_NOTIFY: "1", LOOM_DEMO_DURATION_MS: "0", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  try {
    const { stdout } = await cli(["try", "--no-open"]);
    const cfg = readDaemonConfig()!;
    expect(cfg.port).toBeGreaterThan(0);
    expect(cfg.pid).not.toBe(process.pid);
    const [project] = listProjects();
    expect(project!.dir).toBe(path.join(projectsRoot, "loom-demo"));
    expect(stdout).toContain(`http://127.0.0.1:${cfg.port}/app?tour=1#p/${project!.id}`);
    expect(stdout).toContain("demo-1@demo-smart");
    expect(stdout).toContain("demo-3@demo-smart");
    expect(stdout).toContain("loom log");
    const client = new DaemonClient(cfg);
    await client.send(project!.id, "add dark mode", "demo-1");
    await waitUntil(async () => (await client.events(project!.id)).events.some(e => e.kind === "turn_diff"));
    expect(fs.readFileSync(path.join(project!.dir, "styles.css"), "utf8")).toContain("prefers-color-scheme: dark");
    const again = await cli(["try", "--no-open"]);
    expect(again.stdout).toContain(project!.id);
    expect(listProjects()).toHaveLength(1);
    await expect(cli(["try", "--no-open", "--agents", "0"])).rejects.toThrow("agents must be an integer");
  } finally {
    const pid = readDaemonConfig()?.pid;
    if (pid && pid !== process.pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
      await waitUntil(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      });
    }
    vi.unstubAllEnvs();
  }
});
