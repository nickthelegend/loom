/**
 * Owner-requested installs and machine requirements (#403).
 * Approach credit: Agent Orchestrator's InstallDependencyDialog.tsx /
 * SystemRequirementsChecklist.tsx and T3 Code's WelcomeWizard.tsx.
 */
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "./process.js";
import { AGENT_INSTALLS, nodeOk, type InstallKind } from "./setup.js";
import { loomHome } from "./registry.js";
import { forgetProbes } from "../adapters/base.js";

export interface SetupCommand { command: string; args: readonly string[] }
export interface CommandResult { code: number | null; stdout: string; stderr: string }
export type SetupCommandRunner = (command: SetupCommand, opts: {
  timeoutMs: number;
  signal?: AbortSignal;
  line?: (stream: "stdout" | "stderr", line: string) => void;
}) => Promise<CommandResult>;

/** No shell, no inherited stdin, bounded output and a deadline even for a stuck installer. */
export const runSetupCommand: SetupCommandRunner = (spec, opts) => new Promise((resolve, reject) => {
  const child = spawn(spec.command, [...spec.args], { stdio: ["ignore", "pipe", "pipe"], shell: false, signal: opts.signal,
    env: { ...process.env, npm_config_update_notifier: "false" } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
  timer.unref();
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child[stream]!.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      output[stream] = (output[stream] + text).slice(-65536);
      pending += text;
      const lines = pending.split(/\r\n|[\r\n]/);
      pending = lines.pop()!;
      for (const line of lines) opts.line?.(stream, line.slice(0, 4096));
      while (pending.length >= 4096) { opts.line?.(stream, pending.slice(0, 4096)); pending = pending.slice(4096); }
    });
    child[stream]!.on("end", () => { pending += decoder.end(); if (pending) opts.line?.(stream, pending); });
  }
  child.once("error", err => { clearTimeout(timer); reject(err); });
  child.once("close", code => {
    clearTimeout(timer);
    if (timedOut) reject(new Error(`command timed out after ${opts.timeoutMs}ms`));
    else resolve({ code, ...output });
  });
});

export interface InstallResult { ok: boolean; version: string | null; error?: string }
/** WS frames are ordered within a kind. Subscribe before POST; the HTTP response
 * is authoritative. Output is transient, not replayed after reconnection.
 */
export type InstallEvent = { type: "setup:install"; kind: InstallKind } & (
  { phase: "started"; command: string } |
  { phase: "output"; stream: "stdout" | "stderr"; line: string } |
  ({ phase: "finished" } & InstallResult)
);
export class SetupInstallError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export class SetupInstaller {
  private active = new Set<InstallKind>();
  private controller = new AbortController();
  constructor(private readonly run: SetupCommandRunner = runSetupCommand) {}

  close(): void { this.controller.abort(); }

  async install(kind: unknown, emit: (event: InstallEvent) => void): Promise<InstallResult> {
    if (typeof kind !== "string" || !Object.hasOwn(AGENT_INSTALLS, kind)) throw new SetupInstallError("unknown install kind", 400);
    const selected = kind as InstallKind;
    if (this.active.has(selected)) throw new SetupInstallError("an install for this kind is already running", 409);
    if (this.controller.signal.aborted) throw new SetupInstallError("daemon is shutting down", 503);
    this.active.add(selected);
    const spec = AGENT_INSTALLS[selected];
    const signal = this.controller.signal;
    let result: InstallResult;
    try {
      emit({ type: "setup:install", kind: selected, phase: "started", command: [spec.command, ...spec.args].join(" ") });
      const installed = await this.run(spec, { timeoutMs: INSTALL_TIMEOUT_MS, signal,
        line: (stream, line) => emit({ type: "setup:install", kind: selected, phase: "output", stream, line }) });
      if (installed.code !== 0) throw new Error(installed.stderr.trim() || `installer exited ${installed.code}`);
      // A successful npm exit isn't enough: the daemon's PATH must be able to
      // execute the installed CLI. Authentication remains a separate step.
      forgetProbes();
      const detected = await this.run({ command: spec.bin, args: ["--version"] }, { timeoutMs: 10_000, signal });
      const version = (detected.stdout.trim() || detected.stderr.trim()).split(/\r?\n/)[0]?.slice(0, 200);
      if (detected.code !== 0 || !version) throw new Error("installed, but the CLI could not be detected on the daemon's PATH; restart Loom after fixing PATH");
      result = { ok: true, version };
    } catch (err) {
      const error = (err as Error).message;
      result = { ok: false, version: null, error: /EACCES|EPERM/i.test(error)
        ? `${error.slice(-2000)}\nUse a user-owned npm prefix or Node version manager, then retry. Loom never runs sudo.` : error.slice(-2000) };
    } finally { this.active.delete(selected); }
    emit({ type: "setup:install", kind: selected, phase: "finished", ...result });
    return result;
  }
}

