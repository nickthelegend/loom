/**
 * `loom prompts`, `loom skills` and `loom mcp`: the composer's saved prompts,
 * skills and MCP servers, from the terminal. A real daemon, the real CLI.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon: LoomDaemon;
let client: DaemonClient;
let dir: string;
let pid: string;

function loom(...args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve) =>
    execFile(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "src", "cli", "index.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1" },
    }, (e, so, se) => resolve({ out: so + se, code: e ? Number((e as { code?: number }).code ?? 1) : 0 })),
  );
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-cli-tools");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  dir = tmpDir("cli-tools-proj");
  writeProjectConfig(dir, { name: "tools", agents: [{ id: "alpha", kind: "echo" }], brain: { extractor: "off" } });
  pid = (await client.addProject(dir)).project.id;
});
afterAll(async () => {
  await daemon.close();
});

describe("loom prompts", () => {
  it("saves, lists, pins, renames, sends and removes — the same store the app uses", async () => {
    expect((await loom("prompts")).out).toContain("no saved prompts yet");
    expect((await loom("prompts", "save", "Summarise", "{{project}}", "-t", "sum")).out).toContain("✓ saved sum");
    expect((await client.prompts()).saved.map((p) => p.title)).toEqual(["sum"]);
    await loom("prompts", "pin", "sum");
    await loom("prompts", "rename", "sum", "summary");
    const list = (await loom("prompts", "list")).out;
    expect(list).toContain("★ summary");
    expect((await loom("prompts", "show", "summary")).out.trim()).toBe("Summarise {{project}}");
    expect((await loom("prompts", "send", "summary")).out).toContain('sent "summary" to alpha');
    expect((await client.prompts()).saved[0]!.uses).toBe(1);
    const bad = await loom("prompts", "bogus", "x");
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('unknown action "bogus"');
    await loom("prompts", "rm", "summary");
    expect((await client.prompts()).saved).toEqual([]);
  });
});

describe("loom skills", () => {
  it("installs from a folder, turns it on, lists it, and removes it", async () => {
    const src = path.join(tmpDir("cli-skill-src"), "tidy-diffs");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: tidy-diffs\ndescription: keep diffs small\n---\n\nKeep every diff small.\n");
    expect((await loom("skills", "install", src)).out).toContain("installed and turned on tidy-diffs");
    const list = (await loom("skills")).out;
    expect(list).toMatch(/● tidy-diffs/);
    await loom("skills", "off", "tidy-diffs");
    expect((await loom("skills", "list", "tidy")).out).toMatch(/○ tidy-diffs/);
    expect((await loom("skills", "rm", "tidy-diffs")).out).toContain("removed tidy-diffs");
  });
});

describe("loom mcp", () => {
  it("adds a remote and a local server, toggles one, and removes them", async () => {
    expect((await loom("mcp", "add", "remote", "--url", "http://127.0.0.1:9/mcp", "-H", "Authorization: Bearer x")).out).toContain("added remote");
    expect((await loom("mcp", "add", "local", "--command", "npx", "-y", "some-mcp", "-e", "TOKEN=abc")).out).toContain("it starts when an agent needs it");
    const rows = (await client.mcps(pid, false)).mcps as Array<Record<string, unknown> & { name: string }>;
    expect(rows.find((m) => m.name === "remote")).toMatchObject({ url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer x" } });
    expect(rows.find((m) => m.name === "local")).toMatchObject({ command: "npx", args: ["-y", "some-mcp"], env: { TOKEN: "abc" } });
    await loom("mcp", "off", "remote");
    expect((await loom("mcp")).out).toMatch(/remote\s+off/);
    await loom("mcp", "rm", "remote");
    await loom("mcp", "rm", "local");
    expect((await loom("mcp")).out).toContain("no MCP servers yet");
  });
});
