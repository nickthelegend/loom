/**
 * Loom home (~/.loom) — project registry, daemon config, and per-project
 * .loom/ config/state files.
 *
 * LOOM_HOME env var overrides the home directory (used heavily by tests).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, ProjectConfig, ProjectInfo } from "../types.js";

export function loomHome(): string {
  return process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom");
}

export function ensureLoomHome(): string {
  const home = loomHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : {});
}

export function newId(bytes = 6): string {
  return crypto.randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Registry (~/.loom/registry.json)
// ---------------------------------------------------------------------------

interface RegistryFile {
  projects: ProjectInfo[];
}

function registryFile(): string {
  return path.join(loomHome(), "registry.json");
}

export function listProjects(): ProjectInfo[] {
  return readJson<RegistryFile>(registryFile(), { projects: [] }).projects;
}

export function findProject(idOrDirOrName: string): ProjectInfo | undefined {
  const projects = listProjects();
  const dir = path.resolve(idOrDirOrName);
  return projects.find(
    (p) => p.id === idOrDirOrName || p.name === idOrDirOrName || path.resolve(p.dir) === dir,
  );
}

export function registerProject(dir: string, name: string): ProjectInfo {
  ensureLoomHome();
  const reg = readJson<RegistryFile>(registryFile(), { projects: [] });
  const resolved = path.resolve(dir);
  const existing = reg.projects.find((p) => path.resolve(p.dir) === resolved);
  if (existing) return existing;
  const info: ProjectInfo = { id: newId(), name, dir: resolved };
  reg.projects.push(info);
  writeJson(registryFile(), reg);
  return info;
}

export function unregisterProject(id: string): void {
  const reg = readJson<RegistryFile>(registryFile(), { projects: [] });
  reg.projects = reg.projects.filter((p) => p.id !== id);
  writeJson(registryFile(), reg);
}

// ---------------------------------------------------------------------------
// Per-project files (<dir>/.loom/…)
// ---------------------------------------------------------------------------

export function projectLoomDir(projectDir: string): string {
  return path.join(projectDir, ".loom");
}

export function readProjectConfig(projectDir: string): ProjectConfig | null {
  const file = path.join(projectLoomDir(projectDir), "config.json");
  if (!fs.existsSync(file)) return null;
  return readJson<ProjectConfig>(file, { name: path.basename(projectDir), agents: [] });
}

export function writeProjectConfig(projectDir: string, cfg: ProjectConfig): void {
  writeJson(path.join(projectLoomDir(projectDir), "config.json"), cfg);
}

/** Mutable per-project state: baton holder + adapter session state. */
export interface ProjectState {
  holder: string | null;
  holderSince?: number;
  agents: Record<string, Record<string, unknown>>;
}

export function readProjectState(projectDir: string): ProjectState {
  return readJson<ProjectState>(path.join(projectLoomDir(projectDir), "state.json"), {
    holder: null,
    agents: {},
  });
}

export function writeProjectState(projectDir: string, state: ProjectState): void {
  writeJson(path.join(projectLoomDir(projectDir), "state.json"), state);
}

/** Namespaced memory file Loom manages for an agent. Never a user file. */
export function memoryFile(projectDir: string, agentId: string): string {
  return path.join(projectLoomDir(projectDir), "memory", `${agentId}.md`);
}

export function writeMemoryFile(projectDir: string, agentId: string, content: string): string {
  const file = memoryFile(projectDir, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// Daemon config (~/.loom/daemon.json)
// ---------------------------------------------------------------------------

export interface PairedClient {
  id: string;
  name: string;
  token: string;
  createdAt: number;
}

export interface DaemonConfig {
  host: string;
  port: number;
  adminToken: string;
  clients: PairedClient[];
  pid?: number;
}

export function daemonConfigFile(): string {
  return path.join(loomHome(), "daemon.json");
}

export function readDaemonConfig(): DaemonConfig | null {
  const file = daemonConfigFile();
  if (!fs.existsSync(file)) return null;
  return readJson<DaemonConfig | null>(file, null);
}

export function writeDaemonConfig(cfg: DaemonConfig): void {
  ensureLoomHome();
  writeJson(daemonConfigFile(), cfg, 0o600);
}

export function ensureDaemonConfig(defaults: { host: string; port: number }): DaemonConfig {
  const existing = readDaemonConfig();
  if (existing) return existing;
  const cfg: DaemonConfig = {
    host: defaults.host,
    port: defaults.port,
    adminToken: crypto.randomBytes(32).toString("hex"),
    clients: [],
  };
  writeDaemonConfig(cfg);
  return cfg;
}

export function defaultAgentConfigs(availability: Record<string, boolean>): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (availability["claude-code"]) {
    agents.push({ id: "claude-code", kind: "claude-code", role: "planner" });
  }
  if (availability["opencode"]) {
    agents.push({ id: "opencode", kind: "opencode", role: "executor" });
  }
  if (agents.length === 0) {
    agents.push({ id: "echo", kind: "echo", role: "general" });
  }
  return agents;
}
