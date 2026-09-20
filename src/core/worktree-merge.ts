/**
 * Carrying an agent's work across the baton.
 *
 * `worktreePerAgent` gives every agent its own checkout on `agent/<id>`, which
 * is what stops two of them colliding in the filesystem. The cost is that the
 * work stops travelling: hand the baton from A to B and B's tree still holds
 * the state from before A started. Merging was left manual for exactly one
 * reason — a merge can conflict, and a conflict in the middle of a handoff is
 * a half-merged tree an agent is about to be prompted on top of.
 *
 * So this is opt-in (`git.mergeOnHandoff`), and it refuses more than it does:
 *
 *   - A's work must be committed. Uncommitted work is not on the branch, and
 *     merging the branch would hand B a convincing half of it.
 *   - B's tree must be clean. Merging into uncommitted work is how you get a
 *     state nobody can unpick.
 *   - A merge already in progress is never stacked on. It is reported, with
 *     the way out.
 *
 * When it does conflict it leaves the merge in place rather than aborting —
 * the conflicts are the thing that has to be resolved, and throwing them away
 * would just hide that A and B disagree. Every outcome is a value, so the
 * handoff event and the incoming briefing can say exactly what happened.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type MergeOutcome =
  /** Nothing to do: no such branch, or its commits are already here. */
  | { state: "up-to-date"; detail?: string }
  /** Refused, with the reason a person can act on. */
  | { state: "blocked"; reason: string; files?: string[] }
  | { state: "merged"; commits: number; files: string[] }
  | { state: "conflict"; files: string[] };

interface Run {
  ok: boolean;
  out: string;
  err: string;
}

function git(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: String(stdout).trim(), err: String(stderr).trim() }),
    );
  });
}

/** Loom's own bookkeeping is never the agent's uncommitted work. */
const isLoomState = (p: string) => p === ".loom" || p.startsWith(".loom/");

async function dirtyFiles(dir: string): Promise<string[]> {
  const st = await git(["status", "--porcelain", "-uall"], dir);
  if (!st.ok) return [];
  return st.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter((p) => p && !isLoomState(p));
}

async function mergeInProgress(dir: string): Promise<boolean> {
  const top = await git(["rev-parse", "--git-dir"], dir);
  if (!top.ok) return false;
  return fs.existsSync(path.resolve(dir, top.out, "MERGE_HEAD"));
}

/**
 * Merge `branch` into the checkout at `into`.
 *
 * `sourceDir` is where that branch's agent works: it's checked for
 * uncommitted changes, because those are the ones the merge would miss.
 */
export async function mergeAgentWork(opts: {
  into: string;
  branch: string;
  sourceDir?: string;
  message: string;
}): Promise<MergeOutcome> {
  const { into, branch, sourceDir, message } = opts;

  const inside = await git(["rev-parse", "--is-inside-work-tree"], into);
  if (!inside.ok || inside.out !== "true") {
    return { state: "up-to-date", detail: "not a git repository" };
  }
  const known = await git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], into);
  if (!known.ok) return { state: "up-to-date", detail: `no branch "${branch}" yet` };

  if (await mergeInProgress(into)) {
    return {
      state: "blocked",
      reason: `a merge is already in progress in ${path.basename(into)} — finish it, or "git merge --abort" there`,
    };
  }

  // A's uncommitted work isn't on A's branch. Merging anyway would hand over a
  // convincing half of it, so say what's missing instead.
  if (sourceDir && sourceDir !== into) {
    const pending = await dirtyFiles(sourceDir);
    if (pending.length) {
      return {
        state: "blocked",
        reason: `"${branch}" has ${pending.length} uncommitted file${pending.length === 1 ? "" : "s"} — commit them (or turn on git.commitPerTurn) and they'll travel`,
        files: pending.slice(0, 20),
      };
    }
  }

  const ancestor = await git(["merge-base", "--is-ancestor", branch, "HEAD"], into);
  if (ancestor.ok) return { state: "up-to-date", detail: `"${branch}" is already in this tree` };

  const mine = await dirtyFiles(into);
  if (mine.length) {
    return {
      state: "blocked",
      reason: `${path.basename(into)} has ${mine.length} uncommitted file${mine.length === 1 ? "" : "s"} — a merge on top of those is a state nobody can unpick`,
      files: mine.slice(0, 20),
    };
  }

  const count = await git(["rev-list", "--count", `HEAD..${branch}`], into);
  const names = await git(["diff", "--name-only", `HEAD...${branch}`], into);
  const files = names.ok ? names.out.split("\n").filter(Boolean) : [];

  const merged = await git(["merge", "--no-ff", "-m", message, branch], into);
  if (merged.ok) return { state: "merged", commits: Number(count.out) || 0, files };

  const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], into);
  const list = conflicted.ok ? conflicted.out.split("\n").filter(Boolean) : [];
  if (!list.length) {
    // Failed for some other reason; git's own words are the better message.
    return { state: "blocked", reason: merged.err.split("\n")[0] || "the merge failed" };
  }
  return { state: "conflict", files: list };
}

/** The outcome as a line for the handoff briefing and the thread. */
export function describeMerge(outcome: MergeOutcome, from: string, to: string): string {
  if (outcome.state === "merged") {
    const n = outcome.commits;
    return `Merged ${n} commit${n === 1 ? "" : "s"} from ${from} into ${to}: ${outcome.files.slice(0, 8).join(", ")}${outcome.files.length > 8 ? `, +${outcome.files.length - 8} more` : ""}.`;
  }
  if (outcome.state === "conflict") {
    return `The merge from ${from} into ${to} CONFLICTS in ${outcome.files.length} file${outcome.files.length === 1 ? "" : "s"}: ${outcome.files.join(", ")}. The merge is still in progress in your working tree — resolve those files and commit, or "git merge --abort" to undo it. Nothing else should be done until it's settled.`;
  }
  if (outcome.state === "blocked") {
    return `${from}'s work did not travel: ${outcome.reason}.`;
  }
  return "";
}
