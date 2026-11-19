import { validateControls } from "./orchestra-r4/model.js";
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { loomHome } from "./registry.js";
import type { OrchestraRun, OrchestraStartOptions } from "./orchestra.js";

export interface OrchestraTimelineEvent {
  at: number;
  taskId: string;
  attempt: number;
  phase: string;
  text?: string;
  reportKind?: string;
  status?: string;
  agent?: string;
  model?: string;
}

export function validateOrchestraOptions(opts: OrchestraStartOptions): void {
  validateControls(opts);
  for (const key of ["maxUsd", "stallMinutes"] as const) {
    const value = opts[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error(`${key} must be a positive number`);
  }
  if (opts.planOnly !== undefined && typeof opts.planOnly !== "boolean") throw new Error("planOnly must be a boolean");
  if (opts.planOnly && (opts.race || opts.compare)) throw new Error("planOnly requires a planner, not a race");
  if (opts.kindLimits !== undefined) {
    if (!opts.kindLimits || typeof opts.kindLimits !== "object" || Array.isArray(opts.kindLimits)) throw new Error("kindLimits must map agent kinds to limits");
    for (const [kind, limit] of Object.entries(opts.kindLimits)) {
      if (!/^[a-z][a-z0-9-]*$/.test(kind) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("kindLimits must contain integer limits from 1 to 100");
    }
  }
  if (opts.webhookUrl !== undefined) {
    const url = new URL(opts.webhookUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("webhookUrl must be an HTTP(S) URL without credentials or a fragment");
  }
}

export function orchestraGraph(run: OrchestraRun): string {
  const ids = new Map(run.tasks.map((task, i) => [task.id, `t${i}`]));
  const label = (value: string) => value.replace(/[^\p{L}\p{N} .,:_/-]/gu, c => `#${c.codePointAt(0)};`).replace(/\r?\n/g, " ");
  return ["flowchart TD", ...run.tasks.map(t => `  ${ids.get(t.id)}["${label(`${t.id}: ${t.title} (${t.agent}) — ${t.status}`)}"]`),
    ...run.tasks.flatMap(t => t.dependsOn.filter(d => ids.has(d)).map(d => `  ${ids.get(d)} --> ${ids.get(t.id)}`))].join("\n") + "\n";
}

export function runRecipeOptions(run: OrchestraRun): OrchestraStartOptions {
  const spec = (w: { id?: string; agent?: string; model?: string; effort?: string }) => {
    const id = (w.id ?? w.agent ?? "").replace(/#\d+$/, "");
    return id.includes("@") ? id : id + (w.model ? `@${w.model}` : "") + (w.effort ? `:${w.effort}` : "");
  };
  return { goal: run.goal, orchestrator: spec(run.orchestrator), workers: run.workerDetails?.map(spec) ?? run.workers,
    check: run.check, checkRounds: run.checkRounds, taskMinutes: run.taskMinutes,
    maxParallel: run.maxParallel, maxRounds: run.maxRounds, plan: run.plan, planOnly: run.planOnly,
    maxUsd: run.budgetUsd, kindLimits: run.kindLimits, stallMinutes: run.stallMinutes, webhookUrl: run.webhookUrl, race: run.race, compare: run.compare, team: false };
}

export interface OrchestraRecipe { name: string; options: OrchestraStartOptions; savedAt: number }
const recipeFile = () => path.join(loomHome(), "orchestra-recipes.json");
export function listOrchestraRecipes(): OrchestraRecipe[] {
  if (!fs.existsSync(recipeFile())) return [];
  return JSON.parse(fs.readFileSync(recipeFile(), "utf8")) as OrchestraRecipe[];
}
export function saveOrchestraRecipe(name: unknown, options: OrchestraStartOptions): OrchestraRecipe {
  if (typeof name !== "string" || !/^[\w][\w .-]{0,48}$/.test(name)) throw new Error("invalid recipe name");
  if (!options.goal?.trim()) throw new Error("a recipe needs a goal");
  validateOrchestraOptions(options);
  // A recipe always opens its own thread and cannot adopt somebody else's PR.
  const { chat: _chat, from: _from, ...portable } = options;
  const recipe = { name, options: portable, savedAt: Date.now() };
  const all = [...listOrchestraRecipes().filter(r => r.name !== name), recipe];
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(recipeFile() + ".tmp", JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(recipeFile() + ".tmp", recipeFile());
  return recipe;
}

/** One project secret signs all run completions; it never enters a run or recipe. */
export function projectWebhookSecret(dir: string): string {
  const file = path.join(dir, ".loom", "webhook-secret");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  return fs.readFileSync(file, "utf8").trim();
}

export async function sendCompletionWebhook(dir: string, project: string, run: OrchestraRun): Promise<void> {
  const body = JSON.stringify({ event: "orchestra.completed", project, runId: run.id, status: run.status,
    goal: run.goal, summary: run.summary, costUsd: run.costUsd, tasks: run.tasks.map(t => ({ id: t.id, status: t.status })) });
  const signature = createHmac("sha256", projectWebhookSecret(dir)).update(body).digest("hex");
  const response = await fetch(run.webhookUrl!, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", "x-loom-signature-256": `sha256=${signature}`, "x-loom-delivery": run.id }, body });
  if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
  await response.body?.cancel();
}
