import type { OrchestraRun, OrchestraTask, OrchestraStartOptions } from "../orchestra.js";
import { savedPlan, validatePlan, validateControls, type PlanTask } from "./model.js";
import { runRecipeOptions } from "../orchestra-options.js";

export interface ControlHost {
  get(id: string): OrchestraRun;
  save(run: OrchestraRun, phase: string): void;
  schedule(run: OrchestraRun): void;
  add(run: OrchestraRun, task: PlanTask): OrchestraTask;
  include(run: OrchestraRun, agents: string[]): void;
  assignment(run: OrchestraRun, agent: string): Pick<OrchestraTask, "agent" | "kind" | "model" | "effort">;
  stop(run: OrchestraRun, task: OrchestraTask): Promise<void>;
  skip(run: OrchestraRun, task: OrchestraTask, reason: string): Promise<OrchestraTask[]>;
  note(run: OrchestraRun, task: OrchestraTask, text: string): Promise<boolean>;
  approve(id: string): Promise<OrchestraRun>;
  start(opts: OrchestraStartOptions): Promise<OrchestraRun>;
  retry(id: string, task: string, agent: string, extendedMinutes?: number): Promise<OrchestraRun>;
  busy(run: OrchestraRun): boolean;
}
const terminal = (run: OrchestraRun) => ["completed", "failed", "aborted", "moved"].includes(run.status);
const text = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 16000) throw new Error(`${name} must contain 1–16000 characters`);
  return value.trim();
};

export async function control(host: ControlHost, id: string, action: string, body: Record<string, unknown> = {}): Promise<OrchestraRun> {
  const run = host.get(id);
  if (action === "rerun") {
    if (!terminal(run) || run.status === "moved") throw new Error("only finished runs can run again");
    if (body.onlyFailed !== undefined && typeof body.onlyFailed !== "boolean") throw new Error("onlyFailed must be boolean");
    if (body.workers !== undefined && (!Array.isArray(body.workers) || body.workers.some(w => typeof w !== "string"))) throw new Error("workers must be fleet specs");
    const selected = new Set(run.tasks.filter(t => !body.onlyFailed || ["failed", "conflict", "needs_input", "cancelled"].includes(t.status)).map(t => t.id));
    const plan = savedPlan(run).filter(t => selected.has(t.id)).map(t => ({ ...t, dependsOn: t.dependsOn.filter(d => selected.has(d)) }));
    if (!plan.length) throw new Error("no tasks to run again");
    // Successful dependencies are already on the source integration branch.
    return host.start({ ...runRecipeOptions(run), planOnly: false, savedTasks: plan, rerunOf: run.id,
      ...(body.workers ? { workers: body.workers as string[], remapTasks: true } : {}),
      ...(body.onlyFailed ? { savedBase: run.branch } : {}) });
  }
  if (terminal(run) || run.moving) throw new Error("run is not active");
  if (action === "hold" || action === "release") {
    run.held = action === "hold";
    host.save(run, run.held ? "held" : "released");
    if (!run.held) host.schedule(run);
    return run;
  }
  if (action === "say") {
    const note = text(body.text, "note");
    (run.workerNotes ??= []).push(note);
    host.save(run, "worker_note");
    const workers = run.tasks.filter(t => t.status === "running");
    // Queue every delivery before awaiting an adapter: another worker may finish meanwhile.
    for (const task of workers) task.queued.push(`Note from the human: ${note}`);
    await Promise.all(workers.map(async task => {
      if (await host.note(run, task, note).catch(() => false)) {
        const index = task.queued.indexOf(`Note from the human: ${note}`);
        if (index >= 0) task.queued.splice(index, 1);
      }
    }));
    host.save(run, "worker_note_delivered");
    return run;
  }
  if (action === "plan" || action === "approve") {
    if (!run.planOnly || run.planApprovedAt || run.status !== "waiting_human" || host.busy(run)) throw new Error("no plan awaiting editing");
    if (body.plan !== undefined) {
      const plan = validatePlan(body.plan);
      const assignments = plan.map(t => host.assignment(run, t.agent));
      const old = new Map(run.tasks.map(t => [t.id, t]));
      if (plan.some(t => !old.has(t.id))) throw new Error("edited plan must use existing task ids");
      host.include(run, assignments.map(a => a.agent));
      run.tasks = plan.map((t, i) => ({ ...old.get(t.id)!, id: t.id, title: t.title.slice(0, 120), prompt: t.prompt, dependsOn: t.dependsOn,
        ...(t.touches !== undefined ? { touches: t.touches } : {}), ...assignments[i],
        model: t.model ?? assignments[i]!.model, effort: t.effort ?? assignments[i]!.effort }));
      host.save(run, "plan_edited");
    }
    return action === "approve" ? host.approve(id) : run;
  }
  if (action === "add") {
    const prompt = text(body.text, "task");
    const after = body.after === undefined ? [] : [text(body.after, "after")];
    if (after.some(d => !run.tasks.some(t => t.id === d && !t.skippedReason))) throw new Error("after must name a task that has not been skipped");
    const agent = body.agent === undefined ? run.workers[0]! : text(body.agent, "agent");
    const assignment = host.assignment(run, agent);
    host.include(run, [assignment.agent]);
    host.add(run, { id: "", title: prompt.slice(0, 120), prompt, ...assignment, dependsOn: after });
    if (!host.busy(run) && !(run.planOnly && !run.planApprovedAt)) { run.status = "running"; run.question = undefined; }
    host.save(run, "task_added"); host.schedule(run); return run;
  }
  const task = run.tasks.find(t => t.id === body.task);
  if (!task) throw new Error("no such task in this run");
  if (action === "skip") {
    if (task.status === "done") throw new Error("a merged task cannot be skipped");
    const blocked = task.status === "needs_input" && Boolean(task.timedOutAt || task.checkFailures);
    const skipped = await host.skip(run, task, body.reason === undefined ? "Skipped by the human" : text(body.reason, "reason"));
    if (terminal(run) || run.moving) throw new Error("run is not active");
    host.save(run, "task_skipped");
    await Promise.all(skipped.map(t => host.stop(run, t)));
    if (blocked && run.status === "waiting_human" && !run.tasks.some(t => t.status === "needs_input" && (t.timedOutAt || (t.checkFailures ?? 0) > (run.checkRounds ?? 2))) && !host.busy(run)) {
      run.status = "running"; run.question = undefined;
      host.save(run, "task_skip_settled");
    }
    host.schedule(run); return run;
  }
  if (action === "extend") {
    const minutes = body.minutes ?? run.taskMinutes;
    validateControls({ taskMinutes: minutes as number });
    if (!minutes || !task.timedOutAt) throw new Error("task has not reached its time limit");
    await host.stop(run, task);
    if (terminal(run) || run.moving) throw new Error("run is not active");
    const agent = task.agent.includes("@") ? task.agent : task.agent.replace(/#\d+$/, "") + (task.model ? `@${task.model}` : "") + (task.effort ? `:${task.effort}` : "");
    return host.retry(id, task.id, agent, Number(minutes));
  }
  if (action === "reassign") {
    const agent = text(body.agent, "agent");
    return host.retry(id, task.id, agent);
  }
  throw new Error("unknown Orchestra action");
}
