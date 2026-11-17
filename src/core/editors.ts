/** Editor launchers, inspired by T3 Code's editor labels and Agent Orchestrator's
 * Open in Editor action. Public views never expose executable paths.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { commandInvocation, spawn } from "./process.js";
import { ensureLoomHome, loomHome } from "./registry.js";

export interface EditorInfo { id: string; label: string }
interface Editor extends EditorInfo { executable: string }
const specs = [
  ["code", "VS Code", "Visual Studio Code", "Resources/app/bin/code"],
  ["cursor", "Cursor", "Cursor", "Resources/app/bin/cursor"],
  ["zed", "Zed", "Zed", "MacOS/cli"],
  ["windsurf", "Windsurf", "Windsurf", "Resources/app/bin/windsurf"],
  ["idea", "IntelliJ IDEA", "IntelliJ IDEA", "MacOS/idea"],
  ["webstorm", "WebStorm", "WebStorm", "MacOS/webstorm"],
  ["pycharm", "PyCharm", "PyCharm", "MacOS/pycharm"],
  ["goland", "GoLand", "GoLand", "MacOS/goland"],
  ["clion", "CLion", "CLion", "MacOS/clion"],
  ["rider", "Rider", "Rider", "MacOS/rider"],
  ["phpstorm", "PhpStorm", "PhpStorm", "MacOS/phpstorm"],
  ["rubymine", "RubyMine", "RubyMine", "MacOS/rubymine"],
  ["subl", "Sublime Text", "Sublime Text", "SharedSupport/bin/subl"],
] as const;

function executable(file: string): boolean {
  try { fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile(); }
  catch { return false; }
}

/** appDirs overrides standard macOS locations for isolated detection tests. */
export function detectEditors(opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; appDirs?: string[] } = {}): Editor[] {
  const env = opts.env ?? process.env, platform = opts.platform ?? process.platform;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const apps = opts.appDirs ?? ["/Applications", path.join(os.homedir(), "Applications")];
  const found: Editor[] = [];
  for (const [id, label, app, bin] of specs) {
    const candidates = dirs.flatMap(dir => platform === "win32" ? [path.join(dir, `${id}.exe`), path.join(dir, `${id}.cmd`)] : [path.join(dir, id)]);
    if (platform === "darwin") {
      const bundles = [app, ...(["idea", "pycharm"].includes(id) ? [`${app} CE`] : [])];
      candidates.push(...apps.flatMap(dir => bundles.map(bundle => path.join(dir, `${bundle}.app`, "Contents", bin))));
    }
    if (platform === "linux") candidates.push(`/usr/bin/${id}`, `/usr/local/bin/${id}`, `/snap/bin/${id}`, `/opt/${id}/bin/${id}.sh`);
    if (platform === "win32") {
      const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles].filter((v): v is string => !!v);
      const names: Record<string, string> = { code: "Code", cursor: "Cursor", windsurf: "Windsurf", subl: "sublime_text" };
      candidates.push(...roots.map(root => path.join(root, app === "Visual Studio Code" ? "Microsoft VS Code" : app, `${names[id] ?? id}.exe`)));
    }
    const file = candidates.find(executable);
    if (file) found.push({ id, label, executable: file });
  }
  if (platform === "darwin" && apps.some(dir => fs.existsSync(path.join(dir, "Xcode.app")))) {
    const xed = [...dirs.map(dir => path.join(dir, "xed")), "/usr/bin/xed"].find(executable);
    if (xed) found.push({ id: "xcode", label: "Xcode", executable: xed });
  }
  return found;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve existing ancestors too: a new file beneath a symlink must not escape. */
export function editorPath(projectDir: string, input = "."): string {
  if (input.includes("\0") || input.split(/[/\\]/).includes("..")) throw new Error("path must stay inside the project");
  const root = fs.realpathSync(projectDir);
  const target = path.resolve(projectDir, input);
  if (!inside(path.resolve(projectDir), target) && !inside(root, target)) throw new Error("path must stay inside the project");
  let parent = target;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = fs.realpathSync(parent);
      if (!inside(root, resolved)) throw new Error("path must stay inside the project (symlink escape)");
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink cannot be treated as a new file.
      try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("path contains a dangling symlink"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      missing.push(path.basename(parent));
      const next = path.dirname(parent);
      if (next === parent) throw new Error("cannot resolve path");
      parent = next;
    }
  }
}

export function editorArgs(id: string, file: string, line?: number): string[] {
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error("line must be a positive integer");
  if (!line) return [file];
  if (["code", "cursor", "windsurf"].includes(id)) return ["--goto", `${file}:${line}`];
  if (["zed", "subl"].includes(id)) return [`${file}:${line}`];
  if (id === "xcode") return ["--line", String(line), file];
  return ["--line", String(line), file];
}

/** One preference for the local OS user; their own paired devices share it. */
export function lastEditor(): string | null {
  try { const value = JSON.parse(fs.readFileSync(path.join(loomHome(), "editor.json"), "utf8")); return typeof value.editor === "string" ? value.editor : null; }
  catch { return null; }
}

/**
 * Windows launchers are often .cmd files (VS Code's `code`, Cursor's `cursor`), and Node refuses to
 * spawn those without a shell (EINVAL, since CVE-2024-27980). npm-style shims unwrap to the real
 * binary; anything else goes through cmd.exe with every argument quoted — and since cmd re-reads
 * that line, a path with a character it treats specially is refused rather than escaped.
 */
export function launchCommand(executable: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32") return { command: executable, args };
  const unwrapped = commandInvocation(executable, args);
  if (!/\.(cmd|bat)$/i.test(unwrapped.command)) return unwrapped;
  for (const part of [executable, ...args]) {
    if (/["%^&|<>!\r\n]/.test(part)) throw new Error("that path has a character the Windows editor launcher can't pass safely");
  }
  const line = [executable, ...args].map((part) => `"${part}"`).join(" ");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export async function openInEditor(projectDir: string, id: string, input?: string, line?: number): Promise<{ editor: string; path: string; line?: number }> {
  const file = editorPath(projectDir, input);
  const args = editorArgs(id, file, line);
  const editor = detectEditors().find(e => e.id === id);
  if (!editor) throw new Error(`editor "${id}" is not installed`);
  const run = launchCommand(editor.executable, args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(run.command, run.args, { cwd: projectDir, detached: true, stdio: "ignore", shell: false,
      ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  fs.writeFileSync(path.join(ensureLoomHome(), "editor.json"), JSON.stringify({ editor: id }), { mode: 0o600 });
  return { editor: id, path: file, ...(line !== undefined ? { line } : {}) };
}

export function parseEditorTarget(input: string): { path: string; line?: number } {
  const match = /^(.*):(\d+)$/.exec(input);
  if (!match) return { path: input };
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) throw new Error("line must be a positive integer");
  return { path: match[1]!, line };
}
