import { guardReviewCommit } from "./review-r4/verify.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { findSecrets, type SecretFinding } from "./secret-scan.js";

const overrides = new AsyncLocalStorage<boolean>();
export class SecretScanError extends Error {
  constructor(readonly findings: SecretFinding[]) {
    super(`Secret scan blocked this operation: ${findings.map(f => `${f.file}${f.line ? ":" + f.line : ""}: ${f.what}`).slice(0, 20).join("; ")}. Review the diff, then explicitly override this operation if intentional.`);
    this.name = "SecretScanError";
  }
}
export function withSecretOverride<T>(override: boolean, fn: () => T): T {
  return overrides.run(override, fn);
}

/** All Loom git launchers pass here, including automatic commits and team pushes. */
function guardSecrets(command: string, args: readonly string[], cwd?: string | URL, env?: NodeJS.ProcessEnv): void {
  if (!/^git(?:\.exe)?$/i.test(path.basename(command)) || overrides.getStore()) return;
  let dir = typeof cwd === "string" ? cwd : process.cwd();
  const globalArgs: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-C") { dir = path.resolve(dir, args[++i]!); continue; }
    if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree") { globalArgs.push(arg, args[++i]!); continue; }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) { globalArgs.push(arg); continue; }
    if (arg.startsWith("-")) continue;
    break;
  }
  const action = args[i];
  if (!["commit", "push", "commit-tree", "merge", "cherry-pick"].includes(action ?? "")) return;
  const git = (a: string[]) => String(execFileSync("git", [...globalArgs, "-c", "core.quotePath=false", "--no-pager", ...a], { cwd: dir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
  let diff: string;
  if (action === "commit") {
    diff = git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--text"]);
    // -a and path commits may include unstaged tracked content.
    const commitArgs = args.slice(i + 1);
    let paths = false;
    for (let j = 0; j < commitArgs.length; j++) {
      const a = commitArgs[j]!;
      if (["-m", "--message", "-F", "--file", "-C", "-c", "--reuse-message", "--reedit-message", "--author", "--date"].includes(a)) { j++; continue; }
      if (!a.startsWith("-")) paths = true;
    }
    if (paths || commitArgs.some(a => a === "--all" || /^-[^-]*a/.test(a) || a === "--")) diff += git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--text"]);
  } else if (action === "commit-tree") {
    const rest = args.slice(i + 1), tree = rest[0]!;
    const parentAt = rest.indexOf("-p");
    const parent = parentAt >= 0 ? rest[parentAt + 1]! : git(["hash-object", "-t", "tree", "--stdin"]).trim();
    diff = git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--text", parent, tree]);
  } else if (action === "merge" || action === "cherry-pick") {
    const rest = args.slice(i + 1);
    if (rest.some(a => ["--abort", "--quit", "--skip"].includes(a))) return;
    const refs: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      const arg = rest[j]!;
      if (["-m", "--message", "-s", "--strategy", "-X", "--strategy-option"].includes(arg)) { j++; continue; }
      if (!arg.startsWith("-")) refs.push(arg);
    }
    diff = refs.length ? git(["log", "--format=", "-p", "-m", "--root", "--no-ext-diff", "--no-textconv", "--no-renames", "--text", ...refs, "--not", "HEAD"])
      : git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--text"]);
  } else {
    const rest = args.slice(i + 1);
    if (rest.includes("--delete")) return;
    const positional: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      const arg = rest[j]!;
      if (["-o", "--push-option", "--receive-pack", "--exec"].includes(arg)) { j++; continue; }
      if (!arg.startsWith("-")) positional.push(arg);
    }
    const config = (key: string) => { try { return git(["config", "--get-all", key]).trim(); } catch { return ""; } };
    let branch = ""; try { branch = git(["symbolic-ref", "--short", "HEAD"]).trim(); } catch { /* detached HEAD needs an explicit refspec */ }
    const target = positional.shift() ?? (config(`branch.${branch}.pushRemote`) || config("remote.pushDefault") || config(`branch.${branch}.remote`) || "origin");
    const remote = /^[\w.-]+$/.test(target) ? target : "__loom_unknown_remote__";
    const specs = positional.length ? positional : config(`remote.${remote}.push`).split("\n").filter(Boolean);
    const refs: string[] = [];
    if (rest.includes("--mirror") || config(`remote.${remote}.mirror`) === "true") refs.push("--all");
    else if (rest.includes("--all") || rest.includes("--branches") || (!specs.length && config("push.default") === "matching")) refs.push("--branches");
    if (rest.includes("--tags") || rest.includes("--follow-tags")) refs.push("--tags");
    for (const spec of specs) {
      const source = spec.replace(/^\+/, "").split(":")[0]!;
      if (!source) continue;
      if (source.includes("*")) {
        for (const ref of git(["for-each-ref", "--format=%(refname)", source.startsWith("refs/") ? source : `refs/heads/${source}`]).trim().split("\n").filter(Boolean)) refs.push(ref);
      } else refs.push(git(["rev-parse", "--verify", "--end-of-options", `${source}^{commit}`]).trim());
    }
    if (!refs.length) { if (specs.length) return; refs.push("HEAD"); }
    // Scan each outgoing commit, including secrets added then removed. A net diff misses those.
    diff = git(["log", "--format=", "-p", "-m", "--root", "--no-ext-diff", "--no-textconv", "--no-renames", "--text", ...refs, "--not", `--remotes=${remote}`]);
  }
  const findings = findSecrets(diff);
  if (findings.length) throw new SecretScanError(findings);
}

export function guardGit(command: string, args: readonly string[], cwd?: string | URL, env?: NodeJS.ProcessEnv): void {
  guardSecrets(command, args, cwd, env);
  guardReviewCommit(command, args, cwd);
}