export interface Requirement { ok: boolean; detail: string; fix: string; version?: string }
/** GET /api/setup/requirements. fix is display text, empty when ok. null means
 * an npm permission or disk probe was unavailable, never a successful check.
 * disk describes the filesystem containing npm's global prefix (LOOM_HOME if npm is missing).
 */
export interface SetupRequirements {
  node: Requirement;
  git: Requirement;
  npm: Requirement & { prefix: string | null; needsSudo: boolean | null };
  disk: Requirement & { freeBytes: number | null; minimumBytes: number };
}

function existingParent(file: string): string {
  while (!fs.existsSync(file) && path.dirname(file) !== file) file = path.dirname(file);
  return file;
}

export async function setupRequirements(run: SetupCommandRunner = runSetupCommand): Promise<SetupRequirements> {
  const probe = async (command: string, args: string[]): Promise<string | null> => {
    try { const r = await run({ command, args }, { timeoutMs: 10_000 }); return r.code === 0 ? r.stdout.trim() || null : null; }
    catch { return null; }
  };
  const [git, npm, prefix] = await Promise.all([probe("git", ["--version"]), probe("npm", ["--version"]), probe("npm", ["prefix", "-g"])]);
  let needsSudo: boolean | null = null;
  if (prefix && path.isAbsolute(prefix)) {
    try {
      // Both package files and executable shims must be writable. Inspecting
      // the closest existing parent also works before the first global install.
      for (const dir of [prefix, path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules"), path.join(prefix, "bin")]) {
        await fs.promises.access(existingParent(dir), fs.constants.W_OK);
      }
      needsSudo = false;
    } catch (err) { needsSudo = ["EACCES", "EPERM", "EROFS"].includes((err as NodeJS.ErrnoException).code ?? "") ? true : null; }
  }
  const minimumBytes = 512 * 1024 * 1024;
  let freeBytes: number | null = null;
  try { const stat = await fs.promises.statfs(existingParent(prefix && path.isAbsolute(prefix) ? prefix : loomHome())); freeBytes = stat.bavail * stat.bsize; }
  catch { /* An inaccessible filesystem is unknown, not empty. */ }
  const diskOk = freeBytes !== null && freeBytes >= minimumBytes;
  return {
    node: { ok: nodeOk(), version: process.versions.node, detail: `Node ${process.versions.node} (needs 22.5+)`, fix: nodeOk() ? "" : "Install Node 22.5 or newer and restart Loom" },
    git: { ok: Boolean(git), ...(git ? { version: git } : {}), detail: git ?? "Git not found", fix: git ? "" : "Install Git and restart Loom" },
    npm: { ok: Boolean(npm) && needsSudo === false, ...(npm ? { version: npm } : {}), prefix, needsSudo,
      detail: !npm ? "npm not found" : needsSudo === true ? "Global npm directory is not writable (EACCES/sudo required)" : needsSudo === null ? "Could not check global npm permissions" : "Global npm directory is writable",
      fix: npm && needsSudo === false ? "" : "Install Node/npm with a version manager or configure a user-owned npm prefix and PATH; Loom never runs sudo" },
    disk: { ok: diskOk, freeBytes, minimumBytes, detail: freeBytes === null ? "Disk space unavailable" : `${Math.floor(freeBytes / 1048576)} MiB free`, fix: diskOk ? "" : "Ensure at least 512 MiB is free on the install filesystem" },
  };
}
