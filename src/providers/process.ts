/**
 * Harness processes for warm sessions. Each session's CLI runs in its own
 * process group, so stopping a session ends every tool it started, and the
 * stop resolves only once that group is gone.
 */

import { type ChildProcess } from "node:child_process";
import { spawn, stopWindowsTree } from "../core/process.js";
import { agentEnv, quiesceProcessGroup } from "../adapters/base.js";

export interface HarnessProcess {
  child: ChildProcess;
  /** The last ~4 KB of stderr. */
  stderr: () => string;
  /** Resolves when the process has closed (exit and pipes). */
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawn a harness CLI in its own process group, with pipes on all three streams. */
export function spawnHarness(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): HarnessProcess {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? agentEnv(),
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let tail = "";
  child.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once("close", (code, signal) => resolve({ code, signal })));
  // A spawn failure (ENOENT) closes the process too; the caller reads child.pid.
  child.on("error", () => {});
  return { child, stderr: () => tail, closed };
}

/** Wait for a spawned process to either get a pid or fail to launch. */
export function launched(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
};

/**
 * End a harness: close stdin, give it `graceMs` to exit, then SIGTERM and
 * SIGKILL its group. Resolves once the process and its group are gone; rejects
 * (NativeQuiescenceUnknown) when the group cannot be proven dead.
 */
export async function stopHarness(proc: HarnessProcess, graceMs = 2000): Promise<void> {
  const { child } = proc;
  const timeout = (ms: number) => new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms).unref());
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      await stopWindowsTree(child);
      if (await Promise.race([proc.closed, timeout(6000)]) === "timeout") throw new Error("Windows agent process did not close after shutdown");
      return;
    }
    child.stdin?.end();
    if (await Promise.race([proc.closed, timeout(graceMs)]) === "timeout") {
      signalGroup(child, "SIGTERM");
      if (await Promise.race([proc.closed, timeout(3000)]) === "timeout") {
        signalGroup(child, "SIGKILL");
        await Promise.race([proc.closed, timeout(3000)]);
      }
    }
  }
  if (child.pid && process.platform !== "win32") await quiesceProcessGroup(child.pid);
}
