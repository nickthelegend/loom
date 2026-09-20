/**
 * Checkpoints: a point you can put the files back to.
 *
 * An agent turn can touch forty files, and the honest answer to "undo that"
 * used to be "read the diff and retype it". `turn_diff` looks like the answer
 * and isn't: its patch is truncated at 12KB, it records an untracked file as
 * the line `?? new file: <path>` with no content in it, and it carries no ref
 * to apply against. It is a thing to look at, not a thing to reverse.
 *
 * So this doesn't reverse anything. Before a turn runs, it writes down what
 * the working tree *was*, and rewinding puts that back.
 *
 * ## Why a commit on a hidden ref
 *
 * The capture has to include untracked files (an agent's first act is often to
 * create one), survive a daemon restart, and cost nothing in the common case
 * where nobody ever rewinds. It also must not touch anything the human can
 * see: not HEAD, not the current branch, not the index, not the stash stack —
 * a checkpoint that rewrote `git status` under someone mid-review would be
 * worse than no checkpoint.
 *
 * A tree written through a *temporary index* satisfies all of it. `git add -A`
 * against `GIT_INDEX_FILE=<tmp>` stages tracked and untracked alike without
 * going near the real index; `write-tree` turns that into a tree object;
 * `commit-tree` parents it on HEAD so the object survives gc; and the commit
 * is kept under `refs/loom/checkpoints/<id>`, which no branch listing shows.
 * This is what `git stash create` does internally, minus the stash stack that
 * belongs to the human.
 *
 * ## What is deliberately not captured
 *
 * Ignored files. `git add -A` honours `.gitignore`, so `node_modules`, build
 * output and — the one that matters — `.env` are never read, never written
 * into an object, and never restored. `.loom/` is ignored too, which is the
 * reason a rewind cannot eat the event log: history is what happened, and a
 * rewind that edited it would be a lie with a timestamp.
 *
 * ## Why restoring takes a checkpoint first
 *
 * Rewinding is destructive by definition — it is asking for work to go away.
 * The work it removes is nearly always work you wanted gone, and occasionally
 * it is four files you forgot you had open. So a restore captures the current
 * tree before it touches anything, and says where that landed. Rewind is
 * itself rewindable, or it is a trap.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";

import { GitError } from "./git.js";

/** Where checkpoints live. Not under refs/heads, so nothing lists them. */
const REF_PREFIX = "refs/loom/checkpoints";

/** How many to keep. Older ones are unreferenced and git collects them. */
export const KEEP_CHECKPOINTS = 60;

export interface Checkpoint {
  /** Sortable, unique, and readable in a ref name. */
  id: string;
  /** What was about to happen — the prompt, the goal, "before rewind". */
  label: string;
  /** The commit holding the captured tree. */
  commit: string;
  at: number;
  /** The branch HEAD was on, for saying where you are going back to. */
  branch: string | null;
  /** Files that differed from HEAD when it was taken (a size, not a diff). */
  dirty: number;
}

/** A restore's report: what it put back, and how to undo the putting back. */
export interface RestoreResult {
  restored: Checkpoint;
  /** The checkpoint taken of the tree the restore replaced. */
  undo: Checkpoint;
  /** Paths whose content the working tree no longer agrees with. */
  changed: string[];
}

