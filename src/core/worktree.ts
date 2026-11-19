/**
 * Working-tree inspection — the data behind "what code changed, per prompt".
 * Leaves the checkout and its index alone; snapshots use disposable indexes.
 * Every function degrades to empty results outside a git repo.
 */

import { execFile } from "./process.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PATCH_EVENT_LIMIT = 12_000; // per-turn patch stored in the event log
const PATCH_VIEW_LIMIT = 64_000; // full working-tree patch served to apps

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, strict = false, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout) =>
      err && strict ? reject(err) : resolve(err ? "" : stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

export interface ChangedFile {
  status: string; // porcelain XY code, e.g. " M", "??", "A "
  path: string;
}

export function parsePorcelain(porcelain: string): ChangedFile[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3).trim() }));
}

export async function porcelainStatus(dir: string): Promise<string> {
  // -uall lists files inside untracked directories (not just "?? dir/").
  return (await git(["status", "--porcelain", "-uall"], dir)).trimEnd();
}

/** Snapshot contents through a disposable index, including files not yet tracked. */
export async function contentSnapshot(dir: string): Promise<string> {
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"], dir)).trim();
  if (!gitDir) return "unavailable";
  const index = path.join(gitDir, `loom-turn-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = (await git(["rev-parse", "--verify", "HEAD"], dir)).trim();
    await git(head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], dir, env, true);
    const paths = (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir, undefined, true))
      .split("\0").filter(file => file && !isLoomState(file));
    await git(["rm", "-r", "--cached", "--ignore-unmatch", "--", ".loom"], dir, env, true);
    if (paths.length) await git(["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], dir, env, true, paths.join("\0") + "\0");
    const tree = (await git(["write-tree"], dir, env, true)).trim();
    return tree ? `tree:${tree}` : "unavailable";
  } catch { return "unavailable"; }
  finally { fs.rmSync(index, { force: true }); }
}

export interface TurnDiff {
  files: ChangedFile[];
  added: number;
  removed: number;
  patch: string;
  truncated: boolean;
}

/** Loom's own bookkeeping inside the project — never an agent's work. */
const isLoomState = (path: string) => path === ".loom" || path.startsWith(".loom/");

/**
 * Changes attributable to one turn, compared by contents rather than status.
 * Porcelain snapshots from older callers still use their status comparison.
 *
 * `.loom/` is not one of them. The event log, the prompt queue and the
 * adapters' session state live there and change while a turn runs; a project
 * that doesn't gitignore `.loom/` used to see them land in the turn's diff,
 * telling you the agent had edited files it never touched.
 */
export async function diffSinceSnapshot(dir: string, before: string): Promise<TurnDiff | null> {
  if (before === "unavailable") return null;
  if (before.startsWith("tree:")) {
    const after = await contentSnapshot(dir);
    if (!after.startsWith("tree:") || before === after) return null;
    const refs = [before.slice(5), after.slice(5)];
    const names = (await git(["diff", "--no-renames", "--name-status", "-z", ...refs, "--", ".", ":(exclude).loom"], dir)).split("\0");
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      if (names[i] && names[i + 1]) files.push({ status: names[i] === "A" ? "??" : ` ${names[i]}`, path: names[i + 1]! });
    }
    if (!files.length) return null;
    const paths = files.map(f => f.path);
    const numstat = await git(["diff", "--numstat", ...refs, "--", ...paths], dir);
    let added = 0;
    let removed = 0;
    for (const line of numstat.split("\n")) {
      const [a, r] = line.split("\t");
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    const patch = await git(["diff", ...refs, "--", ...paths], dir);
    const truncated = patch.length > PATCH_EVENT_LIMIT;
    return { files, added, removed, patch: truncated ? patch.slice(0, PATCH_EVENT_LIMIT) + "\n… (truncated)" : patch, truncated };
  }
  const after = await porcelainStatus(dir);
  const beforeSet = new Set(before.split("\n").filter(Boolean));
  const changedLines = after
    .split("\n")
    .filter((l) => l && !beforeSet.has(l) && !isLoomState(l.slice(3).trim()));
  if (!changedLines.length) return null;
  const files = parsePorcelain(changedLines.join("\n"));
  const paths = files.map((f) => f.path);

  let added = 0;
  let removed = 0;
  const numstat = await git(["diff", "HEAD", "--numstat", "--", ...paths], dir);
  for (const line of numstat.split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }

  let patch = await git(["diff", "HEAD", "--", ...paths], dir);
  const untracked = files.filter((f) => f.status === "??").map((f) => f.path);
  // A file the turn created isn't in `git diff HEAD`: count its lines and show
  // it as an addition, so a new page reads "+12", not "+0 −0".
  for (const rel of untracked) {
    const created = newFilePatch(dir, rel);
    added += created.lines;
    patch += (patch ? "\n" : "") + created.patch;
  }
  const truncated = patch.length > PATCH_EVENT_LIMIT;
  return {
    files,
    added,
    removed,
    patch: truncated ? patch.slice(0, PATCH_EVENT_LIMIT) + "\n… (truncated)" : patch,
    truncated,
  };
}

const NEW_FILES_SHOWN = 30;

/** A new file as a unified diff (text under 200KB; anything else as a one-line note). */
function newFilePatch(dir: string, rel: string): { patch: string; lines: number } {
  try {
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 200_000) return { patch: `?? new file: ${rel}`, lines: 0 };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { patch: `?? new file: ${rel} (binary)`, lines: 0 };
    const text = buf.toString("utf8");
    const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
    return {
      patch: [`diff --git a/${rel} b/${rel}`, "new file mode 100644", "--- /dev/null", `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"),
      lines: lines.length,
    };
  } catch {
    return { patch: `?? new file: ${rel}`, lines: 0 };
  }
}

export interface WorkingTree {
  git: boolean;
  branch?: string;
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
}

/** The project's current uncommitted state, for the Changes/Working-tree views. */
export async function workingTree(dir: string): Promise<WorkingTree> {
  const inside = (await git(["rev-parse", "--is-inside-work-tree"], dir)).trim() === "true";
  if (!inside) return { git: false, files: [], patch: "", truncated: false };
  const [branch, porcelain, rawPatch] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], dir),
    porcelainStatus(dir),
    git(["diff", "HEAD"], dir),
  ]);
  const files = parsePorcelain(porcelain);
  let patch = rawPatch;
  const untracked = files.filter((f) => f.status === "??").map((f) => f.path);
  if (untracked.length) {
    // the first few new files with their content, as a diff can show them; the rest (and Loom's own state) as a note
    let shown = 0;
    const parts = untracked.map((p) => (!p.startsWith(".loom/") && shown++ < NEW_FILES_SHOWN ? newFilePatch(dir, p).patch : `?? new file: ${p}`));
    patch += (patch ? "\n" : "") + parts.join("\n");
  }
  const truncated = patch.length > PATCH_VIEW_LIMIT;
  return {
    git: true,
    branch: branch.trim(),
    files,
    patch: truncated ? patch.slice(0, PATCH_VIEW_LIMIT) + "\n… (truncated)" : patch,
    truncated,
  };
}
