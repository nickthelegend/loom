import fs from "node:fs";
import path from "node:path";
import { type Memory } from "../core/brain.js";
import { type LogLine, type ServerStatus } from "../core/servers.js";
import { type TieredMemory } from "../core/team-memory.js";
import type {
  LoomEvent
} from "../types.js";

/** How many models one ask may go to at once. */
export const MAX_FANOUT = 8;

export const PROJECTION_WINDOW = 400;
// recent events distilled on handoff

/**
 * How a budget pause is labelled in the shared quarantine map, so this guard
 * can tell its own pauses from the ones a firing alert put there.
 */
export const BUDGET_PAUSE_REASON = "budget ";

/** Local midnight — the day a "USD/day" budget is measured against. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A turn refused because the agent is at or over its daily spend budget.
 *
 * Typed (like NotHolderError) because the callers need to tell it apart: the
 * API answers it with a 409 and the numbers, and a route reports which step
 * couldn't start and why, rather than a generic failure.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly budgetUsd: number,
    public readonly spentUsd: number,
  ) {
    super(
      `agent "${agentId}" has spent $${spentUsd.toFixed(4)} today, at or over its $${budgetUsd.toFixed(2)}/day budget — raise the budget or wait for the day to roll over`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Thrown when a dispatch targets an agent a firing alert has paused.
 *
 * Separate from BudgetExceededError because the recovery is different and the
 * UI should say so: a budget pause lifts itself when the day rolls over or you
 * raise the cap, while this one lifts when the alert reports itself resolved.
 */
export class QuarantinedError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
    public readonly since: number,
  ) {
    super(
      `agent "${agentId}" is paused by a firing alert — ${reason}. It resumes when that alert resolves, or hand the baton to another agent.`,
    );
    this.name = "QuarantinedError";
  }
}

export const LOOM_ASK_TIMEOUT_MS = 15_000;

export const LOOM_ASK_TIMEOUT_MESSAGE =
  "The agent didn't reply within 15 seconds. Make sure its app is open and signed in, then try again.";

export class LoomAskTimeoutError extends Error {
  constructor() {
    super(LOOM_ASK_TIMEOUT_MESSAGE);
    this.name = "LoomAskTimeoutError";
  }
}

export function withLoomAskTimeout<T>(reply: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new LoomAskTimeoutError()), LOOM_ASK_TIMEOUT_MS);
    reply.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

/** What briefings need from the team brain (src/daemon/team-brain.ts). */
export interface TeamBrainHook {
  /** The tiered pool (canon, team, own), or null when the project isn't shared. */
  pool(own: Memory[]): TieredMemory[] | null;
  /** Live team context near these paths (D48), or "". */
  context(files: string[]): string;
}

/** The queue is holding because this agent asked the human something. */
export const questionHold = (agentId: string) => `${agentId} asked you something — answer it, or resume to send what's queued`;

/** What the socket carries about a server: a state change, or a line of output. */
export type ServerFrame =
  | { kind: "state"; name: string; status: ServerStatus }
  | { kind: "line"; name: string; line: LogLine };

/** How often a time-held prompt checks the clock. */
export const CLOCK_TICK_MS = 15_000;

/** One event, as one line of "what is it doing". */
export function activityLine(e: LoomEvent): string {
  const p = e.payload as Record<string, unknown>;
  const cut = (v: unknown, n = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  switch (e.kind) {
    case "tool_call":
      return `${cut(p.tool ?? p.name, 40)} ${cut(p.command ?? p.input ?? p.summary ?? "", 90)}`.trim();
    case "file_edit":
      return `edited ${cut(p.path, 100)}`;
    case "message":
      return cut(p.text);
    case "needs_input":
      return `asks: ${cut(p.question)}`;
    case "approval":
      return p.phase === "requested" ? `wants approval for ${cut(p.tool, 60)}` : `approval ${cut(p.behavior, 10)}`;
    case "run_complete":
      return "finished its turn";
    case "error":
      return `error: ${cut(p.message)}`;
    default:
      return e.kind.replace(/_/g, " ");
  }
}

/**
 * Plan mode for an ordinary turn: think, don't touch — and leave the plan as a
 * markdown spec any agent can execute later (or an orchestra can run).
 */
export function planModeBriefing(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "plan";
  const day = new Date().toISOString().slice(0, 10);
  return [
    "[Loom · Plan mode] Do NOT change any code in this turn. Investigate the repository, then write a",
    `complete implementation plan to .loom/plans/${day}-${slug}.md (create the folder if needed — it's Loom's, kept out of the repo). Structure:`,
    "front matter (title, status: proposed), then ## Goal, ## Context (relevant files by path and what they do),",
    "## Approach, ## Tasks — each task self-contained with its files, steps and acceptance criteria, written so",
    "a different coding agent could execute it with no other context — ## Risks, ## Verification (exact commands).",
    "Then reply with a short summary and the file's path.",
  ].join("\n");
}

export function relativeToProject(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? path.relative(projectDir, p) : p;
}

export function configMtimeOf(projectDir: string): number {
  try {
    return fs.statSync(path.join(projectDir, ".loom", "config.json")).mtimeMs;
  } catch {
    return 0;
  }
}