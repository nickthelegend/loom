/**
 * The board: every live piece of work in a project, in the order it flows —
 * working → needs you → in review → ready to merge.
 *
 * Two real sources, no invented rows:
 *  - Loom itself, for work that has no PR yet: which agents are running, and
 *    which are blocked on a question. That's the daemon's own state.
 *  - The project's GitHub remote via the user's `gh` CLI (see tasks.ts), for
 *    everything that reached a pull request: draft, review pending, changes
 *    requested, CI red, approved.
 *
 * The column a card lands in is *derived* from that state — it is never stored.
 * A card can be dragged (see the web app), but that only pins where you want to
 * see it; the badge keeps reporting what GitHub and the daemon actually say,
 * because neither is ours to rewrite from a drag.
 */

import { classifyGhFailure, ghRepo, runGh, type TaskUnavailable } from "./tasks.js";

/** The four columns, in flow order. */
export const BOARD_COLUMNS = ["working", "needs-you", "in-review", "ready"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** What a card is actually waiting on — the badge, and what picks its column. */
export type BoardState =
  | "working" // an agent is running right now
  | "input-needed" // an agent asked a question and stopped
  | "ci-failed" // the PR's checks are red
  | "changes-requested" // a reviewer asked for changes
  | "review-pending" // open PR, nobody has reviewed it
  | "draft" // draft PR
  | "approved" // reviewer said yes
  | "ready"; // approved and CI green — nothing left but the button

export interface BoardCard {
  /** Stable across refreshes: "pr-51" or "agent-claude". Drag state keys on it. */
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
  updatedAt?: string;
}

export interface BoardData {
  available: true;
  /** null when the project has no GitHub remote — agent cards still work. */
  repo: string | null;
  /** Present only when the PR half failed; the agent half is still real. */
  ghError?: { reason: TaskUnavailable["reason"]; detail: string };
  cards: BoardCard[];
}

export type BoardResult = BoardData | TaskUnavailable;

/** The daemon's own view of an agent, as /api/projects/:id reports it. */
export interface BoardAgent {
  id: string;
  kind: string;
  role: string;
  tier: string;
  busy: boolean;
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

/** Which column a state belongs in. The one place the flow is defined. */
export function columnFor(state: BoardState): BoardColumn {
  switch (state) {
    case "working":
      return "working";
    case "input-needed":
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
  opts: { limit?: number } = {},
): Promise<BoardResult> {
  const cards: BoardCard[] = [];

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
    // The agent half is real even when gh isn't set up — show it, and say why
    // the rest is missing rather than dropping the board entirely.
    if (repoRes.err.reason === "no-cli" || repoRes.err.reason === "no-remote") {
      return {
        available: true,
        repo: null,
        ghError: { reason: repoRes.err.reason, detail: repoRes.err.detail },
        cards,
      };
    }
    return repoRes.err;
  }

  try {
    const out = await runGh(["pr", "list", "--json", PR_FIELDS, "--limit", String(opts.limit ?? 30)], dir);
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
