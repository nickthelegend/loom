/**
 * Source control that does something.
 *
 * worktree.ts reads: what changed, what the patch is. This writes: stage,
 * unstage, discard, commit. The split is deliberate — reading is safe and runs
 * on a timer, writing touches your repository and only ever happens because you
 * clicked something.
 *
 * ## Why every path is checked instead of trusted
 *
 * These take file paths from an HTTP body, and `git checkout -- <path>` deletes
 * your work. A path that escapes the project ("../../etc/…") would let a paired
 * device discard files outside the repo entirely. Every path is resolved and
 * confirmed to sit inside the project before git sees it, and `--` separates
 * paths from flags so a file named `-f` can't become one.
 *
 * ## Why errors come back instead of being swallowed
 *
 * worktree.ts's git() resolves "" on failure, which is right for a read — a
 * missing branch name isn't worth an exception. It is wrong for a write: a
 * commit that silently does nothing is the worst outcome available. These throw
 * with git's own stderr, which is nearly always the actual answer ("nothing to
 * commit", "please tell me who you are").
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { logbook } from "./logbook.js";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Run git, and say what went wrong when it does. */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim();
        // git's own words beat ours: "nothing to commit, working tree clean" is
        // a better message than anything we'd write about exit code 1.
        reject(new GitError(firstLine(detail) || `git ${args[0]} failed`, detail));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/**
 * Keep a path inside the project.
 *
 * `git checkout -- <path>` is destructive and these paths arrive over HTTP from
 * a device that could be anywhere on your tailnet. Resolve, then prove it's
 * within the root — a prefix check on the un-normalised string would wave
 * "../.." straight through.
 */
export function safeRelPath(dir: string, rel: string): string {
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  const inside = full === root || full.startsWith(root + path.sep);
  if (!inside) throw new GitError(`"${rel}" is outside the project`, "");
  const out = path.relative(root, full);
  if (!out) throw new GitError("that's the project itself, not a file in it", "");
  return out;
}

function checkAll(dir: string, paths: string[]): string[] {
  if (!paths.length) throw new GitError("no files given", "");
  return paths.map((p) => safeRelPath(dir, p));
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], dir)).trim() === "true";
  } catch {
    return false;
  }
}

export async function stage(dir: string, paths: string[]): Promise<{ staged: string[] }> {
  const rels = checkAll(dir, paths);
  // `--` ends the flags: a file called "-f" is a file, not an option.
  await git(["add", "--", ...rels], dir);
  logbook.info("git", `staged ${rels.length} file${rels.length === 1 ? "" : "s"}`, rels.join("\n"));
  return { staged: rels };
}

export async function unstage(dir: string, paths: string[]): Promise<{ unstaged: string[] }> {
  const rels = checkAll(dir, paths);
  // Before the first commit there is no HEAD to restore *from*, and both of the
  // obvious commands — `reset HEAD --` and `restore --staged` — fail with
  // "fatal: could not resolve HEAD". (I wrote a comment here claiming restore
  // was immune. It isn't; a test said so.) `rm --cached` is the one that works
  // there, because it only ever removes the index entry.
  if (await hasCommits(dir)) await git(["restore", "--staged", "--", ...rels], dir);
  else await git(["rm", "--cached", "-q", "--", ...rels], dir);
  logbook.info("git", `unstaged ${rels.length} file${rels.length === 1 ? "" : "s"}`, rels.join("\n"));
  return { unstaged: rels };
}

/** Does HEAD resolve? False in a repo whose first commit hasn't happened. */
async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "HEAD"], dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw work away.
 *
 * The one operation here that can lose something you can't get back, so it is
 * the one that is loudest in the log. Tracked files are restored from the
 * index; untracked ones have nothing to restore to and must be deleted, which
 * `git checkout` won't do — hence `clean -f` for those, and hence the split.
 */
export async function discard(
  dir: string,
  paths: string[],
  untracked: string[] = [],
): Promise<{ discarded: string[] }> {
  const tracked = paths.length ? checkAll(dir, paths) : [];
  const toClean = untracked.length ? checkAll(dir, untracked) : [];
  if (!tracked.length && !toClean.length) throw new GitError("no files given", "");

  if (tracked.length) await git(["checkout", "--", ...tracked], dir);
  if (toClean.length) await git(["clean", "-fd", "--", ...toClean], dir);

  const all = [...tracked, ...toClean];
  logbook.warn("git", `discarded ${all.length} file${all.length === 1 ? "" : "s"} — this is not undoable`, all.join("\n"));
  return { discarded: all };
}

