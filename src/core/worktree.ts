/**
 * Working-tree inspection — the data behind "what code changed, per prompt".
 * Read-only git plumbing; every function degrades to empty results outside
 * a git repo.
 */

import { execFile } from "node:child_process";

const PATCH_EVENT_LIMIT = 12_000; // per-turn patch stored in the event log
const PATCH_VIEW_LIMIT = 64_000; // full working-tree patch served to apps

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? "" : stdout),
    );
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

export interface TurnDiff {
  files: ChangedFile[];
  added: number;
  removed: number;
  patch: string;
  truncated: boolean;
}

/**
 * Changes attributable to one turn: files whose porcelain line differs from
 * the pre-turn snapshot, with a patch limited to those files.
 */
export async function diffSinceSnapshot(dir: string, before: string): Promise<TurnDiff | null> {
  const after = await porcelainStatus(dir);
  const beforeSet = new Set(before.split("\n").filter(Boolean));
  const changedLines = after.split("\n").filter((l) => l && !beforeSet.has(l));
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
  if (untracked.length) {
    patch += (patch ? "\n" : "") + untracked.map((p) => `?? new file: ${p}`).join("\n");
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
    patch += (patch ? "\n" : "") + untracked.map((p) => `?? new file: ${p}`).join("\n");
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
