import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_SKILLS_MARKER = ".loom-skills-managed";
export const AGENT_SKILLS_SIGNATURE = "loom-skills installer v1";
export const AGENT_SKILLS_VERSION = ".loom-skills-version.json";
export const agentSkillAgents = ["claude-code", "codex", "grok", "opencode"] as const;
export type SkillAgent = typeof agentSkillAgents[number];
export interface AgentSkillsVersion { revision: string; committedAt: string }
export interface AgentSkillStatus {
  id: string;
  installed: boolean;
  managed: boolean;
  current: boolean;
  /** Null for upstream installs made before Loom recorded versions. */
  version: AgentSkillsVersion | null;
}
export interface AgentSkillsStatus {
  version: AgentSkillsVersion;
  /** Codex and OpenCode report the same directory. Custom CLI targets use agent: "custom". */
  agents: Array<{ agent: SkillAgent | "custom"; dir: string; skills: AgentSkillStatus[] }>;
}
export interface AgentSkillsOptions {
  agents?: SkillAgent[];
  targets?: string[];
  dryRun?: boolean;
}
export interface AgentSkillsResult {
  dryRun: boolean;
  /** One entry per directory/skill, even when multiple agents share that directory. */
  results: Array<{ dir: string; id: string; action: "installed" | "updated" | "removed" | "unchanged" | "conflict" | "error"; error?: string }>;
}

// src/core and dist/core are at the same depth in a checkout and an npm package.
export const bundledAgentSkillsDir = fileURLToPath(new URL("../../skills/agent/", import.meta.url));

function readVersion(file: string): AgentSkillsVersion | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value.revision === "string" && value.revision && typeof value.committedAt === "string" && Number.isFinite(Date.parse(value.committedAt))
      ? { revision: value.revision, committedAt: value.committedAt } : null;
  } catch { return null; }
}

function bundle(): { version: AgentSkillsVersion; ids: string[] } {
  const version = readVersion(path.join(bundledAgentSkillsDir, "version.json"));
  if (!version) throw new Error("bundled agent skills version is missing or invalid");
  const ids = fs.readdirSync(bundledAgentSkillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(bundledAgentSkillsDir, d.name, "SKILL.md")))
    .map(d => d.name).sort();
  if (!ids.length) throw new Error("no bundled agent skills found");
  return { version, ids };
}

export function parseSkillAgents(value: unknown): SkillAgent[] {
  if (!Array.isArray(value) || !value.length || value.some(a => !agentSkillAgents.includes(a))) {
    throw new Error(`agents must be a non-empty array of: ${agentSkillAgents.join(", ")}`);
  }
  return [...new Set(value)] as SkillAgent[];
}

function destinations(opts: AgentSkillsOptions) {
  const roots: Record<SkillAgent, string> = { "claude-code": ".claude", codex: ".agents", grok: ".grok", opencode: ".agents" };
  const agents = opts.agents === undefined ? (opts.targets?.length ? [] : agentSkillAgents) : parseSkillAgents(opts.agents);
  return [
    ...agents.map(agent => ({ agent, dir: path.join(os.homedir(), roots[agent], "skills") })),
    ...(opts.targets ?? []).map(dir => {
      if (!dir.trim()) throw new Error("target directory cannot be empty");
      return { agent: "custom" as const, dir: path.resolve(dir) };
    }),
  ];
}

function stat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (err) { if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return null; throw err; }
}

function isManaged(dir: string, id: string): boolean {
  const entry = stat(dir);
  // Match install.sh: only a link to this exact source is ours, never follow
  // arbitrary destination links or a link masquerading as a marker file.
  if (entry?.isSymbolicLink()) return fs.readlinkSync(dir) === path.join(bundledAgentSkillsDir, id);
  const marker = path.join(dir, AGENT_SKILLS_MARKER);
  return Boolean(entry?.isDirectory() && stat(marker)?.isFile()
    && fs.readFileSync(marker, "utf8").replace(/\n+$/, "") === AGENT_SKILLS_SIGNATURE);
}