export interface CommitResult {
  sha: string;
  subject: string;
  files: number;
}

/**
 * Commit what's staged.
 *
 * Nothing is staged for you. "Commit all" is a convenience that has ended more
 * afternoons than it saved — an agent's stray file swept into your commit
 * because the button was easier than looking. If you want it in, stage it.
 */
export async function commit(dir: string, message: string): Promise<CommitResult> {
  const text = message.trim();
  if (!text) throw new GitError("a commit needs a message", "");

  const staged = (await git(["diff", "--cached", "--name-only"], dir)).trim();
  if (!staged) throw new GitError("nothing staged — tick the files you want in this commit", "");

  // -m twice would make a body; one message, passed as one arg, can contain
  // anything including newlines and quotes because it never touches a shell.
  await git(["commit", "-m", text], dir);
  const sha = (await git(["rev-parse", "--short", "HEAD"], dir)).trim();
  const files = staged.split("\n").filter(Boolean).length;
  logbook.info("git", `committed ${sha}: ${firstLine(text)}`, `${files} file(s)\n${staged}`);
  return { sha, subject: firstLine(text), files };
}

export interface GitStatus {
  branch: string;
  /** Commits ahead / behind the upstream, when there is one. */
  ahead: number;
  behind: number;
  upstream: string | null;
  staged: { status: string; path: string }[];
  unstaged: { status: string; path: string }[];
  untracked: string[];
}

/**
 * The status the UI needs: staged and unstaged as separate lists.
 *
 * Porcelain's XY is two columns for a reason — X is the index, Y is the working
 * tree — and a file can be in both at once (staged, then edited again). Flatten
 * that into one list and you get a checkbox that lies about what a commit will
 * contain.
 */
export async function status(dir: string): Promise<GitStatus> {
  if (!(await isRepo(dir))) {
    return { branch: "", ahead: 0, behind: 0, upstream: null, staged: [], unstaged: [], untracked: [] };
  }
  const porcelain = await git(["status", "--porcelain=v1", "-uall", "--branch"], dir).catch(() => "");
  const lines = porcelain.split("\n").filter(Boolean);

  let branch = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: { status: string; path: string }[] = [];
  const unstaged: { status: string; path: string }[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const [names, counts] = head.split(" [");
      const [local, up] = (names ?? "").split("...");
      branch = (local ?? "").trim();
      upstream = up ? up.trim() : null;
      if (counts) {
        ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
        behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
      }
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const file = line.slice(3).trim();
    if (x === "?" && y === "?") {
      untracked.push(file);
      continue;
    }
    // A file can be in both lists at once — staged, then edited again. That's
    // the truth, and hiding it is how you commit a version you never saw.
    if (x !== " ") staged.push({ status: x, path: file });
    if (y !== " ") unstaged.push({ status: y, path: file });
  }
  return { branch, ahead, behind, upstream, staged, unstaged, untracked };
}

/**
 * git that might touch the network (push/fetch), bounded by a timeout.
 *
 * The plain git() above has none, which is fine for local commands — they
 * finish or fail fast. A push against an unreachable or auth-prompting remote
 * hangs forever, and a hung request is a worse failure than a slow one. Auth is
 * delegated entirely to the user's own git credential helper; Loom stores no
 * tokens, the same posture as its gh usage.
 */
function gitNet(args: string[], cwd: string, timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || (err as Error).message).trim();
          const killed = (err as { killed?: boolean }).killed;
          reject(
            new GitError(
              killed ? "push timed out — is the remote reachable?" : firstLine(detail) || `git ${args[0]} failed`,
              detail,
            ),
          );
          return;
        }
        // push writes its progress to stderr even on success, so include it.
        resolve(String(stdout) + String(stderr));
      },
    );
  });
}

/**
 * Start version control here.
 *
 * Refuses if the directory is already inside a repo, so an accidental click
 * can't nest one repo inside another. Renames the initial branch to `main` when
 * git left it on `master` — safe because a just-init'd repo has no commits, and
 * it matches what remotes expect.
 */
export async function init(dir: string): Promise<{ branch: string }> {
  if (await isRepo(dir)) throw new GitError("this is already a git repository", "");
  await git(["init"], dir);
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir).catch(() => "")).trim();
  if (branch === "master") await git(["branch", "-m", "main"], dir).catch(() => {});
  logbook.info("git", "initialised a git repository", dir);
  return { branch: branch === "master" || !branch ? "main" : branch };
}

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** "2 hours ago" — git's own relative time. */
  relative: string;
  ts: number;
}

