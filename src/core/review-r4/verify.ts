import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

export interface VerifyResult { command: string; ok: boolean; output: string; at: number }
interface Settings { verify?: string; verifyTimeoutMs?: number; hold?: boolean; last?: VerifyResult }
const reviewed = new AsyncLocalStorage<boolean>();
export const afterHumanReview = <T>(work: () => T): T => reviewed.run(true, work);
function settingsPath(dir: string) { return path.join(dir, ".loom", "review-r4.json"); }
export function reviewSettings(dir: string): Settings {
  try { return JSON.parse(fs.readFileSync(settingsPath(dir), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}
export function saveReviewSettings(dir: string, update: Partial<Settings>): Settings {
  const settings = { ...reviewSettings(dir), ...update };
  fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
  fs.writeFileSync(settingsPath(dir), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return settings;
}
export class VerifyError extends Error {
  constructor(readonly result: VerifyResult) { super(`Verify before commit failed: ${result.command}\n${result.output}`); }
}
/** Only the checkout containing this setting runs verification; never inherit it into worktrees. */
export async function verifyBeforeCommit(dir: string): Promise<VerifyResult | null> {
  const settings = reviewSettings(dir), command = settings.verify;
  if (!command?.trim()) return null;
  const timeoutMs = settings.verifyTimeoutMs ?? 600_000;
  const env = { ...process.env };
  for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"]) delete env[key];
  const last = await new Promise<VerifyResult>((resolve) => {
    const child = spawn(command, { cwd: dir, shell: true, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false, error = "";
    const collect = (chunk: string) => { output = (output + chunk).slice(-64_000); };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else if (child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", e => { error = e.message; });
    child.on("close", code => {
      clearTimeout(timer);
      if (error) collect("\n" + error);
      if (timedOut) collect(`\nVerification timed out after ${timeoutMs} ms (verifyTimeoutMs).`);
      resolve({ command, ok: code === 0 && !error && !timedOut, output, at: Date.now() });
    });
  });
  saveReviewSettings(dir, { last });
  if (!last.ok) throw new VerifyError(last);
  return last;
}
export const runVerify = verifyBeforeCommit;
/** Called after the existing secret check, for every Loom commit launcher. */
export function guardReviewCommit(command: string, args: readonly string[], cwd?: string | URL): boolean {
  if (!/^git(?:\.exe)?$/i.test(path.basename(command))) return false;
  let dir = typeof cwd === "string" ? cwd : cwd ? fileURLToPath(cwd) : process.cwd(), i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") { dir = path.resolve(dir, args[++i]!); continue; }
    if (["-c", "--git-dir", "--work-tree"].includes(a)) { i++; continue; }
    if (!a.startsWith("-")) break;
  }
  const action = args[i];
  if (!["commit", "commit-tree", "merge", "cherry-pick"].includes(action ?? "")) return false;
  if (action === "merge" || action === "cherry-pick") {
    const flags: string[] = [];
    for (let n = i + 1; n < args.length; n++) {
      if (["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option"].includes(args[n]!)) { n++; continue; }
      flags.push(args[n]!);
    }
    if (flags.some(a => ["--abort", "--quit", "--skip", "--no-commit"].includes(a))) return false;
  }
  if (action === "commit-tree" && args.some(a => a.startsWith("loom checkpoint:"))) return false;
  const settingsDir = path.resolve(dir);
  const settings = reviewSettings(settingsDir);
  if (settings.hold) {
    let merging = false;
    try {
      execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir, stdio: "ignore", timeout: 5000 });
      merging = true;
    } catch { /* An external commit or abort has completed the resolution. */ }
    if (!merging) saveReviewSettings(settingsDir, { hold: false });
    else if (!reviewed.getStore()) throw new Error("Conflict resolution is waiting for human review; review and commit from source control");
  }
  return false;
}
