import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { knownAgentKinds } from "../adapters/index.js";
import { agentConfigWarnings } from "./registry.js";
import type { ProjectConfig } from "../types.js";

const text = z.string().min(1).refine(value => value.trim().length > 0, "must not be blank");
const strings = z.array(text);
const positive = z.number().positive();
const step = z.union([text, z.strictObject({ step: text, role: text.optional(), instruction: z.string().optional(), onFail: text.optional(), when: text.optional() })]);
const schema = z.strictObject({
  name: text, agents: z.array(z.object({ id: text, kind: text, role: text, account: text.optional(), options: z.object({ model: text.optional(), permissions: z.enum(["ask", "auto", "bypass"]).optional(),
      bin: text.optional(), extraArgs: strings.optional(), env: z.record(z.string(), z.string()).optional(), timeoutMs: positive.optional(), startTimeoutMs: positive.optional() }).passthrough().optional(),
    enabled: z.boolean().optional(), instructions: z.string().optional(), avatar: z.string().optional(), memoryFiles: strings.optional(), permissions: z.enum(["ask", "auto", "bypass"]).optional() }).passthrough()),
  defaultAgent: text.optional(), chatTitles: z.enum(["local", "model"]).optional(), loomTools: z.boolean().optional(),
  routes: z.record(z.string(), z.array(step).min(1)).optional(), skills: z.record(z.string(), z.boolean()).optional(),
  brain: z.strictObject({ continuity: z.boolean().optional(), extractor: z.enum(["auto", "off"]).optional(), model: text.optional(), semantic: z.boolean().optional() }).optional(),
  projection: z.strictObject({ mode: z.enum(["template", "llm"]).optional(), model: text.optional(), timeoutMs: positive.optional() }).optional(),
  watchdog: z.strictObject({ auto: z.enum(["notify", "nudge", "off"]).optional() }).optional(),
  shield: z.strictObject({ auto: z.enum(["notify", "stop", "off"]).optional() }).optional(),
  permissions: z.strictObject({ allow: strings.optional() }).optional(), readPaths: strings.optional(),
  orchestra: z.strictObject({ worktreeDir: text.optional() }).optional(), review: z.strictObject({ timeoutMin: positive.optional() }).optional(),
  budgets: z.strictObject({ perGoalUsd: z.number().nonnegative().optional() }).optional(), maxConcurrentGoals: positive.int().optional(),
  safety: z.strictObject({ snapshotBeforeRoutes: z.boolean().optional() }).optional(),
  git: z.strictObject({ commitPerTurn: z.boolean().optional(), branchPerTask: z.boolean().optional(), worktreePerAgent: z.boolean().optional(), mergeOnHandoff: z.boolean().optional(), delivery: z.enum(["none", "commit", "push", "pr"]).optional() }).optional(),
  team: z.strictObject({ teamId: text.optional(), repo: text.optional(), optOut: z.boolean().optional() }).nullable().optional(),
  crews: z.array(z.strictObject({ id: text, name: text, teammates: z.array(z.strictObject({ id: text, agent: text, role: z.enum(["lead", "builder", "reviewer", "tester", "researcher"]), charter: z.string().optional() })),
    planApproval: z.boolean().optional(), maxRounds: z.number().int().nonnegative().optional(), testCommand: text.optional(), stallMinutes: positive.optional(), play: z.enum(["ship", "fanout", "race"]).optional(), maxParallel: positive.int().optional(), budgetUsd: z.number().nonnegative().optional() })).optional(),
  mcps: z.array(z.strictObject({ name: text, url: z.string(), description: z.string().optional(), icon: z.string().optional(), connected: z.boolean().optional(), probedAt: z.number().optional(), enabledForSession: z.boolean().optional(), transport: z.enum(["http", "sse"]).optional(),
    headers: z.record(z.string(), z.string()).optional(), command: text.optional(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), slug: text.optional() })).optional(),
  servers: z.array(z.strictObject({ name: text, command: text, cwd: text.optional(), port: z.number().int().min(1).max(65535).optional(), url: z.string().url().optional(), env: z.record(z.string(), z.string()).optional() })).optional(),
  relay: z.strictObject({ auto: z.boolean().optional(), to: strings.optional(), handBack: z.boolean().optional() }).optional(),
  proof: z.strictObject({ testCommand: text.optional(), auto: z.enum(["claims", "off"]).optional(), timeoutMin: positive.optional() }).optional(),
});
export interface ConfigValidation { valid: boolean; errors: Array<{ path: string; message: string }>; warnings: string[] }
export function validateProjectConfig(value: unknown): ConfigValidation {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map(i => ({ path: i.path.join(".") || "$", message: i.message })), warnings: [] };
  const cfg = parsed.data, errors: ConfigValidation["errors"] = [];
  const ids = new Set<string>();
  cfg.agents.forEach((a, i) => {
    if (ids.has(a.id)) errors.push({ path: `agents.${i}.id`, message: `duplicate agent id "${a.id}"` });
    ids.add(a.id);
    if (!knownAgentKinds().includes(a.kind)) errors.push({ path: `agents.${i}.kind`, message: `unknown agent kind "${a.kind}"` });
  });
  if (cfg.defaultAgent && !ids.has(cfg.defaultAgent)) errors.push({ path: "defaultAgent", message: "must name an agent in agents" });
  const targets = new Set([...ids, ...cfg.agents.map(a => a.role)]);
  for (const [name, steps] of Object.entries(cfg.routes ?? {})) steps.forEach((s, i) => {
    const target = (typeof s === "string" ? s : s.step).split("?")[0]!;
    if (!targets.has(target)) errors.push({ path: `routes.${name}.${i}`, message: `unknown agent or role "${target}"` });
  });
  for (const [i, crew] of (cfg.crews ?? []).entries()) {
    const seats = new Set<string>();
    crew.teammates.forEach((t, j) => {
      if (!ids.has(t.agent)) errors.push({ path: `crews.${i}.teammates.${j}.agent`, message: `unknown agent "${t.agent}"` });
      if (seats.has(t.id)) errors.push({ path: `crews.${i}.teammates.${j}.id`, message: `duplicate teammate "${t.id}"` });
      seats.add(t.id);
    });
  }
  for (const [i, target] of (cfg.relay?.to ?? []).entries()) if (!ids.has(target)) errors.push({ path: `relay.to.${i}`, message: `unknown agent "${target}"` });
  return { valid: !errors.length, errors, warnings: agentConfigWarnings(cfg as ProjectConfig) };
}

/** Read the disk file directly: a runtime's last good config can hide a broken edit. */
export function validateConfigFile(dir: string): ConfigValidation {
  try { return validateProjectConfig(JSON.parse(fs.readFileSync(path.join(dir, ".loom", "config.json"), "utf8"))); }
  catch (error) { return { valid: false, errors: [{ path: "$", message: (error as Error).message }], warnings: [] }; }
}
