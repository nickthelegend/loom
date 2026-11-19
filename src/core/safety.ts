import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loomHome } from "./registry.js";

export type PermissionPreset = "strict" | "normal" | "trusting";
export interface SafetyPolicy {
  preset: PermissionPreset;
  allow: string[];
  deny: string[];
  protectedPaths: string[];
  shellDeny: string[];
  approvalTimeoutMin: number;
}
export const SAFETY_PRESETS: Record<PermissionPreset, SafetyPolicy> = {
  strict: { preset: "strict", allow: [], deny: [], protectedPaths: [".env", ".env.*", ".git/**", ".loom/**"], shellDeny: [], approvalTimeoutMin: 5 },
  normal: { preset: "normal", allow: [], deny: [], protectedPaths: [], shellDeny: [], approvalTimeoutMin: 30 },
  trusting: { preset: "trusting", allow: [], deny: [], protectedPaths: [], shellDeny: [], approvalTimeoutMin: 60 },
};
export const presetMode = { strict: "ask", normal: "auto", trusting: "bypass" } as const;

export function parseSafety(value: unknown): SafetyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("safety must be an object");
  const b = value as Record<string, unknown>;
  if (!Object.hasOwn(SAFETY_PRESETS, String(b.preset))) throw new Error("preset must be strict, normal or trusting");
  const result = structuredClone(SAFETY_PRESETS[b.preset as PermissionPreset]);
  for (const key of Object.keys(b)) if (!Object.hasOwn(result, key)) throw new Error(`unknown safety setting: ${key}`);
  for (const key of ["allow", "deny", "protectedPaths", "shellDeny"] as const) {
    if (b[key] === undefined) continue;
    const list = b[key];
    if (!Array.isArray(list) || list.length > 100 || list.some(p => typeof p !== "string" || !p.trim() || p.length > 256 || /[\0\r\n]/.test(p))) throw new Error(`${key} needs up to 100 nonempty patterns`);
    result[key] = list.map(p => (p as string).trim());
  }
  if (b.approvalTimeoutMin !== undefined) {
    const n = b.approvalTimeoutMin;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0.001 || n > 1440) throw new Error("approvalTimeoutMin must be between 0.001 and 1440");
    result.approvalTimeoutMin = n;
  }
  if (result.protectedPaths.some(p => path.isAbsolute(p) || p.split(/[\\/]/).includes(".."))) throw new Error("protectedPaths must be relative to the project, without ..");
  return result;
}

function policyFile(project: string): string {
  return path.join(loomHome(), "safety", createHash("sha256").update(project).digest("hex") + ".json");
}
/** Keep policy outside the checkout so repository edits do not silently change it. */
export function readSafety(project: string): SafetyPolicy | null {
  const file = policyFile(project);
  if (!fs.existsSync(file)) return null;
  return parseSafety(JSON.parse(fs.readFileSync(file, "utf8")));
}
export function writeSafety(project: string, policy: SafetyPolicy): void {
  const file = policyFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(parseSafety(policy), null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

/** * spans a name; ** spans directories; ? matches one character. */
export function safetyGlob(pattern: string, value: string, paths = false): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (paths && pattern[i + 1] === "/") { source += "(?:.*/)?"; i++; }
      else source += ".*";
    } else if (c === "*") source += paths ? "[^/]*" : ".*";
    else if (c === "?") source += paths ? "[^/]" : ".";
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + source + "$", "i").test(value);
}
export function hasSafetyRules(p: SafetyPolicy): boolean {
  return Boolean(p.allow.length || p.deny.length || p.protectedPaths.length || p.shellDeny.length);
}

const READ = /^(Read|Glob|Grep|LS|NotebookRead|read_file|list_files|search|file_read)$/i;
const WRITE = /^(Edit|Write|MultiEdit|NotebookEdit|write_file|file_change|apply_patch)$/i;
const SHELL = /^(Bash|shell|run|run_command|exec_command|execute|terminal)$/i;

function canonical(file: string, seen = new Set<string>()): string {
  if (seen.has(file)) throw new Error("cyclic path");
  seen.add(file);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) return file;
    return path.join(canonical(parent, seen), path.basename(file));
  }
  if (stat.isSymbolicLink()) return canonical(path.resolve(path.dirname(file), fs.readlinkSync(file)), seen);
  return fs.realpathSync(file);
}

/** Hard denials precede allows and human approval, including Bypass. */
export function safetyDecision(tool: string, input: Record<string, unknown>, dir: string, p: SafetyPolicy): { deny?: string; allow?: boolean } {
  if (p.deny.some(pattern => safetyGlob(pattern, tool))) return { deny: `Tool ${tool} is denied by project policy.` };
  if (SHELL.test(tool)) {
    const command = String(input.command ?? input.cmd ?? "");
    const normalized = command.replace(/["'\\]/g, "").replace(/\s+/g, " ").trim();
    if (p.shellDeny.some(pattern => safetyGlob(pattern, command) || safetyGlob(`*${pattern}*`, normalized))) return { deny: "Command matches the project's shell denylist." };
    // Shells, interpreters and build scripts can write through aliases and computed paths.
    // Without an OS path sandbox the only honest guarantee is to refuse them.
    if (p.protectedPaths.length) return { deny: "Shell commands are disabled while protected paths are configured." };
  }
  if (p.protectedPaths.length && !READ.test(tool) && !WRITE.test(tool)) return { deny: "This tool cannot enforce protected paths." };
  if (p.protectedPaths.length && WRITE.test(tool)) {
    const raw = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof raw !== "string" || !raw) return { deny: "A protected-path write needs an explicit file path." };
    let root: string, target: string;
    try {
      root = canonical(dir); target = canonical(path.resolve(dir, raw));
      if (fs.existsSync(target) && fs.statSync(target).isFile() && fs.statSync(target).nlink > 1) return { deny: "Hard-linked files cannot be edited while protected paths are configured." };
    } catch { return { deny: "Cannot verify this write against protected paths." }; }
    const targets = [path.relative(dir, path.resolve(dir, raw)), path.relative(root, target)].map(v => v.replaceAll("\\", "/"));
    if (targets.some(v => v === ".." || v.startsWith("../") || path.isAbsolute(v))) return { deny: "Writes outside the project are disabled while protected paths are configured." };
    if (targets.some(v => p.protectedPaths.some(pattern => safetyGlob(pattern, v, true) || safetyGlob(pattern.replace(/\/$/, "") + "/**", v, true)))) return { deny: "This path is protected; agents may never edit it." };
  }
  return { allow: p.allow.some(pattern => safetyGlob(pattern, tool)) };
}
