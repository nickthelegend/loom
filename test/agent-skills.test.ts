import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SKILLS_MARKER, AGENT_SKILLS_SIGNATURE, AGENT_SKILLS_VERSION,
  agentSkillsStatus, bundledAgentSkillsDir, installAgentSkills, uninstallAgentSkills, updateManagedAgentSkills,
} from "../src/core/agent-skills.js";
import { tmpDir } from "./helpers.js";

let home: string;
const run = promisify(execFile);
const target = () => path.join(home, ".agents", "skills");
const skill = (id = "loom") => path.join(target(), id);
function oldInstall(id = "loom") {
  fs.mkdirSync(skill(id), { recursive: true });
  fs.writeFileSync(path.join(skill(id), "SKILL.md"), "old instructions");
  fs.writeFileSync(path.join(skill(id), "obsolete.txt"), "remove on update");
  fs.writeFileSync(path.join(skill(id), AGENT_SKILLS_MARKER), AGENT_SKILLS_SIGNATURE + "\n");
}
beforeEach(() => {
  home = tmpDir("agent-skills-home");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("LOOM_HOME", path.join(home, ".loom"));
});
afterEach(() => vi.unstubAllEnvs());

describe("bundled agent skills", () => {
  it("ships seven versioned skills and reports missing installs without writing", () => {
    expect(os.homedir()).toBe(home);
    const status = agentSkillsStatus();
    expect(status.version.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(status.agents.map(a => a.agent)).toEqual(["claude-code", "codex", "grok", "opencode"]);
    expect(status.agents[1]!.dir).toBe(status.agents[3]!.dir);
    for (const agent of status.agents) {
      expect(agent.skills).toHaveLength(7);
      expect(agent.skills.every(s => !s.installed && !s.current && !s.managed)).toBe(true);
    }
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("installs the full set in empty homes, deduplicates shared paths, and is idempotent", () => {
    const result = installAgentSkills();
    expect(result.results).toHaveLength(21);
    expect(result.results.every(r => r.action === "installed")).toBe(true);
    expect(agentSkillsStatus().agents.every(a => a.skills.every(s => s.installed && s.managed && s.current))).toBe(true);
    expect(fs.readFileSync(path.join(skill(), "SKILL.md"), "utf8")).toBe(fs.readFileSync(path.join(bundledAgentSkillsDir, "loom", "SKILL.md"), "utf8"));
    const before = fs.statSync(path.join(skill(), "SKILL.md")).mtimeMs;
    expect(installAgentSkills().results.every(r => r.action === "unchanged")).toBe(true);
    expect(fs.statSync(path.join(skill(), "SKILL.md")).mtimeMs).toBe(before);
  });

  it("updates copies made by install.sh without a version stamp and removes obsolete files", () => {
    oldInstall();
    expect(agentSkillsStatus({ agents: ["codex"] }).agents[0]!.skills.find(s => s.id === "loom")).toMatchObject({ installed: true, managed: true, current: false, version: null });
    expect(installAgentSkills({ agents: ["codex"] }).results.find(r => r.id === "loom")!.action).toBe("updated");
    expect(fs.existsSync(path.join(skill(), "obsolete.txt"))).toBe(false);
    expect(fs.existsSync(path.join(skill(), AGENT_SKILLS_VERSION))).toBe(true);
  });

  it("refuses unmanaged folders on install and uninstall while processing managed siblings", () => {
    oldInstall("loom-agents");
    fs.mkdirSync(skill(), { recursive: true });
    fs.writeFileSync(path.join(skill(), "SKILL.md"), "mine");
    fs.writeFileSync(path.join(skill(), AGENT_SKILLS_MARKER), "not the installer signature");
    expect(installAgentSkills({ agents: ["codex"] }).results.find(r => r.id === "loom")).toMatchObject({ action: "conflict" });
    const removed = uninstallAgentSkills({ agents: ["opencode"] });
    expect(removed.results.filter(r => r.action === "removed")).toHaveLength(6);
    expect(removed.results.find(r => r.id === "loom")).toMatchObject({ action: "conflict" });
    expect(fs.readFileSync(path.join(skill(), "SKILL.md"), "utf8")).toBe("mine");
    expect(fs.readdirSync(target())).toEqual(["loom"]);
  });

  it("never follows a destination symlink or a marker symlink to claim ownership", () => {
    const outside = tmpDir("unmanaged-skill");
    fs.writeFileSync(path.join(outside, "SKILL.md"), "outside");
    fs.writeFileSync(path.join(outside, AGENT_SKILLS_MARKER), AGENT_SKILLS_SIGNATURE);
    fs.mkdirSync(target(), { recursive: true });
    fs.symlinkSync(outside, skill(), process.platform === "win32" ? "junction" : "dir");
    oldInstall("loom-agents");
    const marker = path.join(skill("loom-agents"), AGENT_SKILLS_MARKER);
    fs.rmSync(marker);
    fs.symlinkSync(path.join(outside, AGENT_SKILLS_MARKER), marker);
    for (const change of [installAgentSkills, uninstallAgentSkills]) {
      const results = change({ agents: ["codex"] }).results;
      expect(results.find(r => r.id === "loom")!.action).toBe("conflict");
      expect(results.find(r => r.id === "loom-agents")!.action).toBe("conflict");
    }
    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("outside");
    expect(fs.lstatSync(skill()).isSymbolicLink()).toBe(true);
  });

  it("refuses files and dangling links with the same name", () => {
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(skill(), "mine");
    fs.symlinkSync(path.join(home, "missing"), skill("loom-agents"), process.platform === "win32" ? "junction" : "dir");
    for (const change of [installAgentSkills, uninstallAgentSkills]) {
      const result = change({ agents: ["codex"] });
      expect(result.results.filter(r => r.action === "conflict")).toHaveLength(2);
    }
    expect(agentSkillsStatus().agents[1]!.skills.find(s => s.id === "loom")).toMatchObject({ installed: false, managed: false });
    expect(fs.readFileSync(skill(), "utf8")).toBe("mine");
  });

  it("dry-run install, update and uninstall write nothing", () => {
    expect(installAgentSkills({ dryRun: true }).results.every(r => r.action === "installed")).toBe(true);
    expect(fs.readdirSync(home)).toEqual([]);
    oldInstall();
    const before = fs.readdirSync(skill());
    expect(installAgentSkills({ agents: ["codex"], dryRun: true }).results[0]!.action).toBe("updated");
    expect(uninstallAgentSkills({ dryRun: true }).results.some(r => r.action === "removed")).toBe(true);
    expect(fs.readdirSync(skill())).toEqual(before);
    expect(fs.readFileSync(path.join(skill(), "SKILL.md"), "utf8")).toBe("old instructions");
    expect(fs.readdirSync(target())).toEqual(["loom"]);
    expect(fs.readdirSync(home)).toEqual([".agents"]);
  });

  it("startup refresh touches only existing managed outdated copies and never downgrades", () => {
    oldInstall();
    oldInstall("loom-agents");
    fs.writeFileSync(path.join(skill("loom-agents"), AGENT_SKILLS_VERSION), JSON.stringify({ revision: "newer", committedAt: "2099-01-01T00:00:00Z" }));
    fs.mkdirSync(skill("loom-ops"));
    fs.writeFileSync(path.join(skill("loom-ops"), "SKILL.md"), "mine");
    expect(updateManagedAgentSkills().results).toEqual([{ dir: target(), id: "loom", action: "updated" }]);
    expect(fs.readFileSync(path.join(skill("loom-agents"), "SKILL.md"), "utf8")).toBe("old instructions");
    expect(fs.readFileSync(path.join(skill("loom-ops"), "SKILL.md"), "utf8")).toBe("mine");
    expect(fs.readdirSync(target())).toHaveLength(3);
    expect(fs.readdirSync(home)).toEqual([".agents"]);
  });

  it("supports custom destinations without installing to default roots", () => {
    const custom = path.join(home, "custom skills");
    expect(installAgentSkills({ targets: [custom, custom] }).results).toHaveLength(7);
    const status = agentSkillsStatus({ targets: [custom] });
    expect(status.agents).toHaveLength(5);
    expect(status.agents[4]!.skills.every(s => s.current)).toBe(true);
    expect(fs.readdirSync(home)).toEqual(["custom skills"]);
    expect(uninstallAgentSkills({ targets: [custom] }).results.every(r => r.action === "removed")).toBe(true);
  });

  it("reports per-skill filesystem failures without destroying other destinations", () => {
    const blocked = path.join(home, "blocked");
    fs.writeFileSync(blocked, "file");
    const result = installAgentSkills({ agents: ["codex"], targets: [blocked] });
    expect(result.results.filter(r => r.action === "installed")).toHaveLength(7);
    expect(result.results.filter(r => r.action === "error")).toHaveLength(7);
    expect(fs.readFileSync(blocked, "utf8")).toBe("file");
  });
});

describe("agent skills CLI without a daemon or project", () => {
  const cli = (...args: string[]) => run(process.execPath, ["--import", "tsx", "src/cli/index.ts", "skills", ...args], {
    env: { ...process.env, NO_COLOR: "1" }, timeout: 20_000,
  });
  it("reports status, previews, installs, updates and removes a selected agent's skills", async () => {
    const status = JSON.parse((await cli("agents", "--json")).stdout);
    expect(status.agents).toHaveLength(4);
    expect((await cli("install", "loom", "--agent", "codex", "--dry-run")).stdout).toContain("Dry run: no files changed");
    expect(fs.readdirSync(home)).toEqual([]);
    const installed = JSON.parse((await cli("install", "loom", "--agent", "opencode", "--json")).stdout);
    expect(installed.results).toHaveLength(7);
    fs.rmSync(path.join(skill(), AGENT_SKILLS_VERSION));
    expect((await cli("install", "loom", "--agent", "codex")).stdout).toContain("updated");
    expect((await cli("uninstall", "loom", "--agent", "codex")).stdout).toContain("removed");
    expect(fs.readdirSync(target())).toEqual([]);
    expect(fs.existsSync(path.join(home, ".loom", "daemon.json"))).toBe(false);
  });
  it("rejects invalid agents, returns a nonzero conflict exit, and supports custom targets", async () => {
    await expect(cli("install", "loom", "--agent", "unknown")).rejects.toMatchObject({ code: 1 });
    expect(fs.readdirSync(home)).toEqual([]);
    const custom = path.join(home, "custom");
    fs.mkdirSync(path.join(custom, "loom"), { recursive: true });
    fs.writeFileSync(path.join(custom, "loom", "SKILL.md"), "mine");
    await expect(cli("install", "loom", "--target", custom, "--force")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("refusing unmanaged") });
    const status = JSON.parse((await cli("agents", "--target", custom, "--json")).stdout);
    expect(status.agents[4].skills.find((s: { id: string }) => s.id === "loom")).toMatchObject({ installed: true, current: false, managed: false });
    expect(fs.readFileSync(path.join(custom, "loom", "SKILL.md"), "utf8")).toBe("mine");
  });
});