function status(dir: string, id: string, version: AgentSkillsVersion): AgentSkillStatus {
  const dest = path.join(dir, id);
  const managed = isManaged(dest, id);
  const installed = Boolean(stat(path.join(dest, "SKILL.md"))?.isFile());
  const installedVersion = managed ? readVersion(path.join(dest, AGENT_SKILLS_VERSION)) : null;
  return { id, installed, managed, current: installed && managed && installedVersion?.revision === version.revision, version: installedVersion };
}

export function agentSkillsStatus(opts: AgentSkillsOptions = {}): AgentSkillsStatus {
  const { version, ids } = bundle();
  return { version, agents: destinations({ ...opts, agents: opts.agents ?? [...agentSkillAgents] }).map(target => ({
    ...target, skills: ids.map(id => status(target.dir, id, version)),
  })) };
}

/** Shared entry point for CLI, API and the future /api/onboarding skills step.
 * Conflicts/errors are per skill; successful siblings remain installed. Dry runs
 * return the same planned actions without creating even a destination directory.
 */
export function installAgentSkills(opts: AgentSkillsOptions = {}): AgentSkillsResult {
  return changeAgentSkills("install", opts);
}

export function uninstallAgentSkills(opts: AgentSkillsOptions = {}): AgentSkillsResult {
  return changeAgentSkills("uninstall", opts);
}

/** Startup refresh never creates missing installs or downgrades a newer bundle. */
export function updateManagedAgentSkills(): AgentSkillsResult {
  return changeAgentSkills("update", {});
}

function changeAgentSkills(operation: "install" | "uninstall" | "update", opts: AgentSkillsOptions): AgentSkillsResult {
  const { version, ids } = bundle();
  const result: AgentSkillsResult = { dryRun: opts.dryRun ?? false, results: [] };
  for (const dir of new Set(destinations(opts).map(d => d.dir))) {
    for (const id of ids) {
      const dest = path.join(dir, id);
      try {
        const exists = Boolean(stat(dest));
        const managed = exists && isManaged(dest, id);
        if (operation === "update" && !managed) continue;
        if (exists && !managed) {
          result.results.push({ dir, id, action: "conflict", error: `refusing unmanaged entry: ${dest}` });
          continue;
        }
        const current = status(dir, id, version);
        if (operation === "update" && current.version && Date.parse(current.version.committedAt) > Date.parse(version.committedAt)) continue;
        const action = operation === "uninstall" ? (exists ? "removed" : "unchanged")
          : current.current ? "unchanged" : exists ? "updated" : "installed";
        if (!opts.dryRun && action !== "unchanged") {
          if (action === "removed") fs.rmSync(dest, { recursive: true, force: true });
          else {
            fs.mkdirSync(dir, { recursive: true });
            const stage = fs.mkdtempSync(path.join(dir, ".loom-skills-"));
            const copy = path.join(stage, "new"), backup = path.join(stage, "old");
            try {
              fs.cpSync(path.join(bundledAgentSkillsDir, id), copy, { recursive: true });
              fs.writeFileSync(path.join(copy, AGENT_SKILLS_MARKER), AGENT_SKILLS_SIGNATURE + "\n");
              fs.writeFileSync(path.join(copy, AGENT_SKILLS_VERSION), JSON.stringify(version) + "\n");
              if (exists) fs.renameSync(dest, backup);
              try { fs.renameSync(copy, dest); }
              catch (err) { if (exists) fs.renameSync(backup, dest); throw err; }
            } finally { fs.rmSync(stage, { recursive: true, force: true }); }
          }
        }
        result.results.push({ dir, id, action });
      } catch (err) { result.results.push({ dir, id, action: "error", error: (err as Error).message }); }
    }
  }
  return result;
}
