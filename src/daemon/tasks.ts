/**
 * Issues and pull requests for a project, read through the user's own `gh`
 * CLI rather than a GitHub token of our own. gh already holds their auth, so
 * Loom needs no client id, no PAT, and no OAuth dance — the same bet the
 * adapters make by shelling out to the coding agents already installed.
 *
 * Everything here is real: when gh is missing, logged out, or the project has
 * no GitHub remote, we say so rather than showing an empty table that looks
 * like "no issues".
 */

import { execFile } from "node:child_process";
import { cliAvailable } from "../adapters/base.js";

/** Why a project can't list tasks, in words a setup panel can show. */
export type TaskUnavailable =
  | { available: false; reason: "no-cli"; detail: string }
  | { available: false; reason: "no-auth"; detail: string }
  | { available: false; reason: "no-remote"; detail: string }
  | { available: false; reason: "error"; detail: string };

export interface TaskItem {
  id: number;
  title: string;
  author: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  state: string;
  updatedAt: string;
  url: string;
  /** issue | pr — the table shows both through one shape. */
  kind: "issue" | "pr";
  draft?: boolean;
}

export interface TaskList {
  available: true;
  repo: string;
  items: TaskItem[];
  /**
   * The list hit the fetch limit, so it is a prefix of the real result — the
   * UI has to say so rather than let the last page read as the last issue.
   */
  capped: boolean;
}

export type TaskResult = TaskList | TaskUnavailable;

interface GhUser {
  login?: string;
  name?: string;
}
interface GhItem {
  number: number;
  title: string;
  author?: GhUser;
  labels?: { name: string; color: string }[];
  assignees?: GhUser[];
  state: string;
  updatedAt: string;
  url: string;
  isDraft?: boolean;
}

/** gh writes multi-line help after the cause; the first line is the cause. */
function firstLine(msg: string): string {
  return (msg.split("\n").find((l) => l.trim()) ?? msg).trim().slice(0, 300);
}

/**
 * Sort a gh failure into something a setup panel can say honestly, matched
 * against the messages gh actually prints (probed, not guessed).
 *
 * Order matters: gh's non-GitHub-remote message ("none of the git remotes …
 * point to a known GitHub host. To tell gh about a new GitHub host, please use
 * `gh auth login`") mentions auth login, so the remote checks must run first
 * or a GitLab remote gets reported as "signed out".
 *
 * Anything unrecognised is `error` carrying gh's own words — a timeout or a
 * 500 is not evidence that the project has no remote.
 */
export function classifyGhFailure(msg: string): TaskUnavailable {
  if (/no git remotes found|not a git repository|point to a known GitHub host/i.test(msg)) {
    return { available: false, reason: "no-remote", detail: firstLine(msg) };
  }
  if (/gh auth login|not logged in|authentication failed|requires authentication|bad credentials/i.test(msg)) {
    return { available: false, reason: "no-auth", detail: firstLine(msg) };
  }
  return { available: false, reason: "error", detail: firstLine(msg) };
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

/**
 * Run gh in a project. Shared with board.ts — `execFile` with an args array, so
 * nothing a caller passes can reach a shell.
 */
export function runGh(args: string[], cwd: string): Promise<string> {
  return run("gh", args, cwd);
}

/** Which GitHub repo is this directory, if any — or why we can't tell. */
export async function ghRepo(
  dir: string,
): Promise<{ ok: true; repo: string } | { ok: false; err: TaskUnavailable }> {
  if (!(await cliAvailable("gh"))) {
    return {
      ok: false,
      err: { available: false, reason: "no-cli", detail: "GitHub CLI not found. Install gh, then reload." },
    };
  }
  try {
    const repo = (
      await runGh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], dir)
    ).trim();
    return { ok: true, repo };
  } catch (err) {
    return { ok: false, err: classifyGhFailure(String((err as Error).message)) };
  }
}

/** Map gh's shape onto ours, so the client renders issues and PRs the same. */
function normalize(raw: GhItem[], kind: "issue" | "pr"): TaskItem[] {
  return raw.map((r) => ({
    id: r.number,
    title: r.title,
    author: r.author?.login ?? "",
    labels: (r.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    assignees: (r.assignees ?? []).map((a) => a.login ?? "").filter(Boolean),
    state: String(r.state ?? "").toLowerCase(),
    updatedAt: r.updatedAt,
    url: r.url,
    kind,
    ...(r.isDraft ? { draft: true } : {}),
  }));
}

/**
 * List issues or PRs for the project's GitHub remote.
 * `search` is passed through to gh verbatim, so the box in the UI accepts the
 * same query language people already use on github.com.
 */
export async function listTasks(
  dir: string,
  opts: { kind?: "issue" | "pr"; search?: string; limit?: number } = {},
): Promise<TaskResult> {
  const kind = opts.kind ?? "issue";
  const repoRes = await ghRepo(dir);
  if (!repoRes.ok) return repoRes.err;
  const repo = repoRes.repo;

  const fields =
    kind === "pr"
      ? "number,title,author,labels,assignees,state,updatedAt,url,isDraft"
      : "number,title,author,labels,assignees,state,updatedAt,url";
  const limit = opts.limit ?? 60;
  const args = [kind, "list", "--json", fields, "--limit", String(limit)];
  // gh defaults to open-only; an explicit search must carry its own state
  // filter, which is exactly what the query box shows.
  if (opts.search?.trim()) args.push("--search", opts.search.trim());
  try {
    const out = await runGh(args, dir);
    const items = normalize(JSON.parse(out) as GhItem[], kind);
    return { available: true, repo, items, capped: items.length >= limit };
  } catch (err) {
    return classifyGhFailure(String((err as Error).message));
  }
}
