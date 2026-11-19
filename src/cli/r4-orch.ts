import fs from "node:fs";
import type { Command } from "commander";
import { DaemonClient } from "../daemon/client.js";
import type { OrchestraRun } from "../core/orchestra.js";
import type { runReport } from "../core/orchestra-r4/model.js";

export function registerR4Orchestra(program: Command, connect: () => Promise<DaemonClient>, project: (c: DaemonClient) => Promise<{ id: string }>): void {
  const request = async <T>(path: string, body?: Record<string, unknown>) => {
    const c = await connect(), p = await project(c);
    return c.r4Orchestra<T>(p.id, path, body);
  };
  const post = async (run: string, action: string, body: Record<string, unknown> = {}) => {
    const result = await request<{ run: OrchestraRun }>(`${encodeURIComponent(run)}/${action}`, body);
    console.log(`${result.run.id} · ${result.run.held && !["completed", "failed", "aborted", "moved"].includes(result.run.status) ? "held" : result.run.status}`);
  };
  program.command("orchestra:add <run> <task>").description("add a task to an active run")
    .option("--agent <agent>", "worker agent@model").option("--after <task>", "dependency task id")
    .action((run: string, text: string, opts: { agent?: string; after?: string }) => post(run, "tasks", { text, ...opts }));
  program.command("orchestra:skip <run> <task>").description("skip a task and its dependent tasks")
    .action((run: string, task: string) => post(run, `tasks/${encodeURIComponent(task)}/skip`));
  for (const action of ["hold", "release"]) program.command(`orchestra:${action} <run>`).description(`${action} task dispatch for a whole run`).action((run: string) => post(run, action));
  program.command("orchestra:say <run> <note>").description("send a note to current and future workers").action((run: string, text: string) => post(run, "say", { text }));
  program.command("orchestra:rerun <run>").description("run a saved plan again")
    .option("-w, --workers <fleet>", "replacement comma-separated fleet or @saved fleet").option("--only-failed", "repeat unsuccessful tasks on the source integration branch")
    .action((run: string, opts: { workers?: string; onlyFailed?: boolean }) => post(run, "rerun", { onlyFailed: !!opts.onlyFailed, ...(opts.workers ? { workers: opts.workers.split(",").map(s => s.trim()) } : {}) }));
  program.command("orchestra:diff <a> <b>").description("compare saved run outcomes, cost, time and files")
    .action(async (a: string, b: string) => console.log(JSON.stringify(await request(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`), null, 2)));
  program.command("orchestra:report <run>").description("read or save the run report").option("--md <file>", "save Markdown")
    .action(async (run: string, opts: { md?: string }) => {
      const report = await request<ReturnType<typeof runReport>>(`${encodeURIComponent(run)}/report`);
      if (opts.md) fs.writeFileSync(opts.md, report.markdown); else console.log(report.markdown);
    });
  program.commands.find(c => c.name() === "orchestra:approve")?.option("--plan <file>", "edited plan JSON (task array or { tasks })")
    .action(async (run: string, opts: { plan?: string }) => {
      await request(`${encodeURIComponent(run)}/approve`, opts.plan ? { plan: JSON.parse(fs.readFileSync(opts.plan, "utf8")) } : {});
      console.log("plan approved");
    });
  const start = program.commands.find(c => c.name() === "orchestrate");
  start?.option('--check <command>', 'command that must pass in each worker worktree')
    .option('--check-rounds <n>', 'worker repair rounds for failed checks (default 2)')
    .option('--task-minutes <n>', 'task time limit before asking you');
  // Keep the existing start/watch/apply action and its output contract intact.
  start?.hook("preAction", () => {
    const original = DaemonClient.prototype.startOrchestra;
    const opts = start.opts();
    DaemonClient.prototype.startOrchestra = function(id, body) {
      return original.call(this, id, { ...body, ...(opts.check !== undefined ? { check: opts.check } : {}),
        ...(opts.checkRounds !== undefined ? { checkRounds: Number(opts.checkRounds) } : {}),
        ...(opts.taskMinutes !== undefined ? { taskMinutes: Number(opts.taskMinutes) } : {}) });
    };
    start.hook("postAction", () => { DaemonClient.prototype.startOrchestra = original; });
  });
}
