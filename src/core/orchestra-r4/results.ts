import { promisify } from "node:util";
import { execFile } from "../process.js";
import type { OrchestraRun, OrchestraTask } from "../orchestra.js";

const exec = promisify(execFile);
/** Include unfinished edits in reports without committing a failed check's work. */
export async function captureTaskFiles(run: OrchestraRun, task: OrchestraTask): Promise<void> {
  if (!task.dir || !task.branch) return;
  const git = async (args: string[]) => (await exec("git", args, { cwd: task.dir, maxBuffer: 4 * 1024 * 1024 })).stdout;
  try {
    const base = (await git(["merge-base", run.branch, task.branch])).trim();
    const [changed, untracked] = await Promise.all([git(["diff", "--name-only", "-z", base]), git(["ls-files", "--others", "--exclude-standard", "-z"])]);
    task.files = [...new Set([...(task.files ?? []), ...changed.split("\0"), ...untracked.split("\0")].filter(file => file && file !== ".loom" && !file.startsWith(".loom/")))];
  } catch { /* Old runs may have had their worktrees pruned; their saved file list still stands. */ }
}

export function taskDuration(run: OrchestraRun, task: OrchestraTask, now: number): number {
  const events = run.timeline?.filter(e => e.taskId === task.id) ?? [];
  const starts = events.filter(e => e.phase === "task_started");
  if (!starts.length) return task.startedAt ? Math.max(0, (task.finishedAt ?? now) - task.startedAt) : 0;
  return starts.reduce((total, start) => {
    const finish = events.find(e => e.phase === "task_finished" && e.attempt === start.attempt);
    return total + Math.max(0, (finish?.at ?? (start.attempt === task.attempts ? task.finishedAt ?? now : start.at)) - start.at);
  }, 0);
}
