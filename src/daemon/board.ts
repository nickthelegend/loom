/**
 * The board: every piece of work in a project, in the order it flows —
 * working → needs you → in review → ready to merge.
 *
 * Three sources, no invented rows:
 *  - You: cards you wrote (`own: true`). The column you put it in IS its
 *    state — there's nothing else it could be — so dragging one really moves
 *    it, and it persists in .loom/state.json.
 *  - Loom, for work with no PR yet: which agents are running, and which are
 *    blocked on a question. The daemon's own state.
 *  - The project's GitHub remote via the user's `gh` CLI (see tasks.ts), for
 *    everything that reached a pull request: draft, review pending, changes
 *    requested, CI red, approved.
 *
 * The last two are *derived* and never stored. Dragging one of those only pins
 * where you want to see it; the badge keeps reporting what GitHub and the
 * daemon actually say, because neither is ours to rewrite from a drag. That's
 * the difference `own` marks.
 */

import type { BoardTask } from "../core/registry.js";
import { classifyGhFailure, ghRepo, runGh, type TaskUnavailable } from "./tasks.js";

/** The four columns, in flow order. */
export const BOARD_COLUMNS = ["working", "needs-you", "in-review", "ready"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** What a card is actually waiting on — the badge, and what picks its column. */
export type BoardState =
  | "working" // an agent is running right now
  | "input-needed" // an agent asked a question and stopped
  | "issue" // an open issue: nobody has started it
  | "ci-failed" // the PR's checks are red
  | "changes-requested" // a reviewer asked for changes
  | "review-pending" // open PR, nobody has reviewed it
  | "draft" // draft PR
  | "approved" // reviewer said yes
  | "ready"; // approved and CI green — nothing left but the button

export interface BoardCard {
  /** Stable across refreshes: "pr-51", "agent-claude", "task-a1b2". Drag keys on it. */
  id: string;
  title: string;
  /** The agent that owns this work, when we know: an id for ours, a GitHub login for a PR. */
  agent: string;
  /** The agent's adapter kind, when this is one of ours — drives the brand mark. */
  kind?: string;
  state: BoardState;
  column: BoardColumn;
  /** PR branch, when there is a PR. */
  branch?: string;
  pr?: { number: number; state: string; draft: boolean; url: string };
  /** An open issue matched by your search — nobody has started it yet. */
  issue?: { number: number; url: string };
  updatedAt?: string;
  /**
   * A card you wrote. Its column is its state, so dragging one really moves it
   * — nothing to contradict. Derived cards (agents, PRs) report someone else's
   * truth and can only be pinned.
   */
  own?: boolean;
}

export interface BoardData {
  available: true;
  /** null when we couldn't read a GitHub repo here — agent cards still work. */
  repo: string | null;
  /** Present only when the PR half failed; the agent half is still real. */
  ghError?: { reason: TaskUnavailable["reason"]; detail: string };
  cards: BoardCard[];
}

/**
 * Always available. The agent half of the board is the daemon's own state, so
 * there is no version of "gh is unhappy" that should leave you staring at an
 * error page instead of the agents you're running. gh's failure becomes a note.
 */
export type BoardResult = BoardData;

/** The daemon's own view of an agent, as /api/projects/:id reports it. */
export interface BoardAgent {
  id: string;
  kind: string;
  role: string;
  tier: string;
  busy: boolean;
}

interface GhIssue {
  number: number;
  title: string;
  author?: { login?: string };
  updatedAt: string;
  url: string;
}

interface GhPr {
  number: number;
  title: string;
  author?: { login?: string };
  headRefName?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  statusCheckRollup?: { conclusion?: string; state?: string }[] | null;
  state: string;
  updatedAt: string;
  url: string;
}

/**
 * The badge for a card you wrote, given the column you put it in. Derived
 * cards read their state from the world; yours reads from where you dragged it,
 * which is the only truth it has.
 */
const TASK_STATE: Record<BoardColumn, BoardState> = {
  working: "working",
  "needs-you": "input-needed",
  "in-review": "review-pending",
  ready: "ready",
};

/** Which column a state belongs in. The one place the flow is defined. */
export function columnFor(state: BoardState): BoardColumn {
  switch (state) {
    case "working":
      return "working";
    case "input-needed":
    case "issue":
    case "ci-failed":
    case "changes-requested":
      return "needs-you";
    case "review-pending":
    case "draft":
      return "in-review";
    case "approved":
    case "ready":
      return "ready";
  }
}

/**
 * Read a PR's real state. Order matters: a red build is worth your attention
 * before a pending review, and a draft is not "waiting on a reviewer".
 */
export function prState(pr: GhPr): BoardState {
  const checks = pr.statusCheckRollup ?? [];
  // gh reports either conclusion (completed) or state (in flight); only a
  // definitive failure is a failure — a queued or skipped check is not.
  const failed = checks.some((c) => {
    const v = String(c.conclusion ?? c.state ?? "").toUpperCase();
    return v === "FAILURE" || v === "TIMED_OUT" || v === "CANCELLED" || v === "ERROR";
  });
  if (failed) return "ci-failed";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (pr.isDraft) return "draft";
  if (pr.reviewDecision === "APPROVED") {
    // "ready" claims CI is green, so only say it when checks actually ran
    return checks.length ? "ready" : "approved";
  }
  return "review-pending";
}

const PR_FIELDS =
  "number,title,author,headRefName,isDraft,reviewDecision,statusCheckRollup,state,updatedAt,url";

/**
 * Build the board. `agents` is the daemon's live agent state; `blocked` is the
 * set of agent ids that asked a question and are waiting on the human (the
 * caller reads that from the event log — this module doesn't know about logs).
 */
export async function buildBoard(
  dir: string,
  agents: BoardAgent[],
  blocked: string[],
  opts: { limit?: number; tasks?: BoardTask[]; search?: string } = {},
): Promise<BoardResult> {
  const cards: BoardCard[] = [];

  // 0. Yours: cards you wrote. The column you put it in is the whole state.
  for (const t of opts.tasks ?? []) {
    const column = (BOARD_COLUMNS as readonly string[]).includes(t.column)
      ? (t.column as BoardColumn)
      : "working";
    cards.push({
      id: `task-${t.id}`,
      title: t.title,
      agent: t.agent ?? "",
      ...(t.agent ? { kind: agents.find((a) => a.id === t.agent)?.kind } : {}),
      state: TASK_STATE[column],
      column,
      own: true,
    });
  }

  // 1. Ours: work that has no PR yet. An agent is either running or waiting.
  for (const a of agents) {
    if (a.tier !== "adapter") continue; // a bridge never holds the baton
    const isBlocked = blocked.includes(a.id);
    if (!a.busy && !isBlocked) continue; // idle agents are not work in flight
    const state: BoardState = isBlocked ? "input-needed" : "working";
    cards.push({
      id: `agent-${a.id}`,
      title: isBlocked ? `${a.id} is waiting on you` : `${a.id} is working`,
      agent: a.id,
      kind: a.kind,
      state,
      column: columnFor(state),
    });
  }

  // 2. GitHub: everything that reached a PR.
  const repoRes = await ghRepo(dir);
  if (!repoRes.ok) {
    // EVERY gh failure degrades to a note — missing, signed out, no remote, a
    // timeout, a 500. The agents above are the daemon's own state and stay
    // true regardless, so none of these is a reason to show you an error page
    // instead of the work you're running.
    return {
      available: true,
      repo: null,
      ghError: { reason: repoRes.err.reason, detail: repoRes.err.detail },
      cards,
    };
  }

  // Issues only when you search for them. The board is work in flight; a repo's
  // whole backlog would bury that. A query is you asking, so we answer.
  if (opts.search?.trim() && !/\bis:pr\b/i.test(opts.search)) {
    try {
      const out = await runGh(
        [
          "issue",
          "list",
          "--json",
          "number,title,author,updatedAt,url",
          "--limit",
          String(opts.limit ?? 30),
          "--search",
          opts.search.trim(),
        ],
        dir,
      );
      for (const it of JSON.parse(out) as GhIssue[]) {
        cards.push({
          id: `issue-${it.number}`,
          title: it.title,
          agent: it.author?.login ?? "",
          state: "issue",
          column: columnFor("issue"),
          issue: { number: it.number, url: it.url },
          updatedAt: it.updatedAt,
        });
      }
    } catch {
      // the PR half below still runs; a failed issue search isn't the board
    }
  }

  // `gh pr list --search "is:issue …"` doesn't return nothing — it ignores the
  // qualifier and hands back open PRs, so searching for issues would also fill
  // the board with unrelated pull requests. Ask for what was actually asked for.
  if (opts.search?.trim() && /\bis:issue\b/i.test(opts.search)) {
    return { available: true, repo: repoRes.repo, cards };
  }

  try {
    const args = ["pr", "list", "--json", PR_FIELDS, "--limit", String(opts.limit ?? 30)];
    // Passed through to gh verbatim, so the box takes github.com's own query
    // language. execFile with an args array: it can't reach a shell.
    if (opts.search?.trim()) args.push("--search", opts.search.trim());
    const out = await runGh(args, dir);
    for (const pr of JSON.parse(out) as GhPr[]) {
      const state = prState(pr);
      cards.push({
        id: `pr-${pr.number}`,
        title: pr.title,
        agent: pr.author?.login ?? "",
        state,
        column: columnFor(state),
        ...(pr.headRefName ? { branch: pr.headRefName } : {}),
        pr: {
          number: pr.number,
          state: String(pr.state ?? "").toLowerCase(),
          draft: !!pr.isDraft,
          url: pr.url,
        },
        updatedAt: pr.updatedAt,
      });
    }
  } catch (err) {
    return {
      available: true,
      repo: repoRes.repo,
      ghError: classifyGhFailure(String((err as Error).message)),
      cards,
    };
  }

  return { available: true, repo: repoRes.repo, cards };
}
