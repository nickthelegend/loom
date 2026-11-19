import { captureTaskFiles } from "./results.js";
import { spawn } from "node:child_process";
import { stopWindowsTree } from "../process.js";

/** The shell is intentional: this is the command the run's author asked to check. */
export function doneCheck(command: string, cwd: string, signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", ended = false;
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-16000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const stop = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else void stopWindowsTree(child); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(stop, 5 * 60_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const finish = (ok: boolean, error = "") => {
      if (ended) return; ended = true;
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      resolve({ ok, output: (output + error).slice(-16000) });
    };
    child.on("error", e => finish(false, e.message));
    child.on("close", code => finish(code === 0 && !signal.aborted, code === 0 ? "" : `\nCheck exited ${code ?? "after interruption"}`));
  });
}

export class TaskChecks {
  private running = new Map<string, AbortController>();
  abort(key: string): void { this.running.get(key)?.abort(); }
  abortRun(id: string): void { for (const [key, ctl] of this.running) if (key.startsWith(`${id}/`)) ctl.abort(); }

  async run(run: import('../orchestra.js').OrchestraRun, task: import('../orchestra.js').OrchestraTask, host: {
    cancelled(): boolean;
    track<T>(operation: () => Promise<T>): Promise<T>;
    emit(ok: boolean, output: string): void;
  }): Promise<boolean> {
    if (!run.check) return true;
    const key = `${run.id}/${task.id}`, ctl = new AbortController();
    this.running.set(key, ctl);
    try {
      const result = await host.track(() => doneCheck(run.check!, task.dir!, ctl.signal));
      if (host.cancelled()) return false;
      await captureTaskFiles(run, task);
      if (host.cancelled()) return false;
      task.checkOutput = result.output;
      host.emit(result.ok, result.output);
      if (result.ok) return true;
      task.checkFailures = (task.checkFailures ?? 0) + 1;
      task.error = `Done check failed: ${run.check}\n${result.output}`;
      if (task.checkFailures <= (run.checkRounds ?? 2)) {
        task.queued.push(`Your done check failed. Fix it before finishing.\nCommand: ${run.check}\n${result.output}`);
        task.status = "pending";
      } else {
        task.status = "needs_input";
        run.status = "waiting_human";
        run.question = `Done checks exhausted for ${task.id}. Reassign or skip the task.`;
      }
      return false;
    } finally { this.running.delete(key); }
  }
}
