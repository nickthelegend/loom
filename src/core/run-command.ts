/**
 * Run one shell command to completion in a contained process group: a
 * project's tests, for a crew's card or a Proof re-run. Stops on timeout or
 * abort (the whole group, so a test runner's workers go too) and keeps the
 * tail of the output — where runners print their totals.
 */
import { interruptProcess } from "../adapters/base.js";
import { launched } from "../providers/process.js";
import { shellInvocation, spawnContained } from "./process.js";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr interleaved, the last `keep` characters. */
  output: string;
  ms: number;
}

export async function runCommand(command: string, cwd: string, opts: { timeoutMs: number; signal?: AbortSignal; keep?: number; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  const keep = opts.keep ?? 8000;
  const started = Date.now();
  const shell = shellInvocation(command);
  const child = spawnContained(shell.command, shell.args, { windowsVerbatimArguments: shell.windowsVerbatimArguments, cwd,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...opts.env } });
  let output = "", launchError = "", timedOut = false, stop: Promise<void> | undefined;
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-keep); };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  child.on("error", error => { launchError = error.message; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  let failStop!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { failStop = reject; });
  void stopped.catch(() => {});
  const halt = () => { stop ??= interruptProcess(child, true); void stop.catch(failStop); };
  const signal = opts.signal;
  signal?.addEventListener("abort", halt, { once: true });
  if (signal?.aborted) halt();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => { timedOut = true; halt(); }, opts.timeoutMs);
    await launched(child);
    const code = await Promise.race([closed, stopped]);
    await (stop ?? interruptProcess(child, true));
    return { ok: code === 0 && !timedOut && !signal?.aborted, exitCode: code, timedOut, ms: Date.now() - started,
      output: `${output.trim() || launchError}${timedOut ? `\n(timed out after ${Math.round(opts.timeoutMs / 1000)}s)` : ""}` };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", halt); await (stop ?? interruptProcess(child, true)); }
}