/** Recent commits, newest first. Empty in a repo whose first commit hasn't landed. */
export async function log(dir: string, limit = 30): Promise<Commit[]> {
  if (!(await hasCommits(dir))) return [];
  // Unit and record separators keep subjects with commas/newlines intact.
  const US = "\x1f";
  const RS = "\x1e";
  const fmt = ["%H", "%h", "%s", "%an", "%ar", "%at"].join(US) + RS;
  const n = String(Math.min(200, Math.max(1, Math.floor(limit) || 30)));
  const out = await git(["log", `--pretty=format:${fmt}`, "-n", n], dir).catch(() => "");
  return out
    .split(RS)
    .map((r) => r.replace(/^\n/, "").trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, short, subject, author, relative, at] = r.split(US);
      return {
        sha: sha ?? "",
        short: short ?? "",
        subject: subject ?? "",
        author: author ?? "",
        relative: relative ?? "",
        ts: Number(at ?? 0) * 1000,
      };
    });
}

/**
 * The unified diff for one file, HEAD → working tree (both staged and unstaged
 * changes). Before the first commit there's no HEAD, so it diffs against the
 * index instead. Empty string when nothing differs.
 */
export async function fileDiff(dir: string, rel: string): Promise<string> {
  const safe = safeRelPath(dir, rel);
  if (await hasCommits(dir)) return git(["diff", "HEAD", "--", safe], dir).catch(() => "");
  return git(["diff", "--", safe], dir).catch(() => "");
}

/**
 * The diff a commit would capture — staged changes, or the whole working tree
 * when nothing is staged yet. Used to write a commit message from. Bounded so a
 * giant refactor doesn't blow the LLM's context (the summary only needs the
 * shape of the change, not every line).
 */
export async function stagedDiff(dir: string, maxChars = 12_000): Promise<string> {
  let out = await git(["diff", "--cached"], dir).catch(() => "");
  if (!out.trim()) out = await git(["diff"], dir).catch(() => "");
  return out.length > maxChars ? out.slice(0, maxChars) + "\n… (truncated)" : out;
}

export interface Branches {
  current: string;
  all: string[];
}

/** Local branches and which one is checked out — for the checkout picker. */
export async function branches(dir: string): Promise<Branches> {
  if (!(await hasCommits(dir))) return { current: "", all: [] };
  const out = await git(["branch", "--format=%(refname:short)"], dir).catch(() => "");
  const all = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir).catch(() => "")).trim();
  return { current, all };
}

/**
 * Switch to a branch or commit.
 *
 * git refuses on its own when the switch would overwrite uncommitted changes,
 * and that refusal (with its list of the files at risk) is exactly the message
 * to surface — so we don't second-guess it, we just pass its stderr back. The
 * ref is character-validated because it reaches a git command, though `--`
 * already stops it being read as a flag.
 */
export async function checkout(dir: string, ref: string): Promise<{ ref: string; branch: string }> {
  const clean = ref.trim();
  if (!clean) throw new GitError("no ref given", "");
  if (!/^[\w./+-]+$/.test(clean)) throw new GitError(`"${clean}" is not a valid ref name`, "");
  await git(["checkout", clean], dir);
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir).catch(() => "")).trim();
  logbook.info("git", `checked out ${clean}`, dir);
  return { ref: clean, branch };
}

/**
 * Push to the upstream, setting it on the first push.
 *
 * A branch with no upstream needs `-u origin <branch>` once; after that a bare
 * `git push` is enough. Either way the network is bounded (gitNet) and auth is
 * the user's own credential helper. A repo with no remote at all fails with
 * git's "No configured push destination", which is the honest answer.
 */
export async function push(dir: string): Promise<{ branch: string; detail: string }> {
  if (!(await isRepo(dir))) throw new GitError("not a git repository", "");
  if (!(await hasCommits(dir))) throw new GitError("nothing to push — make a commit first", "");
  const st = await status(dir);
  const branch = st.branch || "HEAD";
  const detail = st.upstream
    ? await gitNet(["push"], dir)
    : await gitNet(["push", "-u", "origin", branch], dir);
  logbook.info("git", `pushed ${branch}`, detail.trim());
  return { branch, detail: detail.trim() };
}
