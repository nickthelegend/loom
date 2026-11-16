import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "./process.js";
import { readDaemonConfig } from "./registry.js";
import { isWithdrawnKind, knownAgentKinds } from "../adapters/index.js";
import type { AgentConfig, ProjectConfig, ProjectInfo } from "../types.js";

export interface ProjectAgentInput { kind: string; model?: string; count?: number }
export interface NewProjectInput { name: string; agents?: ProjectAgentInput[]; git?: boolean }
export interface CloneProjectInput { url: string; name?: string }
export interface CreatedProject { project: ProjectInfo; config: ProjectConfig }
export interface ProjectCloneJob {
  status: "cloning" | "done" | "failed";
  project?: ProjectInfo;
  error?: string;
  progress?: string;
}

export class ProjectCreationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function projectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ProjectCreationError("name is required");
  return value.trim();
}

export function projectSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  if (!slug) throw new ProjectCreationError("name must contain a letter or number");
  return slug;
}

/** mkdir reserves the name atomically, including against another request. */
export function reserveProjectDirectory(name: string): string {
  const slug = projectSlug(name);
  const root = path.resolve(readDaemonConfig()?.projectsRoot ?? path.join(os.homedir(), "Loom Projects"));
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, slug);
  try { fs.mkdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectCreationError(`project folder already exists: ${dir}`, 409);
    throw error;
  }
  return dir;
}

export function projectAgents(value: unknown): AgentConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProjectCreationError("agents must be an array");
  const agents: AgentConfig[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.kind !== "string") throw new ProjectCreationError("agent kind is required");
    const kind = entry.kind.trim();
    if (!knownAgentKinds().includes(kind) || isWithdrawnKind(kind)) throw new ProjectCreationError(`unknown or unavailable agent kind "${kind}"`);
    const count = entry.count === undefined ? 1 : entry.count;
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new ProjectCreationError("count must be an integer from 1 to 8");
    if (entry.model !== undefined && typeof entry.model !== "string") throw new ProjectCreationError("model must be a string");
    for (let i = 0; i < count; i++) {
      let id = kind, suffix = 2;
      while (agents.some((a) => a.id === id)) id = `${kind}-${suffix++}`;
      agents.push({ id, kind, role: kind, ...(entry.model !== undefined ? { options: { model: entry.model } } : {}) });
    }
  }
  return agents;
}

export function parseProjectAgent(spec: string): ProjectAgentInput {
  const match = /^([^@×]+?)(?:@(.+?))?(?:[x×]([0-9]+))?$/.exec(spec);
  if (!match) throw new ProjectCreationError(`invalid agent "${spec}"; use kind[@model][xN]`);
  const agent = { kind: match[1]!, ...(match[2] ? { model: match[2] } : {}), ...(match[3] ? { count: Number(match[3]) } : {}) };
  projectAgents([agent]);
  return agent;
}

export function cloneSource(value: unknown): { url: string; name: string } {
  if (typeof value !== "string" || !value || /[\s\x00-\x1f]/.test(value)) throw new ProjectCreationError("invalid clone URL");
  let repo: string;
  const scp = /^git@([a-zA-Z0-9.-]+):(.+)$/.exec(value);
  if (scp) repo = scp[2]!;
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw new ProjectCreationError("invalid clone URL"); }
    const fileAllowed = process.env.NODE_ENV === "test" && Boolean(process.env.LOOM_HOME);
    if (!(url.protocol === "https:" || url.protocol === "ssh:" || (url.protocol === "file:" && fileAllowed))) {
      throw new ProjectCreationError("clone URL must use https://, git@, or ssh://");
    }
    if (url.hash || url.search || (url.protocol !== "file:" && !url.hostname)) throw new ProjectCreationError("invalid clone URL");
    try { repo = decodeURIComponent(url.pathname); } catch { throw new ProjectCreationError("invalid clone URL"); }
  }
  return { url: value, name: repo.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "") };
}

/** Stream Git's stderr (where clone progress lives), keeping only its recent output. */
export function projectGit(args: string[], dir: string, opts: { progress?: (text: string) => void; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let output = "", error = "";
    const abort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output = (output + chunk).slice(-16_384); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      error = (error + chunk).slice(-16_384);
      opts.progress?.(error);
    });
    let spawnError: Error | undefined;
    child.on("error", (err) => { spawnError = err; });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) reject(new Error("project creation cancelled: daemon is shutting down"));
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(error.trim() || `git exited with code ${code}`));
      else resolve(output.trim());
    });
  });
}

export async function initializeProject(dir: string, name: string, git: boolean): Promise<void> {
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`, { flag: "wx" });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n", { flag: "wx" });
  if (!git) return;
  await projectGit(["init"], dir);
  const identity: string[] = [];
  for (const [key, fallback] of [["user.name", "Loom"], ["user.email", "loom@localhost"]]) {
    const configured = await projectGit(["config", "--get", key!], dir).catch(() => "");
    if (!configured) identity.push("-c", `${key}=${fallback}`);
  }
  await projectGit(["add", "--", "README.md", ".gitignore"], dir);
  await projectGit([...identity, "-c", "commit.gpgsign=false", "commit", "-m", "Initial commit"], dir);
}