function run(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          reject(new GitError(detail.split("\n").find((l) => l.trim())?.trim() || `git ${args[0]} failed`, detail));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

async function quiet(args: string[], cwd: string): Promise<string> {
  try {
    return (await run(args, cwd)).trim();
  } catch {
    return "";
  }
}

/** A temporary index path for this capture. Never the repository's own. */
function tmpIndex(dir: string, id: string): string {
  return `${dir.replace(/\/+$/, "")}/.git/loom-checkpoint-${id}.index`;
}

/**
 * Ids are minted from the clock and have to survive two captures in the same
 * millisecond — a restore takes its undo checkpoint immediately before the
 * one it is restoring, and on a fast machine those are the same tick.
 */
let lastStamp = 0;
function newId(): string {
  const now = Math.max(Date.now(), lastStamp + 1);
  lastStamp = now;
  return `c${now.toString(36)}`;
}

/**
 * Write down what the working tree is right now.
 *
 * Returns null when there is nothing a checkpoint could mean: no repository,
 * or a repository with no commits, where there is no HEAD to parent on and
 * nothing to go back to.
 */
export async function capture(dir: string, label: string): Promise<Checkpoint | null> {
  if ((await quiet(["rev-parse", "--is-inside-work-tree"], dir)) !== "true") return null;
  const head = await quiet(["rev-parse", "HEAD"], dir);
  if (!head) return null;

  const id = newId();
  const index = tmpIndex(dir, id);
  const env = { GIT_INDEX_FILE: index };
  try {
    // Start from HEAD so the tree is HEAD-plus-your-changes rather than
    // whatever happens to be staged, then take everything: modifications,
    // deletions and new files alike. .gitignore still applies, which is what
    // keeps .env and node_modules out of the object store.
    await run(["read-tree", "HEAD"], dir, env);
    await run(["add", "-A", "--", "."], dir, env);
    const tree = (await run(["write-tree"], dir, env)).trim();
    const commit = (
      await run(
        [
          "-c",
          "user.name=Loom",
          "-c",
          "user.email=loom@loom.local",
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          `loom checkpoint: ${label.replace(/\s+/g, " ").trim().slice(0, 120) || "unlabelled"}`,
        ],
        dir,
      )
    ).trim();
    await run(["update-ref", `${REF_PREFIX}/${id}`, commit], dir);

    const dirty = (await quiet(["diff", "--name-only", `${head}..${commit}`], dir)).split("\n").filter(Boolean).length;
    const branch = (await quiet(["rev-parse", "--abbrev-ref", "HEAD"], dir)) || null;
    const cp: Checkpoint = {
      id,
      label: label.trim().slice(0, 200),
      commit,
      at: Date.now(),
      branch: branch === "HEAD" ? null : branch,
      dirty,
    };
    await prune(dir, KEEP_CHECKPOINTS);
    return cp;
  } catch {
    // A checkpoint is a courtesy taken on a hot path. It must never be the
    // reason a turn doesn't run.
    return null;
  } finally {
    // The temporary index is scratch; leaving one behind would be litter, not
    // a failure, so this never throws.
    try {
      fs.rmSync(index, { force: true });
    } catch {
      /* disposable */
    }
  }
}

/** Every checkpoint this project holds, newest first. */
export async function list(dir: string): Promise<Checkpoint[]> {
  const out = await quiet(
    ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(subject)%09%(committerdate:unix)", REF_PREFIX],
    dir,
  );
  if (!out) return [];
  const rows: Checkpoint[] = [];
  for (const line of out.split("\n")) {
    const [ref, commit, subject, when] = line.split("\t");
    if (!ref || !commit) continue;
    const id = ref.slice(ref.lastIndexOf("/") + 1);
    rows.push({
      id,
      label: (subject ?? "").replace(/^loom checkpoint: /, ""),
      commit,
      at: Number(when) * 1000 || 0,
      branch: null,
      dirty: 0,
    });
  }
  // Ids are base36 milliseconds, so lexical order is chronological order.
  return rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function find(dir: string, id: string): Promise<Checkpoint | null> {
  if (!/^c[a-z0-9]+$/.test(id)) return null;
  return (await list(dir)).find((c) => c.id === id) ?? null;
}

/**
 * Put the working tree back to a checkpoint.
 *
 * Two commands do the work. `read-tree -u --reset` makes the index and the
 * working tree agree with the captured tree — restoring what changed and
 * deleting what the checkpoint didn't have. `clean -fd` then removes the
 * directories git leaves behind. Neither is given `-x`, so ignored files are
 * not touched: your `node_modules` survives, and so does your `.env`.
 *
 * HEAD does not move. A checkpoint is a working tree, not a history, and
 * rewinding your files should not rewrite your commits.
 */
export async function restore(dir: string, id: string): Promise<RestoreResult> {
  const target = await find(dir, id);
  if (!target) throw new GitError(`no checkpoint "${id}" in this project`, "");

  // Before anything is lost: a checkpoint of what is about to be replaced.
  // Without this, rewind is a one-way door, and the one time it matters is
  // the time someone rewinds past work they meant to keep.
  const undo = await capture(dir, `before rewinding to ${target.label.slice(0, 80)}`);
  if (!undo) throw new GitError("couldn't save the current files before rewinding — nothing was changed", "");

  // What this rewind will actually do, from the two captured trees rather
  // than from `git diff`, which cannot see an untracked file — and an
  // untracked file is precisely what a rewind deletes.
  const changed = (await quiet(["diff", "--name-only", `${undo.commit}..${target.commit}`], dir))
    .split("\n")
    .filter(Boolean);

  await run(["read-tree", "-u", "--reset", target.commit], dir);
  await run(["clean", "-f", "-d", "--", "."], dir);
  // read-tree moved the index to the checkpoint's tree as well as the files,
  // which would leave every restored change reading as *staged* — a rewind
  // that silently runs `git add` on your behalf. Putting the index back to
  // HEAD leaves `git status` saying what it would say if you had made those
  // edits by hand: modified, and untracked. --mixed touches the index only.
  await quiet(["reset", "-q", "--mixed", "HEAD"], dir);
  return { restored: target, undo, changed };
}

/** Drop all but the newest `keep`. The commits become unreferenced. */
export async function prune(dir: string, keep = KEEP_CHECKPOINTS): Promise<number> {
  const all = await list(dir);
  const drop = all.slice(Math.max(0, keep));
  for (const c of drop) await quiet(["update-ref", "-d", `${REF_PREFIX}/${c.id}`], dir);
  return drop.length;
}

/** Remove every checkpoint. For `loom rewind --forget`. */
export async function forgetAll(dir: string): Promise<number> {
  return prune(dir, 0);
}
