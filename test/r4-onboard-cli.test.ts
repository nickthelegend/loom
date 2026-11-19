import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";
import { helpGuides } from "../src/core/help/catalog.js";
import { tutorialProgress } from "../src/core/help/tutorial.js";
import { registerR4Onboard, tutorialSession } from "../src/cli/r4-onboard.js";
import { tmpDir, makeProjectDir } from "./helpers.js";
let daemon: LoomDaemon, client: DaemonClient, project: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-cli-home"); process.env.LOOM_NO_NOTIFY = "1"; process.env.LOOM_DEMO_DURATION_MS = "50";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, setup: { agents: async () => [] } }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!);
  const cfg = readDaemonConfig()!; cfg.projectsRoot = tmpDir("r4-cli-projects"); writeDaemonConfig(cfg);
  project = (await client.addProject(makeProjectDir())).project.id;
});
afterAll(async () => { await daemon.close(); });
async function cli(...args: string[]) {
  const program = new Command(); registerR4Onboard(program, { ensureDaemon: async () => client, currentProject: async () => ({ id: project }) });
  const output: string[] = []; const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => { output.push(String(s)); });
  try { await program.parseAsync(args, { from: "user" }); return output.join("\n"); } finally { log.mockRestore(); }
}
it("registers guide without replacing Commander's help, and prints installed release highlights", async () => {
  expect(await cli("guide")).toContain("getting-started"); expect(await cli("guide", "templates")).toContain("--template");
  await expect(cli("guide", "does-not-exist")).rejects.toThrow("no guide");
  expect(await cli("whatsnew")).toContain("Show me: loom guide");
});
it("prints readiness JSON and installs examples through the daemon", async () => {
  const report = JSON.parse(await cli("ready", "--json", "--fix")); expect(report.applied).toHaveLength(2); expect(report.score).toBe(60);
  expect(await cli("examples")).toContain("daily-review"); expect(await cli("examples", "install", "daily-review")).toContain("disabled");
  expect(await cli("examples", "install", "small-change")).toContain("Installed"); expect(await cli("examples", "install", "small-change")).toContain("Already installed");
});
it("runs the interactive tutorial, quits, resumes only missing lessons, and saves actual completion", async () => {
  let answer = 0; const output: string[] = [];
  await tutorialSession(client, false, async () => ++answer === 1 ? "" : "q", s => output.push(s));
  expect(tutorialProgress().completed).toEqual(["send"]);
  output.length = 0;
  await tutorialSession(client, true, async () => "", s => output.push(s));
  expect(tutorialProgress().completed).toEqual(["send", "steer", "fleet", "memory"]);
  expect(output.join("\n")).toContain("copper lantern"); expect(output.join("\n")).toContain("Steering received");
  expect(output.join("\n")).not.toContain("Send a request"); expect(output.at(-1)).toContain("Tutorial complete");
});
it("extends the existing init command with directory templates without changing its normal action", async () => {
  const source = tmpDir("r4-cli-source"); fs.writeFileSync(path.join(source, "copied.txt"), "copied");
  const destination = tmpDir("r4-cli-dest");
  // A child changes cwd without racing the daemon's other tests. This is the real CLI, pointed only at the isolated test daemon.
  fs.mkdirSync(path.join(destination, ".loom")); fs.writeFileSync(path.join(destination, ".loom", "config.json"), JSON.stringify({ name: "template-cli", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } }));
  const script = path.resolve("src/cli/index.ts"); const tsx = import.meta.resolve("tsx");
  const child = spawn(process.execPath, ["--import", tsx, script, "init", "--template", source, "--gitignore"], { cwd: destination, env: { ...process.env, LOOM_AUTO_RESTART: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(output).toContain("template-cli"); expect(code, output).toBe(0); expect(fs.readFileSync(path.join(destination, "copied.txt"), "utf8")).toBe("copied");
});

it("runs loom try --scenario through the existing CLI entry point with only Demo agents", async () => {
  const script = path.resolve("src/cli/index.ts"), tsx = import.meta.resolve("tsx");
  const child = spawn(process.execPath, ["--import", tsx, script, "try", "--scenario", "review", "--no-open"], { env: { ...process.env, LOOM_AUTO_RESTART: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(code, output).toBe(0);
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  expect(result.scenario).toBe("review"); expect(result.review.agents).toEqual(["demo-1", "demo-2"]);
});

it("opens every listed guide id as exactly one guide, while retaining word search", async () => {
  const ids = (await cli("guide")).split("\n").map(line => line.split(" — ")[0]);
  expect(ids).toEqual(helpGuides().map(g => g.id));
  for (const id of ids) expect(await cli("guide", id!)).toBe(helpGuides().find(g => g.id === id)!.body);
  expect(await cli("guide", "offline memory")).toContain("Brain");
});
