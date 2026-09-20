/**
 * A queue worth keeping: the same five steps you run on every project.
 *
 * "Update deps, run the tests, fix what broke, update the changelog, open the
 * PR" is a queue you build by hand every time. A recipe is that queue saved —
 * an ordered list of prompts, each remembering who it goes to.
 *
 * Targets travel by ROLE rather than by agent id, because `claude-code` on one
 * project is `reviewer` on another and an id from someone else's machine means
 * nothing here. Running a recipe resolves those roles against the project it
 * lands in, and anything it can't resolve becomes an Auto prompt rather than a
 * refusal — the prompts are still editable before they go.
 *
 * Stored in ~/.loom/recipes.json. Nothing leaves the machine.
 */

import fs from "node:fs";
import path from "node:path";

import { loomHome } from "./registry.js";
import type { QueueTarget } from "./prompt-queue.js";

export interface RecipeStep {
  text: string;
  /** "auto", "orchestra", or a role/kind like "reviewer" or "codex". */
  to: string;
  plan?: boolean;
}

export interface Recipe {
  name: string;
  steps: RecipeStep[];
  /** Where it came from, for the person reading a list of them later. */
  fromProject?: string;
  savedAt: number;
}

export const MAX_STEPS = 50;

function file(): string {
  return path.join(loomHome(), "recipes.json");
}

export function listRecipes(): Recipe[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Recipe[];
    return Array.isArray(raw) ? raw.filter((r) => r?.name && Array.isArray(r.steps)) : [];
  } catch {
    return [];
  }
}

export function getRecipe(name: string): Recipe | null {
  return listRecipes().find((r) => r.name === name) ?? null;
}

function write(all: Recipe[]): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

/** Save (or replace) a recipe. Names are how you call it back, so they're checked. */
export function saveRecipe(recipe: Omit<Recipe, "savedAt">): Recipe {
  const name = recipe.name.trim();
  if (!/^[\w][\w .-]{0,48}$/.test(name)) throw new Error(`"${name}" isn't a usable recipe name`);
  if (!recipe.steps.length) throw new Error("a recipe with no steps isn't a recipe");
  if (recipe.steps.length > MAX_STEPS) throw new Error(`a recipe holds at most ${MAX_STEPS} steps`);
  const steps = recipe.steps.map((s) => {
    const text = String(s.text ?? "").trim();
    if (!text) throw new Error("a recipe step needs something to say");
    return { text, to: String(s.to ?? "auto").trim() || "auto", ...(s.plan ? { plan: true } : {}) };
  });
  const saved: Recipe = { name, steps, ...(recipe.fromProject ? { fromProject: recipe.fromProject } : {}), savedAt: Date.now() };
  write([saved, ...listRecipes().filter((r) => r.name !== name)]);
  return saved;
}

export function deleteRecipe(name: string): boolean {
  const all = listRecipes();
  const left = all.filter((r) => r.name !== name);
  if (left.length === all.length) return false;
  write(left);
  return true;
}

/** What a queued item's target becomes when a recipe is saved. */
export function targetToRole(target: QueueTarget, roleOf: (agentId: string) => string | undefined): string {
  if (target.kind === "orchestra") return "orchestra";
  if (target.kind === "auto") return "auto";
  return roleOf(target.agentId) ?? target.agentId;
}

/**
 * Resolve a saved step's target against a project's agents.
 *
 * An exact id wins, then a role, then a kind. Nothing matching means Auto: the
 * prompt still runs, the router still picks, and the person can still change
 * it before it goes — better than refusing a recipe because a machine happens
 * to call its reviewer something else.
 */
export function roleToTarget(
  to: string,
  agents: Array<{ id: string; role?: string; kind?: string }>,
): QueueTarget {
  const want = to.trim().toLowerCase();
  if (!want || want === "auto") return { kind: "auto" };
  if (want === "orchestra" || want === "orchestrate") return { kind: "orchestra" };
  const byId = agents.find((a) => a.id.toLowerCase() === want);
  if (byId) return { kind: "agent", agentId: byId.id };
  const byRole = agents.find((a) => (a.role ?? "").toLowerCase() === want);
  if (byRole) return { kind: "agent", agentId: byRole.id };
  const byKind = agents.find((a) => (a.kind ?? "").toLowerCase() === want);
  if (byKind) return { kind: "agent", agentId: byKind.id };
  return { kind: "auto" };
}
