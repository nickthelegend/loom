import { validateAgentOptions } from "../model-routing-settings.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { loomHome } from "../registry.js";
import { isPermissionMode, type PermissionMode } from "../permissions.js";
import { knownAgentKinds } from "../../adapters/index.js";

export interface AgentProfile { name: string; kind: string; model?: string; effort?: string; mode?: PermissionMode; instructions: string }
export interface AgentPolicy { maxTurnMinutes?: number; idleSleepMinutes?: number; retries?: { count: number; waitSeconds: number } }
export interface SessionSettings extends AgentPolicy { autoArchiveDays?: number; agents: Record<string, AgentPolicy> }

function read<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID();
  try { fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
const profilesFile = () => path.join(loomHome(), "agent-profiles.json");
export const profiles = (): AgentProfile[] => read<AgentProfile[]>(profilesFile(), []);
export function saveProfile(name: string, value: unknown): AgentProfile {
  if (!/^[\p{L}\p{N}_. -]{1,60}$/u.test(name)) throw new Error("profile name must be 1–60 letters, numbers, spaces, dots, dashes or underscores");
  const b = value as Partial<AgentProfile>;
  if (!b || typeof b.kind !== "string" || !knownAgentKinds().includes(b.kind)) throw new Error("unknown agent kind");
  for (const key of ["model", "effort", "instructions"] as const) if (b[key] !== undefined && typeof b[key] !== "string") throw new Error(`${key} must be text`);
  if (b.mode !== undefined && !isPermissionMode(b.mode)) throw new Error("mode must be ask, auto or bypass");
  if ((b.instructions?.length ?? 0) > 4000) throw new Error("instructions are too long");
  validateAgentOptions(b.kind, { ...(b.model ? { model: b.model } : {}), ...(b.effort ? { effort: b.effort } : {}), ...(b.mode ? { permissions: b.mode } : {}) });
  const profile: AgentProfile = { name, kind: b.kind, instructions: b.instructions?.trim() ?? "", ...(b.model ? { model: b.model } : {}), ...(b.effort ? { effort: b.effort } : {}), ...(b.mode ? { mode: b.mode } : {}) };
  write(profilesFile(), [...profiles().filter(p => p.name !== name), profile]); return profile;
}
export function removeProfile(name: string): void { write(profilesFile(), profiles().filter(p => p.name !== name)); }
const settingsFile = (dir: string) => path.join(dir, ".loom", "agents-r4.json");
export const sessionSettings = (dir: string): SessionSettings => read(settingsFile(dir), { agents: {} });
export function updateSessionSettings(dir: string, patch: unknown, agent?: string): SessionSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("settings must be an object");
  const b = patch as Record<string, unknown>, clean: AgentPolicy & { autoArchiveDays?: number } = {};
  for (const key of Object.keys(b)) {
    if (!["maxTurnMinutes", "idleSleepMinutes", "retries", ...(!agent ? ["autoArchiveDays"] : [])].includes(key)) throw new Error(`unknown setting ${key}`);
    if (key === "retries") {
      const r = b.retries as { count?: number; waitSeconds?: number };
      if (!r || !Number.isInteger(r.count) || r.count! < 0 || r.count! > 10 || !Number.isFinite(r.waitSeconds) || r.waitSeconds! < 0 || r.waitSeconds! > 3600) throw new Error("retries need count 0–10 and waitSeconds 0–3600");
      clean.retries = { count: r.count!, waitSeconds: r.waitSeconds! };
    } else {
      const n = b[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 525600) throw new Error(`${key} must be a number from 0 to 525600 (0 disables)`);
      clean[key as "maxTurnMinutes" | "idleSleepMinutes" | "autoArchiveDays"] = n;
    }
  }
  const settings = sessionSettings(dir);
  if (agent) Object.defineProperty(settings.agents, agent, { value: { ...(Object.hasOwn(settings.agents, agent) ? settings.agents[agent] : {}), ...clean }, enumerable: true, configurable: true, writable: true });
  else Object.assign(settings, clean);
  write(settingsFile(dir), settings); return settings;
}
export function agentPolicy(dir: string, id: string): AgentPolicy { const s = sessionSettings(dir); return { ...s, ...s.agents[id] }; }
const envFile = (project: string, id: string) => path.join(loomHome(), "agent-environment", createHash("sha256").update(JSON.stringify([project, id])).digest("hex") + ".json");
export const agentEnvironment = (project: string, id: string): Record<string, string> => read(envFile(project, id), {});
const environmentSecrets = new Map<string, Map<string, string[]>>();
export function clearEnvironment(project: string, id: string): void {
  fs.rmSync(envFile(project, id), { force: true });
  environmentSecrets.delete(project);
}
export function applyEnvironment(options: Record<string, unknown>, project: string, id: string): void {
  const env = agentEnvironment(project, id);
  if (Object.keys(env).length) options.env = { ...(options.env as Record<string, string> ?? {}), ...env };
}
export function changeEnvironment(project: string, id: string, key: unknown, value?: unknown): string[] {
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error("invalid environment key");
  if (value !== undefined && (typeof value !== "string" || value.includes("\0") || value.length > 32768)) throw new Error("environment value must be text without NUL, at most 32768 characters");
  const env = agentEnvironment(project, id);
  if (value === undefined) delete env[key]; else Object.defineProperty(env, key, { value, enumerable: true, configurable: true, writable: true });
  write(envFile(project, id), env); environmentSecrets.delete(project); return Object.keys(env).sort();
}
const structuralKeys = new Set(["state", "requestId", "kind", "tool", "reason", "adapter", "model"]);
export function redactEnvironment<T>(value: T, project: string, ids: string | string[]): T {
  let cached = environmentSecrets.get(project);
  if (!cached) environmentSecrets.set(project, cached = new Map());
  const secrets = [...new Set((typeof ids === "string" ? [ids] : ids).flatMap(id => {
    let values = cached!.get(id);
    if (!values) cached!.set(id, values = Object.values(agentEnvironment(project, id)).filter(v => v.length >= 8));
    return values;
  }))].sort((a, b) => b.length - a.length);
  const visit = (v: unknown): unknown => typeof v === "string" ? secrets.reduce((s, key) => s.split(key).join("[redacted]"), v) : Array.isArray(v) ? v.map(visit) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, structuralKeys.has(k) ? item : visit(item)])) : v;
  return visit(value) as T;
}
