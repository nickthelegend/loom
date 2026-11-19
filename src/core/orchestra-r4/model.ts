import { taskDuration } from "./results.js";
import type { OrchestraRun, OrchestraTask } from "../orchestra.js";

export interface RunControls {
  held?: boolean;
  finishedAt?: number;
  check?: string;
  checkRounds?: number;
  taskMinutes?: number;
  workerNotes?: string[];
  rerunOf?: string;
}
export interface TaskControls {
  skippedReason?: string;
  timedOutAt?: number;
  deadlineAt?: number;
  extendedMinutes?: number;
  checkFailures?: number;
  checkOutput?: string;
}
export interface PlanTask {
  id: string;
  title: string;
  prompt: string;
  agent: string;
  dependsOn: string[];
  model?: string;
  effort?: string;
  touches?: string[];
}

export function validateControls(opts: RunControls): void {
  if (opts.check !== undefined && (typeof opts.check !== "string" || !opts.check.trim() || opts.check.length > 8000)) throw new Error("check must be a nonempty command (up to 8000 characters)");
  if (opts.checkRounds !== undefined && (!Number.isInteger(opts.checkRounds) || opts.checkRounds < 0 || opts.checkRounds > 20)) throw new Error("checkRounds must be an integer from 0 to 20");
  if (opts.taskMinutes !== undefined && (typeof opts.taskMinutes !== "number" || !Number.isFinite(opts.taskMinutes) || opts.taskMinutes <= 0 || opts.taskMinutes > 10080)) throw new Error("taskMinutes must be positive and at most 10080");
}

export function savedPlan(run: OrchestraRun): PlanTask[] {
  return run.tasks.map(({ id, title, prompt, agent, dependsOn, model, effort, touches }) => ({ id, title, prompt, agent, dependsOn: [...dependsOn], model, effort, touches }));
}

/** Validate the whole replacement before changing a task or creating a chat. */
export function validatePlan(input: unknown): PlanTask[] {
  const raw = Array.isArray(input) ? input : (input as { tasks?: unknown })?.tasks;
  if (!Array.isArray(raw) || !raw.length || raw.length > 500) throw new Error("plan must contain 1–500 tasks");
  const tasks: PlanTask[] = raw.map(t => {
    if (!t || typeof t !== "object") throw new Error("invalid plan task");
    for (const key of ["id", "title", "prompt", "agent"] as const) if (typeof t[key] !== "string" || !t[key].trim()) throw new Error(`task ${key} is required`);
    if (!/^[\w-]{1,64}$/.test(t.id)) throw new Error("task id must be 1–64 letters, digits, underscores or hyphens");
    if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d: unknown) => typeof d !== "string")) throw new Error("dependsOn must be task ids");
    for (const key of ["model", "effort"] as const) if (t[key] !== undefined && typeof t[key] !== "string") throw new Error(`invalid ${key}`);
    if (t.touches !== undefined && (!Array.isArray(t.touches) || t.touches.some((p: unknown) => typeof p !== "string"))) throw new Error("touches must be paths");
    return { id: t.id, title: t.title, prompt: t.prompt, agent: t.agent, dependsOn: [...t.dependsOn], model: t.model, effort: t.effort, touches: t.touches };
  });
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) throw new Error("duplicate task id");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("plan dependencies contain a cycle");
    if (visited.has(id)) return;
    if (!ids.has(id)) throw new Error(`unknown dependency ${id}`);
    visiting.add(id);
    for (const dep of tasks.find(t => t.id === id)!.dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  tasks.forEach(t => visit(t.id));
  return tasks;
}

export function runReport(run: OrchestraRun, now = Date.now()) {
  const tasks = run.tasks.map(t => ({ id: t.id, title: t.title, agent: t.agent, status: t.skippedReason ? "skipped" : t.status,
    result: t.result ?? "", error: t.skippedReason ?? t.error, costUsd: t.costUsd ?? null,
    durationMs: taskDuration(run, t, now), files: t.files ?? [], checkOutput: t.checkOutput }));
  const openQuestions = [run.question, ...run.tasks.filter(t => t.status === "needs_input").map(t => `${t.id}: ${t.error ?? t.result ?? "Needs your input"}`)].filter((s): s is string => !!s);
  const report = { id: run.id, goal: run.goal, status: run.held && !["completed", "failed", "aborted", "moved"].includes(run.status) ? "held" : run.status, costUsd: run.costUsd,
    durationMs: Math.max(0, (["completed", "failed", "aborted", "moved"].includes(run.status) ? run.finishedAt ?? run.updatedAt : now) - run.createdAt),
    files: [...new Set(tasks.flatMap(t => t.files))], tasks, openQuestions };
  const markdown = [`# Run ${run.id}`, "", run.goal, "", `Status: ${report.status} · Cost: $${report.costUsd} · Time: ${Math.round(report.durationMs / 1000)}s`,
    ...tasks.flatMap(t => ["", `## ${t.id}: ${t.title}`, `${t.status} · ${t.agent} · Cost: ${t.costUsd === null ? "unknown" : `$${t.costUsd}`} · Time: ${Math.round(t.durationMs / 1000)}s`, t.result, t.error ?? "", `Files: ${t.files.join(", ") || "none"}`, t.checkOutput ? `Check output:\n\n${t.checkOutput}` : ""]),
    "", "## Open questions", ...openQuestions.map(q => `- ${q}`), ...(openQuestions.length ? [] : ["None."])].join("\n");
  return { ...report, markdown };
}

export function compareRuns(a: OrchestraRun, b: OrchestraRun) {
  const left = runReport(a), right = runReport(b);
  return { a: left, b: right, tasks: [...new Set([...a.tasks, ...b.tasks].map(t => t.id))].map(id => ({ id,
    a: left.tasks.find(t => t.id === id) ?? null, b: right.tasks.find(t => t.id === id) ?? null })) };
}

export function skipDependents(run: OrchestraRun, task: OrchestraTask, reason: string): OrchestraTask[] {
  const skipped = [task];
  task.skippedReason = reason;
  for (let i = 0; i < skipped.length; i++) {
    for (const child of run.tasks) {
      if (child.status !== "pending" || skipped.includes(child) || !child.dependsOn.includes(skipped[i]!.id)) continue;
      child.skippedReason = `Dependency ${skipped[i]!.id} was skipped: ${reason}`;
      skipped.push(child);
    }
  }
  for (const t of skipped) { t.status = "cancelled"; t.error = t.skippedReason; t.finishedAt = Date.now(); t.queued = []; t.timedOutAt = undefined; t.deadlineAt = undefined; }
  return skipped;
}
