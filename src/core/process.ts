/** Launch Node CLIs on Windows without passing prompts through cmd.exe.
 * npm's .cmd shims and Unix shebangs are not executable by CreateProcess.
 * Resolve those to their JavaScript entry point and keep every argument literal.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, execFile as nodeExecFile, execFileSync as nodeExecFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

/** A trusted, user-configured command line, using the native OS shell. */
export function shellInvocation(command: string): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true }
    : { command: "/bin/sh", args: ["-c", command] };
}

/** Carry a file placeholder through the environment so spaces and shell
 * characters in the file's name cannot become command syntax. */
export function fileCommand(template: string, file: string): { command: string; args: string[]; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean } {
  const quoted = process.platform === "win32" ? '"%LOOM_INPUT_FILE%"' : '"$LOOM_INPUT_FILE"';
  const command = template.replaceAll('"{file}"', quoted).replaceAll("'{file}'", quoted).replaceAll("{file}", quoted);
  return { ...shellInvocation(command), env: { ...process.env, LOOM_INPUT_FILE: file } };
}

export function findExecutable(command: string, env = process.env, cwd = process.cwd()): string | null {
  const dirs = /[/\\]/.test(command) ? [""] : (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.COM;.CMD;.BAT").split(";")] : [""];
  for (const dir of dirs) for (const ext of extensions) {
    const file = path.resolve(cwd, dir.replace(/^"|"$/g, ""), command + ext.toLowerCase());
    try { if (fs.statSync(file).isFile()) return file; } catch { /* try the next path */ }
  }
  return null;
}

export function commandInvocation(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string | URL } = {}): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args: [...args] };
  const file = findExecutable(command, options.env, typeof options.cwd === "string" ? options.cwd : undefined);
  if (!file || /\.(exe|com)$/i.test(file)) return { command: file ?? command, args: [...args] };
  let text: string;
  try { const fd = fs.openSync(file, "r"); try { const buf = Buffer.alloc(8192); text = buf.subarray(0, fs.readSync(fd, buf)).toString(); } finally { fs.closeSync(fd); } }
  catch { return { command: file, args: [...args] }; }
  if (/^#![^\r\n]*\bnode\b/.test(text) || /\.[cm]?js$/i.test(file)) return { command: process.execPath, args: [file, ...args] };
  // npm/cmd-shim uses %dp0% (older versions: %~dp0) for its own directory.
  // Only unwrap a Node launcher; a user's arbitrary batch file is not JavaScript.
  if (/\.(cmd|bat)$/i.test(file) && /node(?:\.exe)?/i.test(text)) {
    const entry = /"%(?:dp0%|~dp0)[\\/]([^"\r\n]+)"\s+%\*/i.exec(text)?.[1];
    if (entry) {
      const script = path.resolve(path.dirname(file), entry);
      if (fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
    }
  }
  // npm also writes an extensionless POSIX shim next to the .cmd file.
  if (!path.extname(file) && fs.existsSync(`${file}.cmd`)) return commandInvocation(`${file}.cmd`, args, options);
  return { command: file, args: [...args] };
}

export const spawn: typeof nodeSpawn = ((command: string, args: string[] | object = [], options: object = {}) => {
  if (!Array.isArray(args)) return nodeSpawn(command, { windowsHide: true, ...args });
  const spec = commandInvocation(command, args, options);
  return nodeSpawn(spec.command, spec.args, { windowsHide: true, ...options });
}) as typeof nodeSpawn;

export const execFile: typeof nodeExecFile = ((command: string, args: string[], ...rest: unknown[]) => {
  const options = (typeof rest[0] === "object" && rest[0] ? rest[0] : {}) as { env?: NodeJS.ProcessEnv; cwd?: string | URL };
  const spec = commandInvocation(command, args, options);
  return (nodeExecFile as Function)(spec.command, spec.args, { windowsHide: true, ...options }, ...rest.filter((v) => typeof v === "function"));
}) as typeof nodeExecFile;
Object.defineProperty(execFile, promisify.custom, { value: (command: string, args: string[], options = {}) => {
  const spec = commandInvocation(command, args, options);
  return promisify(nodeExecFile)(spec.command, spec.args, { windowsHide: true, ...options });
} });

export const execFileSync: typeof nodeExecFileSync = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string | URL; [key: string]: unknown } = {}) => {
  const spec = commandInvocation(command, args, options);
  return nodeExecFileSync(spec.command, spec.args, { windowsHide: true, ...options });
}) as typeof nodeExecFileSync;

/** Stop the Windows process tree while its parent still exists. This is
 * best-effort shutdown for ordinary sessions, not native-continuity containment.
 */
export async function stopWindowsTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await promisify(nodeExecFile)("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {
    try { child.kill(); } catch { /* already gone */ }
  });
}

/** Interrupt a pipe terminal's foreground children, preserving its cmd session. */
export async function stopWindowsChildren(parentPid: number): Promise<void> {
  const { stdout } = await promisify(nodeExecFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Select-Object -ExpandProperty ProcessId`], { windowsHide: true, timeout: 8000 });
  await Promise.all(stdout.split(/\s+/).filter(pid => /^\d+$/.test(pid)).map(pid =>
    promisify(nodeExecFile)("taskkill.exe", ["/pid", pid, "/T", "/F"], { windowsHide: true, timeout: 8000 }).catch(() => {})));
}
