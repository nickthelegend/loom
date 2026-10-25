/** Peer ask (field): one place for the agents and access every project gets, applied by loom init. */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { planDefaults } from "../src/core/user-defaults.js";
import type { AgentConfig } from "../src/types.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agents = [
  { id: "codex", kind: "codex", role: "codex" },
  { id: "opencode", kind: "opencode", role: "opencode", options: { permissions: "auto" } },
  { id: "grok", kind: "grok-code", role: "grok", permissions: "ask" },
] as unknown as AgentConfig[];

describe("planDefaults", () => {
  it("adds missing kinds that are installed, sets modes only where none was chosen, never removes", () => {
    const plan = planDefaults(agents, { agents: ["codex", "antigravity-cli", "kiro"], mode: "bypass", modes: { "antigravity-cli": "auto" } },
      (k) => k !== "kiro", () => true);
    expect(plan.add).toEqual(["antigravity-cli"]);
    expect(plan.missing).toEqual(["kiro"]);
    expect(plan.modes).toEqual([{ id: "codex", kind: "codex", mode: "bypass" }, { kind: "antigravity-cli", mode: "auto" }]);
  });

  it("does nothing without defaults, and skips kinds that have no access modes", () => {
    expect(planDefaults(agents, {}, () => true, () => true)).toEqual({ add: [], modes: [], missing: [] });
    expect(planDefaults(agents, { mode: "bypass" }, () => true, (k) => k !== "codex").modes).toEqual([]);
  });
});

describe("loom defaults", () => {
  const cli = (home: string, args: string[], cwd?: string) => new Promise<{ out: string; code: number }>((resolve) =>
    execFile(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "cli", "index.ts"), ...args],
      { cwd, env: { ...process.env, LOOM_HOME: home, NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ out: stdout + stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 })));

  it("saves, shows, refuses nonsense, and clears", async () => {
    const home = tmpDir("home-defaults");
    const set = await cli(home, ["defaults", "--agents", "codex,grok-code", "--mode", "bypass", "--mode-for", "codex=auto", "--gitignore", "on", "--json"]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toEqual({ agents: ["codex", "grok-code"], mode: "bypass", modes: { codex: "auto" }, gitignore: true });
    expect(JSON.parse(fs.readFileSync(path.join(home, "defaults.json"), "utf8")).mode).toBe("bypass");
    expect((await cli(home, ["defaults", "--agents", "codexx"])).out).toMatch(/unknown agent kind codexx/);
    expect((await cli(home, ["defaults", "--mode", "yolo"])).out).toMatch(/--mode is bypass, auto or ask/);
    expect(JSON.parse((await cli(home, ["defaults", "--mode", "", "--json"])).out)).not.toHaveProperty("mode");
    expect(JSON.parse((await cli(home, ["defaults", "--clear", "--json"])).out)).toEqual({});
  }, 60_000);

  let daemon: LoomDaemon | undefined;
  afterAll(async () => { await daemon?.close(); });

  it("loom init applies them: a mode for each agent that hadn't chosen one, and a chosen one stays", async () => {
    const home = tmpDir("home-defaults-init");
    process.env.LOOM_HOME = home;
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    const dir = makeProjectDir({ name: "dflt", agents: [{ id: "cx", kind: "codex", role: "worker" }, { id: "oc", kind: "opencode", role: "worker", options: { permissions: "ask" } }] } as never);
    fs.writeFileSync(path.join(home, "defaults.json"), JSON.stringify({ mode: "bypass" }));
    const r = await cli(home, ["init", "--no-gitignore"], dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cx: bypass \(your defaults\)/);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".loom", "config.json"), "utf8")) as { agents: Array<{ id: string; options?: { permissions?: string } }> };
    expect(cfg.agents.find((a) => a.id === "cx")?.options?.permissions).toBe("bypass");
    expect(cfg.agents.find((a) => a.id === "oc")?.options?.permissions).toBe("ask");
  }, 60_000);
});
