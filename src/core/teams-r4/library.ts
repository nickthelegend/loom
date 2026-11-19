import fs from "node:fs";
import path from "node:path";
import { fillTemplate, templateVariables } from "../chat-composer.js";
import { listPrompts } from "../prompts.js";
import { listOrchestraRecipes, validateOrchestraOptions } from "../orchestra-options.js";
import { expandSavedFleets, parseAgentSpec } from "../fleets.js";
import type { OrchestraStartOptions } from "../orchestra.js";

export type LibraryKind = "templates" | "recipes";
export interface TeamTemplate { name: string; text: string; variables: string[]; source: "team" }
export interface TeamRecipe { name: string; options: OrchestraStartOptions; source: "team" }

function nameOf(name: unknown): string {
  if (typeof name !== "string" || !/^[\w][\w .-]{0,48}$/.test(name) || name.endsWith(".")) throw new Error("use a name of 1–49 letters, digits, spaces, dots, underscores or hyphens");
  return name;
}

/** Repo content is data. Refuse symlinks at every component, including .loom. */
function folder(dir: string, kind: LibraryKind, create = false): string {
  let current = dir;
  for (const component of [".loom", "shared", kind]) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) {
      if (!create) return current;
      fs.mkdirSync(current);
    }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error("shared library directories must not be symlinks");
  }
  return current;
}
function filename(dir: string, kind: LibraryKind, name: string, create = false): string {
  const file = path.join(folder(dir, kind, create), nameOf(name) + (kind === "templates" ? ".md" : ".json"));
  try { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("shared entries must be regular files"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return file;
}
function template(name: string, text: unknown): TeamTemplate {
  // These are the personal template API's limits; rendering uses its validator too.
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new Error("a template needs 1–20000 characters");
  const variables = templateVariables(text);
  fillTemplate(text, Object.fromEntries(variables.map(v => [v, ""])));
  return { name: nameOf(name), text, variables, source: "team" };
}
export function recipe(name: string, raw: unknown): TeamRecipe {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("a recipe needs options");
  const input = raw as OrchestraStartOptions;
  if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 20_000) throw new Error("a recipe needs a goal of at most 20000 characters");
  validateOrchestraOptions(input);
  // Only portable execution settings travel through git. Never inherit chat, PR or webhook authority.
  const options: OrchestraStartOptions = { goal: input.goal, team: false };
  for (const key of ["plan", "planOnly", "race", "compare"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new Error(`${key} must be boolean`);
      options[key] = input[key];
    }
  }
  for (const key of ["maxParallel", "maxRounds", "maxUsd", "stallMinutes"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key]! <= 0) throw new Error(`${key} must be positive`);
      if ((key === "maxParallel" || key === "maxRounds") && (!Number.isInteger(input[key]) || input[key]! > 100)) throw new Error(`${key} must be an integer from 1 to 100`);
      options[key] = input[key];
    }
  }
  if (input.kindLimits) options.kindLimits = { ...input.kindLimits };
  if (input.orchestrator !== undefined) {
    if (typeof input.orchestrator !== "string") throw new Error("orchestrator must be an agent spec");
    parseAgentSpec(input.orchestrator); options.orchestrator = input.orchestrator;
  }
  if (input.workers !== undefined) {
    if (!Array.isArray(input.workers) || !input.workers.length || input.workers.length > 100) throw new Error("workers must contain 1–100 agent specs");
    for (const spec of input.workers) {
      if (typeof spec !== "string" || spec.length > 200) throw new Error("invalid worker spec");
      if (!/^@[\w-]{1,64}$/.test(spec)) parseAgentSpec(spec);
    }
    options.workers = [...input.workers];
  }
  return { name: nameOf(name), options, source: "team" };
}
export function readShared(dir: string, kind: "templates", name: string): TeamTemplate;
export function readShared(dir: string, kind: "recipes", name: string): TeamRecipe;
export function readShared(dir: string, kind: LibraryKind, name: string): TeamTemplate | TeamRecipe;
export function readShared(dir: string, kind: LibraryKind, name: string): TeamTemplate | TeamRecipe {
  const file = filename(dir, kind, name);
  if (fs.statSync(file).size > 128_000) throw new Error("shared entry is too large");
  const text = fs.readFileSync(file, "utf8");
  return kind === "templates" ? template(name, text) : recipe(name, JSON.parse(text).options);
}
export function sharedLibrary(dir: string, kind: LibraryKind) {
  const entries: Array<TeamTemplate | TeamRecipe> = [], errors: Array<{ name: string; error: string }> = [];
  const ext = kind === "templates" ? ".md" : ".json";
  const base = folder(dir, kind);
  if (!fs.existsSync(base)) return { entries, errors };
  for (const file of fs.readdirSync(base).filter(f => f.endsWith(ext)).slice(0, 500)) {
    const name = file.slice(0, -ext.length);
    try { entries.push(readShared(dir, kind, name)); } catch (e) { errors.push({ name, error: (e as Error).message }); }
  }
  return { entries, errors };
}
export function publishShared(dir: string, kind: LibraryKind, name: string, value?: unknown) {
  const entry = kind === "templates" ? template(name, value ?? listPrompts().saved.find(p => p.title === name)?.text)
    : recipe(name, value ?? listOrchestraRecipes().find(r => r.name === name)?.options);
  const file = filename(dir, kind, name, true);
  // O_NOFOLLOW also covers a symlink swapped in after the path checks.
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, "text" in entry ? entry.text : JSON.stringify({ name, options: entry.options }, null, 2) + "\n"); }
  finally { fs.closeSync(fd); }
  return { entry, path: `.loom/shared/${kind}/${name}${kind === "templates" ? ".md" : ".json"}` };
}
export function localRecipeOptions(entry: TeamRecipe, roster: Array<{ id: string; kind: string; enabled?: boolean }>): OrchestraStartOptions {
  let workers: string[] | undefined;
  try { workers = entry.options.workers && expandSavedFleets(entry.options.workers); }
  catch (e) { throw new Error(`Team recipe ${entry.name}: fleet entry isn't available locally: ${(e as Error).message}`); }
  const missing = [...(workers ?? []), ...(entry.options.orchestrator ? [entry.options.orchestrator] : [])].filter(spec => {
    const agent = parseAgentSpec(spec, roster.map(a => a.id)).agent;
    return !roster.some(a => a.enabled !== false && (a.id === agent || a.kind === agent));
  });
  if (missing.length) throw new Error(`Team recipe ${entry.name}: fleet entries aren't available locally: ${missing.join(", ")}. Add them to this project's agents first.`);
  return { ...entry.options, ...(workers ? { workers } : {}) };
}
