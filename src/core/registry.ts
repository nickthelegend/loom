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
import { logbook } from "./logbook.js";
import type {
  AgentConfig,
  AgentRole,
  ChatInfo,
  ProjectConfig,
  ProjectInfo,
  RouteState,
} from "../types.js";

export function loomHome(): string {
  return process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom");
}

export function ensureLoomHome(): string {
  const home = loomHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Read a JSON file, or fall back.
 *
 * The fallback is right for a file that isn't there — a project with no
 * state.json has no state, which is a fact rather than a fault. It is very
 * wrong for a file that IS there and is corrupt: `.loom/config.json` with a
 * trailing comma silently became an empty roster, which looks exactly like
 * "my agents disappeared" and gives you nothing to search for.
 *
 * So: missing is quiet, unreadable is loud. Both still return the fallback —
 * refusing to start because one file is damaged helps nobody — but the second
 * one says so in the Console.
 */
function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback; // not there: nothing to report
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logbook.warn(
      "config",
      `${path.basename(file)} is unreadable — using defaults, so this will look like data went missing`,
      `${file}\n${err instanceof Error ? err.message : String(err)}`,
    );
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
  /** Active (or last) multi-hop route. */
  route?: RouteState;
  /**
   * Named conversations. The main chat is implicit — every project has it and
   * it holds everything written before chats existed, so it isn't stored here.
   * Kept in state rather than derived from the log so a chat you just made,
   * and haven't said anything in yet, still exists.
   */
  chats?: ChatInfo[];
  /** Task cards you wrote yourself. See BoardTask. */
  tasks?: BoardTask[];
}

/**
 * A card you made, as opposed to the ones the board derives from live agents
 * and pull requests. Yours, so its column IS its state — dragging one really
 * moves it, unlike a PR card whose truth belongs to GitHub.
 */
export interface BoardTask {
  id: string;
  title: string;
  /** working | needs-you | in-review | ready — the column it lives in. */
  column: string;
  /** Optional agent this is meant for. */
  agent?: string;
  createdAt: number;
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
  /** Expo push token, when the device registered for notifications. */
  pushToken?: string;
  platform?: string;
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

// buildDefaultRoutes and defaultAgentConfigs live in core/ades.ts now: they are
// answers about ADEs, and asking them here meant registry → ades → an adapter →
// base → registry, a cycle whose module-init order is nobody's friend.
