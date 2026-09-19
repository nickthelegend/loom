/**
 * Orchestra — one orchestrator agent, many worker agents, in parallel.
 *
 * A route passes one baton down a line; a subtask fans out but never reports
 * back. Orchestra is the missing shape: an orchestrator agent (any adapter —
 * Claude Code, Codex, Antigravity, Grok, OpenCode) turns a goal into a task
 * graph, Loom runs every ready task at once on whichever worker agents the
 * plan names, each in its own thread and its own git worktree, merges the
 * finished work into one integration branch, and hands the orchestrator the
 * results to review — accept, follow up, spawn more, or finish.
 *
 * Design lineage, credited: the orchestrator/worker split, the "coordinate,
 * never implement" orchestrator rules and the worktree-per-worker isolation
 * follow Agent Orchestrator (github.com/Untrivial-ai/agent-orchestrator,
 * Apache-2.0). What differs, on purpose:
 *
 *  - **The orchestrator never needs a shell tool.** AO's orchestrator drives a
 *    CLI (`ao spawn`, `ao send`) from its terminal, which fails for agents that
 *    run sandboxed or can't execute commands headless. Here it answers in a
 *    fenced ```loom block of JSON actions that Loom parses — so ANY agent can
 *    orchestrate, including ones with no tools at all.
 *  - **A real task graph.** Tasks declare `dependsOn`; a task starts only when
 *    its dependencies merged, and it branches from the integration tip so it
 *    sees their work.
 *  - **Mixed fleets.** Each task names its worker; three Codex tasks and two
 *    Antigravity tasks run side by side as separate CLI sessions.
 *
 * Everything is observable: every step is an `orchestra` event in the project
 * log (so the web app, the phone and the CLI all watch the same run), and each
 * task's agent output streams into that task's own chat.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loomHome } from "./registry.js";
import { cutStack, type MergedTask } from "./team-landing.js";
import type { Adapter, AgentConfig, ChatInfo, EventKind, GitDelivery, LoomEvent, SendInput } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestraStatus =
  | "starting"
  | "planning" // orchestrator's first turn
  | "running" // workers are running tasks
  | "reviewing" // orchestrator is reading results
  | "waiting_human" // orchestrator asked a question
  | "completed"
  | "failed"
  | "aborted"
  | "moved"; // Phase 5: the goal went to another machine (a runner, or back) — this copy is read-only

export type TaskStatus =
  | "pending" // waiting on dependencies or a free slot
  | "running"
  | "done" // finished and merged into the integration branch
  | "conflict" // finished, but its merge conflicted — needs a follow-up
  | "needs_input" // the worker ended its turn on a question
  | "failed"
  | "cancelled";

/**
 * Why a ready task isn't running yet (Loom Teams, Phase 2). "decide" needs the
 * orchestrator (an overlap without an `overlap` decision, missing `touches`, a
 * disallowed agent); the rest clear on their own and are re-checked.
 */
export interface TaskHold {
  kind: "decide" | "wait" | "zone" | "capacity";
  reason: string;
  /** wait: the teammate goal this task waits on. */
  runId?: string;
  /** zone: the hard zone and who holds it. */
  zone?: string;
  holder?: string;
  since: number;
  checkedAt?: number;
}

export interface OrchestraTask {
  id: string;
  title: string;
  prompt: string;
  /** Roster agent id (or kind) that runs it. */
  agent: string;
  /** Adapter kind actually used. */
  kind: string;
  dependsOn: string[];
  /** File globs the orchestrator declared this task will touch (D9). */
  touches?: string[];
  /** The orchestrator's answer to a teammate overlap (D29): wait:<goal> | narrow | proceed:<reason>. */
  overlap?: string;
  /** Set while the task waits on something other than its own dependencies. */
  hold?: TaskHold;
  status: TaskStatus;
  /** The chat (thread) this task's output streams into. */
  chat: string;
  branch?: string;
  dir?: string;
  attempts: number;
  /** Follow-up messages queued by the orchestrator, run after the current turn. */
  queued: string[];
  result?: string;
  files?: string[];
  error?: string;
  costUsd?: number;
  /** The integration branch's merge commit for this task, and the lines it changed (stacks, D59). */
  mergeCommit?: string;
  lines?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set once the orchestrator has been shown this outcome. */
  reported?: boolean;
}

export interface OrchestraRun {
  id: string;
  goal: string;
  orchestrator: { agent: string; kind: string };
  /** Agents the orchestrator may assign work to (roster ids). */
  workers: string[];
  status: OrchestraStatus;
  /** The orchestrator's own thread. */
  chat: string;
  baseBranch: string | null;
  baseCommit: string;
  branch: string; // integration branch
  dir: string; // integration worktree
  tasks: OrchestraTask[];
  round: number;
  maxRounds: number;
  maxParallel: number;
  summary?: string;
  question?: string;
  error?: string;
  /** Set when the integration branch was merged back into the project. */
  applied?: { at: number; into: string };
  /**
   * Plan mode: the plan is written as markdown specs under plans/<run>/ on the
   * integration branch — PLAN.md plus one self-contained file per task — so
   * any agent (or teammate) can read, resume or re-run it. See writePlan.
   */
  plan?: boolean;
  /** What the project's git delivery policy did with the finished run. */
  delivered?: { mode: GitDelivery; into?: string; pushed?: string; prUrl?: string; at: number };
  deliveryError?: string;
  /** Team facts for the orchestrator's next review: predicted conflicts, drift (D33, D34). */
  notes?: string[];
  /** Phase 4: the goal's PR on its way to main — checks, fixes, review, landing. */
  landing?: LandingState;
  /** An adopted goal (D63): this run fixes a teammate's PR, starting from and pushing to its branch. */
  from?: { branch: string; pr: number; url: string; ownerRunId?: string; owner?: string };
  /** This goal's spending cap in USD (D64), raised each time a human says continue. */
  budgetUsd?: number;
  /** Phase 5: set while the goal is being handed to another machine; nothing new starts. */
  moving?: boolean;
  /** Where the goal went (D75). */
  movedTo?: { where: string; at: number };
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A goal PR's journey to main (Loom Teams, Phase 4 — D52–D63). Kept on the
 * run so it survives restarts and shows wherever the run does.
 */
export interface LandingState {
  pr: number;
  url: string;
  /** "queued": Land was clicked, and another goal holds a lane this one needs (Phase 6, D82). */
  state: "open" | "pending" | "green" | "failing" | "fixing" | "needs_human" | "queued" | "landing" | "merged" | "closed";
  headSha?: string;
  /** Fix attempts spent (D55: checks and high review findings share them). */
  fixAttempts: number;
  /** `${sha}:${check}` already rerun once (D53). */
  reruns: string[];
  /** Checks that failed, then passed on rerun. */
  flaky: string[];
  checks?: { failing: string[]; pending: string[]; passing: number };
  reviews: number;
  reviewedSha?: string;
  review?: { state: "success" | "failure" | "skipped"; reviewer: string | null; high: number; findings: number; at: number; overridden?: string };
  /** Why it waits on a human. */
  reason?: string;
  /** The owner clicked Land: keep going (pushrebase-lite, auto-merge) until merged (D56). */
  landRequested?: boolean;
  /** One agent attempt at a conflict with fresh main (D58). */
  conflictTried?: boolean;
  /** A teammate holds this goal right now (D63). */
  adoptedBy?: string;
  /** An adopted goal, handed back to its owner. */
  returned?: boolean;
  /** The commit the PR merged as (deploy alerts, D72). */
  mergeSha?: string;
  /** Actions minutes the goal's branch used, recorded when it lands (§10). */
  ciMinutes?: number;
  /** Stacked delivery (D59): the PRs bottom-up; the last is this goal's own branch. */
  stack?: Array<{ pr: number; url: string; branch: string; base: string; state?: string }>;
  // ── Phase 6: the landing train (D79–D82), when the repo has no merge queue ──
  /** Land goes through the train: Loom merges it when its lanes' turn comes. */
  train?: boolean;
  /** The lanes it needs (path scopes from `landing.lanes`; "main" when none match). */
  lanes?: string[];
  /** It holds its lanes' slots right now: its turn. */
  slot?: boolean;
  /** The PR head this turn pushed (fresh base merged in), and when. */
  turnSha?: string;
  turnAt?: number;
  updatedAt: number;
}

export interface OrchestraStartOptions {
  goal: string;
  /** Roster id (or kind) of the orchestrator. Defaults to the host's pick. */
  orchestrator?: string;
  /** Roster ids (or kinds) of allowed workers. Defaults to every adapter. */
  workers?: string[];
  maxParallel?: number;
  maxRounds?: number;
  /** Write the plan as markdown specs other agents can read (plans/<run>/). */
  plan?: boolean;
  /** Adopt (D63): start from a teammate's PR branch and push back to it. */
  from?: OrchestraRun["from"];
}

/** What orchestra needs from the project that owns it. */
export interface OrchestraHost {
  projectId: string;
  projectName: string;
  projectDir: string;
  /** Adapter entries of the roster (enabled only). */
  roster(): AgentConfig[];
  /** Kinds installed on this machine but not on the roster, usable as workers. */
  installedKinds(): string[];
  /** Build a fresh adapter instance for `cfg`, working in `dir`. */
  makeAgent(cfg: AgentConfig, dir: string): Adapter;
  append(e: { kind: EventKind; agentId?: string; chat?: string; payload: Record<string, unknown> }): LoomEvent;
  createChat(title: string): ChatInfo;
  /** Skills + retrieved memories for a task, or "" — the project brain (and the team's, when shared). */
  briefingFor(query: string, agentId: string, files?: string[]): string;
  /** Throws when `agentId` is over budget or quarantined. */
  gate(agentId: string): void;
  /** Cost/metrics bookkeeping for a worker event. */
  observe(event: LoomEvent): void;
  /** The project's git delivery policy, read when a run completes. */
  gitDelivery?(): GitDelivery;
  /** The GitHub login of the member running this daemon, when on a team (commit trailers). */
  member?(): string | null;
  /** The team coordinator for this project, when it's shared with a team (Phase 2). */
  coordinator?(): OrchestraCoordinator | null;
}

/** What a task's admission decided. */
export type Admission = { go: true; rebase?: boolean; note?: string } | { go: false; hold: TaskHold };

/**
 * Loom Teams, Phase 2 — the team's say over when a task runs (leases, hard
 * zones, waits, capacity, policy) and what it hears back (drift, WIP, landing).
 * Implemented by the daemon's Team Link; absent for solo projects.
 */
export interface OrchestraCoordinator {
  admit(run: OrchestraRun, task: OrchestraTask): Promise<Admission>;
  onEdit?(run: OrchestraRun, task: OrchestraTask, path: string): void;
  onTaskDone?(run: OrchestraRun, task: OrchestraTask): void;
  onRunEnd?(run: OrchestraRun): void;
  /** Policy cap on tasks at once for this member (D38). */
  maxParallel?(): number | null;
  /** Protected branches only receive PRs (D38). */
  isProtected?(branch: string): boolean;
  /** Why this member can't start a goal right now (D64: over the daily budget), or null. */
  canStart?(): string | null;
  /** The per-goal budget in USD (D64), or null for none. */
  goalBudgetUsd?(): number | null;
  /** Stacked delivery for big goals (D59). */
  stackMode?(): "auto" | "off";
}

// ---------------------------------------------------------------------------
// The orchestrator protocol
// ---------------------------------------------------------------------------

export type OrchestraAction =
  | {
      type: "spawn";
      id?: string;
      title: string;
      agent: string;
      prompt: string;
      dependsOn?: string[];
      touches?: string[];
      overlap?: string;
    }
  | { type: "send"; task: string; message: string }
  | { type: "cancel"; task: string }
  | { type: "ask"; question: string }
  | { type: "done"; summary: string };

/**
 * Pull the actions out of an orchestrator reply.
 *
 * Accepts the last ```loom fence (the documented form), falling back to the
 * last ```json fence holding an `actions` array, then to a bare object — models
 * drift, and a plan lost to a fence label is a wasted round. Returns null when
 * nothing parses, so the caller can ask again rather than guess.
 */
export function parseOrchestraActions(text: string): OrchestraAction[] | null {
  const fences = [...text.matchAll(/```([a-zA-Z-]*)\s*\n([\s\S]*?)```/g)];
  const candidates: string[] = [];
  for (const f of fences.reverse()) {
    if (f[1] === "loom") candidates.push(f[2]!);
  }
  for (const f of fences) {
    if (f[1] !== "loom" && f[2]!.includes('"actions"')) candidates.push(f[2]!);
  }
  const bare = text.lastIndexOf('{"actions"');
  if (bare >= 0) candidates.push(text.slice(bare));

  for (const raw of candidates) {
    const parsed = tryJson(raw.trim());
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { actions?: unknown }).actions)
        ? (parsed as { actions: unknown[] }).actions
        : null;
    if (!list) continue;
    const actions = list.map(normalizeAction).filter((a): a is OrchestraAction => a !== null);
    if (actions.length || list.length === 0) return actions;
  }
  return null;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A bare object followed by prose: cut at the matching close brace.
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(0, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeAction(v: unknown): OrchestraAction | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const type = str(a.type ?? a.action).toLowerCase();
  switch (type) {
    case "spawn":
    case "task":
    case "assign": {
      const prompt = str(a.prompt ?? a.instructions ?? a.task);
      const title = str(a.title ?? a.name) || prompt.slice(0, 60);
      const agent = str(a.agent ?? a.worker);
      if (!prompt || !agent) return null;
      const deps = Array.isArray(a.dependsOn ?? a.depends_on ?? a.after)
        ? ((a.dependsOn ?? a.depends_on ?? a.after) as unknown[]).map(str).filter(Boolean)
        : [];
      const id = str(a.id);
      const touches = Array.isArray(a.touches ?? a.files)
        ? ((a.touches ?? a.files) as unknown[]).map(str).filter(Boolean).slice(0, 50)
        : [];
      const overlapDecision = str(a.overlap);
      return {
        type: "spawn",
        ...(id ? { id } : {}),
        title,
        agent,
        prompt,
        dependsOn: deps,
        ...(touches.length ? { touches } : {}),
        ...(overlapDecision ? { overlap: overlapDecision } : {}),
      };
    }
    case "send":
    case "followup":
    case "follow_up": {
      const task = str(a.task ?? a.id);
      const message = str(a.message ?? a.prompt);
      return task && message ? { type: "send", task, message } : null;
    }
    case "cancel":
    case "kill": {
      const task = str(a.task ?? a.id);
      return task ? { type: "cancel", task } : null;
    }
    case "ask":
    case "question": {
      const question = str(a.question ?? a.message);
      return question ? { type: "ask", question } : null;
    }
    case "done":
    case "finish":
    case "complete": {
      return { type: "done", summary: str(a.summary ?? a.message) || "Done." };
    }
    default:
      return null;
  }
}

/** The orchestrator's standing instructions, sent with its first turn. */
export function orchestratorBriefing(opts: {
  project: string;
  goal: string;
  workers: Array<{ id: string; kind: string; role?: string }>;
  maxParallel: number;
  branch: string;
  planDir?: string;
}): string {
  const roster = opts.workers
    .map((w) => `- "${w.id}" — ${KIND_BLURBS[w.kind] ?? w.kind}${w.role && w.role !== w.id ? ` (role: ${w.role})` : ""}`)
    .join("\n");
  return [
    `[Loom Orchestra] You are the ORCHESTRATOR for project "${opts.project}".`,
    "Your job is to coordinate, not to implement. Break the goal into concrete, independently",
    "verifiable tasks and assign each to a worker agent. Workers run IN PARALLEL, each in its own",
    `git worktree; finished work is merged into the integration branch "${opts.branch}", which is`,
    "the directory you are running in — read it to review results.",
    "",
    "Rules:",
    "- Never edit files yourself. Every implementation, fix, or test goes to a worker.",
    "- Ground every task in the real repository: look at the code first; never guess file names.",
    "- Write each task prompt so a worker with NO other context can finish it: the outcome, the",
    "  files involved, constraints, and how to verify.",
    "- Prefer tasks that touch different files so parallel work merges cleanly. When one task needs",
    "  another's output, list it in dependsOn — it will start from a branch that already has it.",
    `- At most ${opts.maxParallel} tasks run at once; queue more and they start as slots free up.`,
    "- Match tasks to agents' strengths, and spread work across agents when it helps.",
    '- Give each task "touches": the file globs it will change. Teammates\' agents see them to avoid collisions.',
    "",
    "Available workers:",
    roster,
    "",
    "End EVERY reply with exactly one fenced block tagged loom containing your actions:",
    "```loom",
    '{"actions": [',
    '  {"type": "spawn", "id": "t1", "title": "short label", "agent": "<worker id>", "prompt": "full task", "dependsOn": [], "touches": ["src/auth/**"]},',
    '  {"type": "send", "task": "t1", "message": "follow-up for a finished/failed task (same worker, same worktree)"},',
    '  {"type": "cancel", "task": "t2"},',
    '  {"type": "ask", "question": "only when a human decision is truly required"},',
    '  {"type": "done", "summary": "what was delivered and how it was verified"}',
    "]}",
    "```",
    "After you reply, Loom runs the tasks and comes back to you with each result. Review them:",
    "send follow-ups for anything incomplete or wrong, spawn new tasks if needed, and emit done",
    "only when the goal is met. An empty actions list means: keep waiting for running tasks.",
    "",
    ...(opts.planDir
      ? [
          "",
          `PLAN MODE is on. Every task prompt you write becomes a durable spec file at ${opts.planDir}/<id>.md,`,
          `and the whole plan is written to ${opts.planDir}/PLAN.md, committed to the integration branch. Other`,
          "agents and teammates will pick these up without you, so write each task prompt as a complete spec",
          "with these headings: Goal, Context (the files and code involved, by path), Steps, Acceptance criteria,",
          "Verification (exact commands). Plan the whole goal up front in your first reply.",
        ]
      : []),
    "",
    `The goal: ${opts.goal}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plan files — the plan as markdown other agents can read
// ---------------------------------------------------------------------------

function yamlStr(v: string): string {
  return JSON.stringify(v);
}

/** plans/<run>/PLAN.md — the index: goal, task table, how to use it, results. */
export function renderPlanIndex(run: OrchestraRun): string {
  const rows = run.tasks
    .map(
      (t) =>
        `| [${t.id}](${t.id}.md) | ${t.title.replace(/\|/g, "\\|")} | ${t.agent} | ${t.dependsOn.join(", ") || "—"} | ${t.status} |`,
    )
    .join("\n");
  return [
    "---",
    "loom-plan: 1",
    `run: ${run.id}`,
    `goal: ${yamlStr(run.goal)}`,
    `orchestrator: ${run.orchestrator.agent}`,
    `workers: [${run.workers.join(", ")}]`,
    `status: ${run.status}`,
    `branch: ${run.branch}`,
    `created: ${new Date(run.createdAt).toISOString()}`,
    "---",
    "",
    `# ${run.goal.split("\n")[0]!.slice(0, 100)}`,
    "",
    "## Goal",
    "",
    run.goal,
    "",
    "## Tasks",
    "",
    "| id | task | agent | depends on | status |",
    "|---|---|---|---|---|",
    rows || "| — | (no tasks yet) | | | |",
    "",
    "## How to use this plan",
    "",
    "Each task file in this folder is a self-contained spec: any coding agent (Claude Code, Codex,",
    "Antigravity, Grok, OpenCode…) or a teammate can pick one up by reading it. Tasks whose",
    "`depends_on` are all `done` are ready. Loom keeps the `status` fields current; don't edit them by hand",
    "while a run is live.",
    "",
    ...(run.summary || run.error
      ? ["## Result", "", run.summary ?? `Stopped: ${run.error}`, "", `Integration branch: \`${run.branch}\``, ""]
      : []),
  ].join("\n");
}

/** plans/<run>/<task>.md — one task, readable by any agent with no other context. */
export function renderTaskFile(run: OrchestraRun, t: OrchestraTask): string {
  return [
    "---",
    `id: ${t.id}`,
    `title: ${yamlStr(t.title)}`,
    `agent: ${t.agent}`,
    `depends_on: [${t.dependsOn.join(", ")}]`,
    `status: ${t.status}`,
    `plan: PLAN.md`,
    "---",
    "",
    `# ${t.id} · ${t.title}`,
    "",
    `Part of: ${run.goal.split("\n")[0]!.slice(0, 120)} (see [PLAN.md](PLAN.md))`,
    "",
    ...(t.dependsOn.length
      ? ["## Depends on", "", ...t.dependsOn.map((d) => `- [${d}](${d}.md)`), ""]
      : []),
    "## Spec",
    "",
    t.prompt.trim(),
    "",
    "## Result",
    "",
    t.result && t.status !== "pending" && t.status !== "running"
      ? [t.result.trim(), "", t.files?.length ? `Files changed: ${t.files.map((f) => `\`${f}\``).join(", ")}` : ""].join("\n")
      : "_Filled in by Loom when the task finishes._",
    "",
  ].join("\n");
}

const KIND_BLURBS: Record<string, string> = {
  "claude-code": "Claude Code (Anthropic): strong at multi-file changes, refactors, careful reasoning",
  codex: "Codex (OpenAI / ChatGPT): strong at implementation and running tests",
  "antigravity-cli": "Antigravity (Google Gemini): fast implementation, broad knowledge",
  "grok-code": "Grok Code (xAI): quick edits and scripts",
  opencode: "OpenCode: open-model agent, good for well-specified tasks",
  echo: "Echo (test double — repeats the prompt)",
};

/** What a worker is told, alongside its task. */
export function workerBriefing(opts: {
  project: string;
  runGoal: string;
  task: OrchestraTask;
  branch: string;
  brain: string;
  planFile?: string;
}): string {
  return [
    `[Loom Orchestra] You are a WORKER in project "${opts.project}", running task ${opts.task.id}: ` +
      `"${opts.task.title}".`,
    `The overall goal (for context only — do just YOUR task): ${opts.runGoal}`,
    `You are in your own git worktree on branch "${opts.branch}". Other workers are editing other`,
    "worktrees at the same time; Loom merges your work when you finish.",
    "- Inspect the relevant code before editing. Keep changes scoped to the task.",
    "- Verify what you touched (run the relevant tests/build when there are any).",
    "- Do not commit, push, or open PRs — Loom commits and merges for you.",
    "- Finish with a short report: what you changed, how you verified it, anything left undone.",
    "- If you cannot proceed without a decision, end your reply with the question.",
    ...(opts.planFile
      ? [
          `- Your task's spec is ${opts.planFile} (the whole plan is next to it in PLAN.md). Read it first.`,
          "  Don't edit files under plans/ — Loom updates them.",
        ]
      : []),
    opts.brain,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const gitOk = (args: string[], cwd: string) => git(args, cwd).then(() => true, () => false);

/**
 * Stage everything a worker changed, minus Loom's own files.
 *
 * Adapters keep session state in `<worktree>/.loom/`, which must never ride a
 * commit into the project. An exclude pathspec looked right and wasn't: when
 * the project already gitignores `.loom/` (most do), naming the ignored path
 * makes `git add` exit 1 ("paths are ignored"), which failed every real Codex
 * task. So: add all, then unstage `.loom` — a no-op when it's ignored.
 */
async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(["add", "-A"], dir);
  await git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".loom"], dir).catch(() => {});
  const staged = (await git(["diff", "--cached", "--name-only"], dir)).trim();
  if (!staged) return false;
  await git(
    ["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "commit", "-q", "--no-verify", "-m", message],
    dir,
  );
  return true;
}

/**
 * A worker's commit, traceable to its goal, task and agent from `git log`
 * alone (docs/teams-architecture.md §7). GitHub reads Co-Authored-By; the
 * Loom-* trailers are for people and tools (`git log --grep 'Loom-Goal: o7x'`).
 */
export function taskCommitMessage(run: OrchestraRun, task: OrchestraTask, member: string | null): string {
  return [
    `${task.title}`.slice(0, 72),
    "",
    `Task ${task.id} of orchestra ${run.id}: ${run.goal.split("\n")[0]!.slice(0, 120)}`,
    "",
    `Co-Authored-By: ${task.agent} <${task.agent}@loom.local>`,
    ...(member ? [`Loom-Member: ${member}`] : []),
    `Loom-Goal: ${run.id}`,
    `Loom-Task: ${task.id}`,
    `Loom-Agent: ${task.kind}`,
  ].join("\n");
}

/** Where a run's plan lives inside the repo. */
export function planDir(run: { id: string }): string {
  return `plans/${run.id}`;
}

function gh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Serialize git mutations: worktree add/merge on one repo race on its locks. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_MAX_ROUNDS = 10;
const HARD_MAX_PARALLEL = 12;
const RESULT_CHARS = 4000;
/** How often a task waiting on the team (a PR, a zone, capacity) is re-admitted. */
const RECHECK_MS = 15_000;

export class OrchestraEngine {
  private runs = new Map<string, OrchestraRun>();
  private live = new Map<string, Adapter>(); // `${runId}/${taskId|orch}` → adapter
  private gitLock = new Mutex();
  private turnText = new Map<string, string>();
  private orchestratorBusy = new Set<string>();

  constructor(private host: OrchestraHost) {
    for (const run of this.loadRuns()) this.runs.set(run.id, run);
    // A daemon restart kills every CLI a run was driving. Say so honestly
    // instead of showing tasks "running" that nothing runs.
    for (const run of this.runs.values()) {
      if (!isTerminal(run.status) && run.status !== "waiting_human") {
        run.status = "failed";
        run.error = "the daemon restarted while this run was active";
        for (const t of run.tasks) {
          if (t.status === "running" || t.status === "pending") {
            t.status = "cancelled";
            t.error = "daemon restarted";
          }
        }
        this.save(run);
      }
    }
  }

  // ── persistence ──

  private runsDir(): string {
    return path.join(this.host.projectDir, ".loom", "orchestra");
  }

  private loadRuns(): OrchestraRun[] {
    const dir = this.runsDir();
    if (!fs.existsSync(dir)) return [];
    const out: OrchestraRun[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as OrchestraRun);
      } catch {
        /* a torn file is one lost run, not a dead project */
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  private save(run: OrchestraRun): void {
    run.updatedAt = Date.now();
    fs.mkdirSync(this.runsDir(), { recursive: true });
    const file = path.join(this.runsDir(), `${run.id}.json`);
    fs.writeFileSync(file + ".tmp", JSON.stringify(run, null, 2));
    fs.renameSync(file + ".tmp", file);
  }

  list(): OrchestraRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): OrchestraRun | undefined {
    return this.runs.get(id);
  }

  active(): OrchestraRun | undefined {
    return this.list().find((r) => !isTerminal(r.status));
  }

  private emit(run: OrchestraRun, phase: string, extra: Record<string, unknown> = {}, chat?: string): void {
    this.host.append({
      kind: "orchestra",
      chat: chat ?? run.chat,
      payload: { phase, runId: run.id, status: run.status, ...extra },
    });
  }

  // ── agents ──

  /** Resolve a name the orchestrator (or user) gave into a runnable config. */
  resolveAgent(name: string): AgentConfig | null {
    const roster = this.host.roster();
    const n = name.trim().toLowerCase();
    const byId = roster.find((a) => a.id.toLowerCase() === n);
    if (byId) return byId;
    const alias: Record<string, string> = {
      claude: "claude-code",
      "claude code": "claude-code",
      chatgpt: "codex",
      gpt: "codex",
      openai: "codex",
      antigravity: "antigravity-cli",
      agy: "antigravity-cli",
      gemini: "antigravity-cli",
      grok: "grok-code",
    };
    const kind = alias[n] ?? n;
    const byKind = roster.find((a) => a.kind === kind);
    if (byKind) return byKind;
    if (this.host.installedKinds().includes(kind)) return { id: kind, kind, role: kind };
    return null;
  }

  // ── lifecycle ──

  async start(opts: OrchestraStartOptions): Promise<OrchestraRun> {
    const goal = opts.goal?.trim();
    if (!goal) throw new Error("an orchestra run needs a goal");
    const busy = this.active();
    if (busy) throw new Error(`orchestra run ${busy.id} is still ${busy.status} — abort it or wait`);

    const roster = this.host.roster();
    const orchCfg = opts.orchestrator
      ? this.resolveAgent(opts.orchestrator)
      : (roster.find((a) => a.kind === "claude-code") ?? roster[0] ?? null);
    if (!orchCfg) throw new Error(`no agent "${opts.orchestrator ?? ""}" can orchestrate here — add one first`);

    const workerNames = opts.workers?.length ? opts.workers : roster.map((a) => a.id);
    const workers: AgentConfig[] = [];
    for (const w of workerNames) {
      const cfg = this.resolveAgent(w);
      if (!cfg) throw new Error(`unknown worker agent "${w}"`);
      if (!workers.some((x) => x.id === cfg.id)) workers.push(cfg);
    }
    if (!workers.length) throw new Error("an orchestra needs at least one worker agent");
    this.host.gate(orchCfg.id);
    const blocked = this.host.coordinator?.()?.canStart?.();
    if (blocked) throw new Error(blocked);

    const dir = this.host.projectDir;
    if (!(await gitOk(["rev-parse", "--is-inside-work-tree"], dir))) {
      throw new Error("orchestra runs need a git repository — initialise one (git init) first");
    }
    // Worktrees branch from a commit. A repo with none gets an empty root
    // commit rather than a cryptic "invalid reference: HEAD".
    if (!(await gitOk(["rev-parse", "--verify", "HEAD"], dir))) {
      await git(
        ["-c", "user.name=Loom", "-c", "user.email=loom@loom.local", "commit", "-q", "--allow-empty", "-m", "Initial commit"],
        dir,
      );
    }
    let baseCommit = (await git(["rev-parse", "HEAD"], dir)).trim();
    let baseBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir).catch(() => "")).trim() || null;
    if (opts.from) {
      // Adopting a teammate's goal: work starts from their pushed branch (D63).
      await git(["fetch", "-q", "origin", `+refs/heads/${opts.from.branch}:refs/remotes/origin/${opts.from.branch}`], dir);
      baseCommit = (await git(["rev-parse", `origin/${opts.from.branch}`], dir)).trim();
      baseBranch = null;
    }
    const dirty = (await git(["status", "--porcelain"], dir)).trim().length > 0;

    const id = `o${Date.now().toString(36)}`;
    // Integration and task branches are siblings under one prefix: git can't
    // hold both `a/b` and `a/b/c` as refs.
    const branch = `loom/orchestra/${id}/main`;
    const wtRoot = path.join(loomHome(), "orchestra", this.host.projectId, id);
    const integration = path.join(wtRoot, "integration");
    fs.mkdirSync(wtRoot, { recursive: true });
    await this.gitLock.run(() => git(["worktree", "add", "-q", "-b", branch, integration, baseCommit], dir));

    const chat = this.host.createChat(`🎼 ${goal.slice(0, 50)}`);
    const run: OrchestraRun = {
      id,
      goal,
      orchestrator: { agent: orchCfg.id, kind: orchCfg.kind },
      workers: workers.map((w) => w.id),
      status: "planning",
      chat: chat.id,
      baseBranch,
      baseCommit,
      branch,
      dir: integration,
      tasks: [],
      round: 0,
      maxRounds: clamp(opts.maxRounds ?? DEFAULT_MAX_ROUNDS, 1, 50),
      maxParallel: Math.min(
        clamp(opts.maxParallel ?? DEFAULT_MAX_PARALLEL, 1, HARD_MAX_PARALLEL),
        this.host.coordinator?.()?.maxParallel?.() ?? HARD_MAX_PARALLEL,
      ),
      ...(opts.plan ? { plan: true } : {}),
      ...(opts.from ? { from: opts.from, landing: newLanding(opts.from.pr, opts.from.url) } : {}),
      costUsd: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.workerCfgs.set(run.id, workers);
    this.runs.set(id, run);
    this.save(run);
    this.host.append({ kind: "message", chat: run.chat, payload: { text: goal, author: "user" } });
    this.emit(run, "started", {
      goal,
      orchestrator: run.orchestrator,
      workers: run.workers,
      branch,
      maxParallel: run.maxParallel,
      ...(dirty ? { note: "uncommitted changes in the project are not visible to workers — they start from the last commit" } : {}),
    });

    const briefing = orchestratorBriefing({
      project: this.host.projectName,
      goal,
      workers: workers.map((w) => ({ id: w.id, kind: w.kind, role: w.role })),
      maxParallel: run.maxParallel,
      branch,
      ...(run.plan ? { planDir: planDir(run) } : {}),
    });
    void this.orchestratorTurn(run, "Plan the goal into tasks and spawn them now.", briefing);
    return run;
  }

  private workerCfgs = new Map<string, AgentConfig[]>();

  private workersFor(run: OrchestraRun): AgentConfig[] {
    const cached = this.workerCfgs.get(run.id);
    if (cached) return cached;
    const cfgs = run.workers.map((w) => this.resolveAgent(w)).filter((c): c is AgentConfig => !!c);
    this.workerCfgs.set(run.id, cfgs);
    return cfgs;
  }

  async abort(runId: string, reason = "aborted by the user"): Promise<OrchestraRun> {
    const run = this.mustGet(runId);
    if (isTerminal(run.status)) return run;
    run.status = "aborted";
    run.error = reason;
    for (const t of run.tasks) {
      if (t.status === "running" || t.status === "pending") {
        t.status = "cancelled";
        t.error = reason;
      }
    }
    this.save(run);
    await this.stopAll(run);
    this.emit(run, "aborted", { reason });
    this.host.coordinator?.()?.onRunEnd?.(run);
    return run;
  }

  /** The human answers an orchestrator's question (or adds direction mid-run). */
  async reply(runId: string, text: string): Promise<OrchestraRun> {
    const run = this.mustGet(runId);
    const msg = text.trim();
    if (!msg) throw new Error("empty reply");
    if (isTerminal(run.status) && run.status !== "completed") {
      throw new Error(`run ${run.id} is ${run.status}`);
    }
    this.host.append({ kind: "message", chat: run.chat, payload: { text: msg, author: "user" } });
    run.question = undefined;
    // Over its budget (D64): a human saying continue raises the cap by one more budget.
    const cap = this.goalCap(run);
    if (cap !== null && run.costUsd >= cap) run.budgetUsd = run.costUsd + (this.host.coordinator?.()?.goalBudgetUsd?.() ?? cap);
    if (run.status === "completed") {
      // Reopen: more work on the same integration branch.
      run.status = "reviewing";
      run.summary = undefined;
    }
    this.save(run);
    if (this.orchestratorBusy.has(run.id)) {
      this.pendingHuman.set(run.id, [...(this.pendingHuman.get(run.id) ?? []), msg]);
      return run;
    }
    void this.orchestratorTurn(run, `The human says: ${msg}\n\n${this.statusReport(run)}`);
    return run;
  }

  private pendingHuman = new Map<string, string[]>();

  /**
   * Put a completed goal back to work (Phase 4): a failed check, a high review
   * finding, a conflict with fresh main. Same integration branch, same task
   * worktrees; the orchestrator gets the problem and a fresh round budget.
   * Whatever landed on the pushed branch meanwhile (an adopter's fix) comes in first.
   */
  async reopen(runId: string, text: string, why: string): Promise<OrchestraRun> {
    const run = this.mustGet(runId);
    if (run.status !== "completed") throw new Error(`run ${run.id} is ${run.status} — only a completed goal can be reopened`);
    run.status = "reviewing";
    run.summary = undefined;
    run.maxRounds = run.round + 10;
    this.save(run);
    this.emit(run, "reopened", { why });
    await this.pullPushed(run).catch(() => {});
    this.host.append({ kind: "message", chat: run.chat, payload: { text, author: "loom", orchestra: { runId: run.id, reopened: why } } });
    void this.orchestratorTurn(run, `${text}\n\n${this.statusReport(run)}`, this.briefingOf(run));
    return run;
  }

  /**
   * Hand a goal to another machine (Phase 5, D75): stop starting anything,
   * let running turns finish (interrupting them after `graceMs`), commit every
   * worktree, and push the integration and task branches to hidden refs. The
   * returned record is what the other side needs to rebuild the run; this
   * copy becomes "moved" and read-only.
   */
  async moveOut(runId: string, where: string, opts: { graceMs?: number } = {}): Promise<{ record: OrchestraRun; refs: string[] }> {
    const run = this.mustGet(runId);
    if (run.status === "moved") throw new Error(`run ${run.id} has already moved to ${run.movedTo?.where ?? "another machine"}`);
    if (run.status === "failed" || run.status === "aborted") throw new Error(`run ${run.id} is ${run.status} — nothing to move`);
    run.moving = true;
    this.save(run);
    this.emit(run, "moving", { to: where });
    const grace = opts.graceMs ?? 120_000;
    const busy = () => this.orchestratorBusy.has(run.id) || run.tasks.some((t) => t.status === "running");
    const deadline = Date.now() + grace;
    while (busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    // Out of patience: stop what's still going; each such task resumes where it left off.
    for (const t of run.tasks) {
      if (t.status !== "running") continue;
      t.status = "pending";
      t.queued.unshift("You were moved to another machine mid-task. Your work so far is committed in this worktree — continue your task where you left off.");
    }
    await this.stopAll(run);
    this.orchestratorBusy.delete(run.id);
    const refs: string[] = [];
    await this.gitLock.run(async () => {
      await commitAll(run.dir, `orchestra ${run.id}: moved to ${where}`).catch(() => false);
      await git(["push", "-q", "-f", "origin", `${run.branch}:${runRef(run.id, "main")}`], run.dir);
      refs.push(runRef(run.id, "main"));
      for (const t of run.tasks) {
        if (!t.dir || !t.branch || !fs.existsSync(t.dir)) continue;
        await commitAll(t.dir, `orchestra ${run.id}/${t.id}: work in progress, moved to ${where}`).catch(() => false);
        await git(["push", "-q", "-f", "origin", `${t.branch}:${runRef(run.id, t.id)}`], t.dir);
        refs.push(runRef(run.id, t.id));
      }
    });
    const record: OrchestraRun = JSON.parse(JSON.stringify({ ...run, moving: undefined, movedTo: undefined }));
    run.moving = undefined;
    run.status = "moved";
    run.movedTo = { where, at: Date.now() };
    this.save(run);
    this.emit(run, "moved", { to: where, refs });
    return { record, refs };
  }

  /**
   * Rebuild a moved goal here (a runner taking it, or bringing it back):
   * fetch its hidden refs, recreate the integration and task worktrees, and
   * give the orchestrator a review turn to carry on (D75, D76).
   */
  async importRun(record: OrchestraRun, opts: { from?: string; resume?: boolean } = {}): Promise<OrchestraRun> {
    const dir = this.host.projectDir;
    const id = record.id;
    const existing = this.runs.get(id);
    if (existing && !isTerminal(existing.status)) throw new Error(`run ${id} is active here already`);
    await git(["fetch", "-q", "origin", `+refs/loom/run/${id}/*:refs/remotes/loom-run/${id}/*`], dir);
    const wtRoot = path.join(loomHome(), "orchestra", this.host.projectId, id);
    // a copy left here by an earlier move goes first
    if (existing) {
      const old = [existing.dir, ...existing.tasks.map((t) => t.dir).filter((d): d is string => !!d)];
      await this.gitLock.run(async () => {
        for (const d of old) await git(["worktree", "remove", "--force", d], dir).catch(() => {});
        await git(["worktree", "prune"], dir).catch(() => {});
      });
    }
    fs.mkdirSync(wtRoot, { recursive: true });
    const integration = path.join(wtRoot, "integration");
    // The other machine's agents may not exist here: same name, else same kind,
    // else this machine's own orchestrator / first worker — and say so.
    const roster = this.host.roster();
    const swaps: string[] = [];
    const local = (agent: string, kind: string, fallback: AgentConfig | undefined): AgentConfig | null => {
      const cfg = this.resolveAgent(agent) ?? this.resolveAgent(kind) ?? fallback ?? null;
      if (cfg && cfg.kind !== kind) swaps.push(`${agent} (${kind}) → ${cfg.id} (${cfg.kind})`);
      return cfg;
    };
    const orchCfg = local(record.orchestrator.agent, record.orchestrator.kind, roster.find((a) => a.role === "orchestrator") ?? roster[0]);
    if (!orchCfg) throw new Error("no agent here can orchestrate this goal");
    const workerCfgs = record.workers.map((w) => this.resolveAgent(w)).filter((c): c is AgentConfig => !!c);
    const firstWorker = workerCfgs[0] ?? roster.find((a) => a.role !== "orchestrator") ?? roster[0];
    const tasks: OrchestraTask[] = [];
    await this.gitLock.run(async () => {
      await git(["worktree", "add", "-q", "-B", record.branch, integration, `refs/remotes/loom-run/${id}/main`], dir);
      for (const t of record.tasks) {
        const copy: OrchestraTask = { ...t, queued: [...t.queued] };
        const wcfg = local(t.agent, t.kind, firstWorker);
        if (wcfg) {
          copy.agent = wcfg.id;
          copy.kind = wcfg.kind;
          if (!workerCfgs.some((w) => w.id === wcfg.id)) workerCfgs.push(wcfg);
        }
        const ref = `refs/remotes/loom-run/${id}/${t.id}`;
        if (t.branch && (await gitOk(["rev-parse", "--verify", ref], dir))) {
          const tdir = path.join(wtRoot, t.id);
          await git(["worktree", "add", "-q", "-B", t.branch, tdir, ref], dir);
          copy.dir = tdir;
        } else {
          delete copy.dir;
          delete copy.branch;
        }
        if (copy.status === "running") copy.status = "pending";
        copy.chat = this.host.createChat(`${t.id} · ${t.title}`.slice(0, 60)).id;
        copy.reported = false;
        tasks.push(copy);
      }
    });
    if (!workerCfgs.length && firstWorker) workerCfgs.push(firstWorker);
    const run: OrchestraRun = {
      ...record,
      orchestrator: { agent: orchCfg.id, kind: orchCfg.kind },
      workers: workerCfgs.map((w) => w.id),
      ...(swaps.length ? { notes: [...(record.notes ?? []), `Agents changed on the move: ${[...new Set(swaps)].join("; ")}`] } : {}),
      dir: integration,
      tasks,
      chat: this.host.createChat(`🎼 ${record.goal.slice(0, 50)}`).id,
      status: isTerminal(record.status) || record.status === "waiting_human" ? record.status : "reviewing",
      maxRounds: record.round + 20,
      moving: undefined,
      movedTo: undefined,
      updatedAt: Date.now(),
    };
    this.runs.set(id, run);
    this.workerCfgs.delete(id);
    this.save(run);
    this.host.append({ kind: "message", chat: run.chat, payload: { text: run.goal, author: "user" } });
    this.emit(run, "imported", { from: opts.from ?? "another machine", tasks: run.tasks.length });
    if (opts.resume !== false && run.status === "reviewing") {
      void this.orchestratorTurn(
        run,
        `This goal was moved here from ${opts.from ?? "another machine"}. Every task's work so far is on its branch; interrupted tasks resume where they left off.\n\n${this.statusReport(run)}`,
        this.briefingOf(run),
      );
    }
    return run;
  }

  /** The orchestrator's standing instructions, for a fresh orchestrator session. */
  private briefingOf(run: OrchestraRun): string {
    return orchestratorBriefing({
      project: this.host.projectName,
      goal: run.goal,
      workers: this.workersFor(run).map((w) => ({ id: w.id, kind: w.kind, role: w.role })),
      maxParallel: run.maxParallel,
      branch: run.branch,
      ...(run.plan ? { planDir: planDir(run) } : {}),
    });
  }

  /** The branch this goal's PR is on. */
  prBranch(run: OrchestraRun): string {
    return run.from?.branch ?? run.branch;
  }

  /** Bring commits pushed to the goal's PR branch by someone else into the integration branch. */
  async pullPushed(run: OrchestraRun): Promise<void> {
    if (!run.delivered?.prUrl && !run.from) return;
    const b = this.prBranch(run);
    await this.gitLock.run(async () => {
      await git(["fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], run.dir);
      await commitAll(run.dir, `orchestra ${run.id}: orchestrator edits`).catch(() => false);
      try {
        await git(["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "merge", "--no-edit", "-q", `origin/${b}`], run.dir);
      } catch (err) {
        await git(["merge", "--abort"], run.dir).catch(() => {});
        throw err;
      }
    });
  }

  /** Record where a goal's PR stands (the landing manager owns the transitions). */
  setLanding(runId: string, patch: Partial<LandingState>): LandingState | undefined {
    const run = this.runs.get(runId);
    if (!run?.landing && !(patch.pr && patch.url)) return undefined;
    if (!run) return undefined;
    run.landing = { ...(run.landing ?? newLanding(patch.pr!, patch.url!)), ...patch, updatedAt: Date.now() };
    this.save(run);
    this.emit(run, "landing", { landing: run.landing });
    return run.landing;
  }

  private goalCap(run: OrchestraRun): number | null {
    return run.budgetUsd ?? this.host.coordinator?.()?.goalBudgetUsd?.() ?? null;
  }

  /** D64: a goal over its cap stops asking for more work until a human says continue. */
  private overBudget(run: OrchestraRun): boolean {
    const cap = this.goalCap(run);
    if (cap === null || run.costUsd < cap) return false;
    run.status = "waiting_human";
    run.question =
      `This goal has spent $${run.costUsd.toFixed(2)} of its $${cap.toFixed(2)} budget (loom.team.json budgets.perGoalUsd). ` +
      "Running work finishes its turn; nothing new starts. Reply to continue — that allows one more budget's worth.";
    this.save(run);
    this.emit(run, "waiting", { question: run.question, budget: { spent: run.costUsd, cap } });
    return true;
  }

  /**
   * Merge the integration branch into the project's working tree.
   *
   * Explicit, never automatic: the run's work lands on its own branch, and the
   * human decides when it reaches theirs.
   */
  async apply(runId: string): Promise<{ merged: string; into: string }> {
    const run = this.mustGet(runId);
    if (run.status !== "completed" && run.status !== "waiting_human" && run.status !== "failed" && run.status !== "aborted") {
      throw new Error(`run ${run.id} is still ${run.status} — wait for it to finish`);
    }
    const dir = this.host.projectDir;
    const into = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
    await this.gitLock.run(async () => {
      await commitAll(run.dir, `orchestra ${run.id}: final edits`).catch(() => false);
      try {
        await git(
          ["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "merge", "--no-ff", "--no-edit", "-m", `Merge orchestra run ${run.id}: ${run.goal.slice(0, 60)}`, run.branch],
          dir,
        );
      } catch (err) {
        await git(["merge", "--abort"], dir).catch(() => {});
        throw new Error(`merge into ${into} failed — ${(err as Error).message}`);
      }
    });
    run.applied = { at: Date.now(), into };
    this.save(run);
    this.emit(run, "applied", { into });
    return { merged: run.branch, into };
  }

  /** Remove a finished run's worktrees (the branch stays for the record). */
  async cleanup(runId: string): Promise<void> {
    const run = this.mustGet(runId);
    if (!isTerminal(run.status) && run.status !== "waiting_human") throw new Error("run is still active");
    await this.stopAll(run);
    const dirs = [run.dir, ...run.tasks.map((t) => t.dir).filter((d): d is string => !!d)];
    await this.gitLock.run(async () => {
      for (const d of dirs) await git(["worktree", "remove", "--force", d], this.host.projectDir).catch(() => {});
      await git(["worktree", "prune"], this.host.projectDir).catch(() => {});
    });
    this.emit(run, "cleaned");
  }

  async shutdown(): Promise<void> {
    for (const run of this.runs.values()) {
      if (!isTerminal(run.status)) await this.abort(run.id, "the project was closed");
    }
  }

  private mustGet(id: string): OrchestraRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no orchestra run "${id}"`);
    return run;
  }

  private async stopAll(run: OrchestraRun): Promise<void> {
    for (const [key, agent] of [...this.live.entries()]) {
      if (!key.startsWith(`${run.id}/`)) continue;
      this.live.delete(key);
      if (agent.busy()) await agent.interrupt().catch(() => {});
      await agent.stop().catch(() => {});
    }
  }

  // ── the orchestrator ──

  private orchestratorAgent(run: OrchestraRun): Adapter {
    const key = `${run.id}/orch`;
    let agent = this.live.get(key);
    if (agent) return agent;
    const cfg = this.resolveAgent(run.orchestrator.agent) ?? {
      id: run.orchestrator.agent,
      kind: run.orchestrator.kind,
      role: "orchestrator",
    };
    agent = this.host.makeAgent({ ...cfg, role: "orchestrator", options: orchestratorOptions(cfg) }, run.dir);
    this.live.set(key, agent);
    this.wire(run, agent, cfg.id, run.chat, key);
    return agent;
  }

  private async orchestratorTurn(run: OrchestraRun, text: string, briefing?: string, retry = 0): Promise<void> {
    if (isTerminal(run.status) || run.moving) return;
    if (this.overBudget(run)) return;
    if (run.round >= run.maxRounds) {
      return this.finish(run, "failed", `stopped after ${run.maxRounds} orchestrator rounds without "done"`);
    }
    run.round++;
    this.orchestratorBusy.add(run.id);
    this.save(run);
    const key = `${run.id}/orch`;
    this.turnText.set(key, "");
    let reply = "";
    try {
      this.host.gate(run.orchestrator.agent);
      const agent = this.orchestratorAgent(run);
      await agent.start();
      this.host.append({
        kind: "message",
        chat: run.chat,
        payload: { text, author: "loom", orchestra: { runId: run.id, to: "orchestrator" } },
      });
      await agent.send({ text, ...(briefing ? { briefing } : {}) } satisfies SendInput);
      reply = this.turnText.get(key) ?? "";
    } catch (err) {
      this.orchestratorBusy.delete(run.id);
      return this.finish(run, "failed", `orchestrator failed: ${(err as Error).message}`);
    }
    this.orchestratorBusy.delete(run.id);
    if (isTerminal(run.status)) return;

    const actions = parseOrchestraActions(reply);
    if (actions === null) {
      if (retry < 1) {
        return this.orchestratorTurn(
          run,
          "Your reply had no ```loom actions block, so nothing ran. Reply again ending with exactly one " +
            '```loom {"actions": [...]} ``` block (see your instructions).',
          undefined,
          retry + 1,
        );
      }
      run.status = "waiting_human";
      run.question = "The orchestrator's reply had no actions Loom could read. Reply with direction to continue.";
      this.save(run);
      this.emit(run, "waiting", { question: run.question });
      return;
    }
    const human = this.pendingHuman.get(run.id);
    if (human?.length) {
      this.pendingHuman.delete(run.id);
      this.applyActions(run, actions);
      return this.orchestratorTurn(run, `The human says: ${human.join("\n")}\n\n${this.statusReport(run)}`);
    }
    this.applyActions(run, actions);
  }

  private applyActions(run: OrchestraRun, actions: OrchestraAction[]): void {
    const notes: string[] = [];
    let finished: { summary: string } | null = null;
    let question: string | null = null;
    for (const a of actions) {
      try {
        if (a.type === "spawn") this.addTask(run, a);
        else if (a.type === "send") this.followUp(run, a.task, a.message);
        else if (a.type === "cancel") this.cancelTask(run, a.task);
        else if (a.type === "ask") question = a.question;
        else if (a.type === "done") finished = { summary: a.summary };
      } catch (err) {
        notes.push(`${a.type}: ${(err as Error).message}`);
      }
    }
    this.save(run);
    this.emit(run, "plan", {
      round: run.round,
      actions: actions.map((a) => a.type),
      tasks: run.tasks.map(taskSummary),
      ...(notes.length ? { rejected: notes } : {}),
    });

    if (question) {
      run.status = "waiting_human";
      run.question = question;
      this.save(run);
      this.emit(run, "waiting", { question });
      return;
    }
    const outstanding = run.tasks.some((t) => t.status === "running" || t.status === "pending");
    // Nothing running, nothing asked, nothing new: asking again would just loop
    // to maxRounds (a scripted or real model that says "keep waiting" when there
    // is nothing to wait for). Stop and let a human steer.
    if (!actions.length && !outstanding) {
      run.status = "waiting_human";
      run.question = "Nothing is running and the orchestrator gave no next step. Reply to steer it, or tell it to finish.";
      this.save(run);
      this.emit(run, "waiting", { question: run.question });
      return;
    }
    if (finished && !outstanding) {
      return void this.finish(run, "completed", undefined, (finished as { summary: string }).summary);
    }
    if (finished && outstanding) {
      notes.push("done ignored: tasks are still running — review their results first");
    }
    if (notes.length && !outstanding) {
      // Nothing to wait for and something went wrong: tell the orchestrator now.
      void this.orchestratorTurn(run, `Some actions were rejected:\n- ${notes.join("\n- ")}\n\n${this.statusReport(run)}`);
      return;
    }
    run.status = "running";
    this.save(run);
    // Plan mode: the specs land on the integration branch BEFORE any task
    // branches from it, so every worker's worktree already has its file.
    if (run.plan && actions.some((a) => a.type === "spawn")) {
      void this.writePlan(run, "plan").then(() => this.schedule(run));
    } else {
      this.schedule(run);
    }
  }

  /** Write (or refresh) plans/<run>/ on the integration branch and commit it. */
  private async writePlan(run: OrchestraRun, why: "plan" | "final"): Promise<void> {
    try {
      await this.gitLock.run(async () => {
        const dir = path.join(run.dir, planDir(run));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "PLAN.md"), renderPlanIndex(run));
        for (const t of run.tasks) fs.writeFileSync(path.join(dir, `${t.id}.md`), renderTaskFile(run, t));
        await git(["add", "--", planDir(run)], run.dir);
        const staged = (await git(["diff", "--cached", "--name-only"], run.dir)).trim();
        if (staged) {
          await git(
            ["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "commit", "-q", "--no-verify", "-m",
              why === "plan" ? `plan: ${run.goal.split("\n")[0]!.slice(0, 60)}` : `plan: results of orchestra ${run.id}`],
            run.dir,
          );
        }
      });
      this.emit(run, "plan_written", { dir: planDir(run), files: run.tasks.length + 1, final: why === "final" });
    } catch (err) {
      this.emit(run, "plan_failed", { error: (err as Error).message.slice(0, 300) });
    }
  }

  private addTask(run: OrchestraRun, a: Extract<OrchestraAction, { type: "spawn" }>): OrchestraTask {
    const allowed = this.workersFor(run);
    const cfg =
      allowed.find((w) => w.id.toLowerCase() === a.agent.toLowerCase()) ??
      allowed.find((w) => w.kind === this.resolveAgent(a.agent)?.kind);
    if (!cfg) {
      throw new Error(`agent "${a.agent}" is not one of this run's workers (${run.workers.join(", ")})`);
    }
    let id = (a.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);
    // Re-sending a spawn for a task that hasn't started revises it: that's how
    // the orchestrator answers a hold (an overlap decision, narrower touches,
    // another agent) without inventing a new task.
    const unstarted = run.tasks.find((t) => t.id === id && t.attempts === 0 && t.status === "pending");
    if (unstarted) {
      unstarted.title = a.title.slice(0, 120);
      unstarted.prompt = a.prompt;
      unstarted.agent = cfg.id;
      unstarted.kind = cfg.kind;
      if (a.touches?.length) unstarted.touches = a.touches;
      if (a.overlap) unstarted.overlap = a.overlap;
      if (a.dependsOn) unstarted.dependsOn = a.dependsOn.filter((d) => d !== id && run.tasks.some((t) => t.id === d));
      unstarted.hold = undefined;
      this.emit(run, "task", { task: taskSummary(unstarted) });
      return unstarted;
    }
    if (!id || run.tasks.some((t) => t.id === id)) id = `t${run.tasks.length + 1}`;
    while (run.tasks.some((t) => t.id === id)) id = `${id}x`;
    const deps = (a.dependsOn ?? []).filter((d) => run.tasks.some((t) => t.id === d));
    const chat = this.host.createChat(`${id} · ${a.title}`.slice(0, 60));
    const task: OrchestraTask = {
      id,
      title: a.title.slice(0, 120),
      prompt: a.prompt,
      agent: cfg.id,
      kind: cfg.kind,
      dependsOn: deps,
      ...(a.touches?.length ? { touches: a.touches } : {}),
      ...(a.overlap ? { overlap: a.overlap } : {}),
      status: "pending",
      chat: chat.id,
      attempts: 0,
      queued: [],
    };
    run.tasks.push(task);
    this.emit(run, "task", { task: taskSummary(task) });
    return task;
  }

  private followUp(run: OrchestraRun, taskId: string, message: string): void {
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`no task "${taskId}"`);
    if (task.status === "cancelled") throw new Error(`task ${taskId} was cancelled`);
    task.queued.push(message);
    task.reported = false;
    if (task.status !== "running") task.status = "pending";
  }

  private cancelTask(run: OrchestraRun, taskId: string): void {
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`no task "${taskId}"`);
    if (task.status === "done") throw new Error(`task ${taskId} already merged`);
    task.status = "cancelled";
    task.reported = true;
    const live = this.live.get(`${run.id}/${task.id}`);
    if (live?.busy()) void live.interrupt().catch(() => {});
    this.emit(run, "task", { task: taskSummary(task) });
  }

  // ── scheduling ──

  private admitting = new Set<string>(); // `${run}/${task}` mid-admission
  private recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private schedule(run: OrchestraRun): void {
    if (run.status !== "running" || run.moving) return;
    if (this.overBudget(run)) return;
    const inFlight = run.tasks.filter((t) => t.status === "running" || this.admitting.has(`${run.id}/${t.id}`)).length;
    let slots = run.maxParallel - inFlight;
    let waiting = false;
    for (const task of run.tasks) {
      if (slots <= 0) break;
      if (task.status !== "pending") continue;
      if (this.admitting.has(`${run.id}/${task.id}`)) continue;
      // "decide" holds wait for the orchestrator; the rest are re-checked, not hammered
      if (task.hold?.kind === "decide") continue;
      if (task.hold && Date.now() - (task.hold.checkedAt ?? task.hold.since) < RECHECK_MS) {
        waiting = true;
        continue;
      }
      const deps = task.dependsOn.map((d) => run.tasks.find((t) => t.id === d));
      if (deps.some((d) => d && (d.status === "failed" || d.status === "cancelled"))) {
        task.status = "failed";
        task.error = "a dependency failed or was cancelled";
        task.reported = false;
        this.emit(run, "task", { task: taskSummary(task) });
        continue;
      }
      if (!deps.every((d) => !d || d.status === "done")) continue;
      slots--;
      void this.admitAndRun(run, task);
    }
    this.save(run);
    if (waiting || run.tasks.some((t) => t.status === "pending" && t.hold && t.hold.kind !== "decide")) this.armRecheck(run);
    this.maybeReview(run);
  }

  private armRecheck(run: OrchestraRun): void {
    if (this.recheckTimers.has(run.id)) return;
    const t = setTimeout(() => {
      this.recheckTimers.delete(run.id);
      if (!isTerminal(run.status)) this.schedule(run);
    }, RECHECK_MS);
    t.unref?.();
    this.recheckTimers.set(run.id, t);
  }

  /** Something the team coordinator watches changed (a lease freed, a PR merged): look again now. */
  recheck(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    for (const t of run.tasks) if (t.hold && t.hold.kind !== "decide") t.hold.checkedAt = 0;
    this.schedule(run);
  }

  /**
   * Stop a running task and hold it (D33: drift into someone's hard zone).
   * It keeps its worktree and session; when the hold clears it resumes with a
   * "continue" follow-up instead of starting over.
   */
  pauseTask(runId: string, taskId: string, hold: TaskHold): void {
    const run = this.runs.get(runId);
    const task = run?.tasks.find((t) => t.id === taskId);
    if (!run || !task || task.status !== "running") return;
    task.status = "pending";
    task.hold = hold;
    task.queued.unshift(
      `You were paused: ${hold.reason}. It's clear now — continue your task where you left off, and stay out of the area you were paused for unless you must.`,
    );
    const live = this.live.get(`${run.id}/${task.id}`);
    if (live?.busy()) void live.interrupt().catch(() => {});
    this.save(run);
    this.emit(run, "task", { task: taskSummary(task) });
    this.emit(run, "task_held", { taskId: task.id, hold }, task.chat);
  }

  /**
   * The owner says stop waiting (D32): a `wait:` hold is released and the task
   * proceeds alongside the other goal, with the reason on record.
   */
  stopWaiting(runId: string, taskId: string): OrchestraTask {
    const run = this.mustGet(runId);
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`no task "${taskId}"`);
    if (task.hold?.kind !== "wait") throw new Error(`task ${taskId} isn't waiting on another goal`);
    task.overlap = `proceed:the owner stopped waiting on ${task.hold.runId ?? "the other goal"}`;
    task.hold = undefined;
    this.save(run);
    this.emit(run, "task", { task: taskSummary(task) });
    this.schedule(run);
    return task;
  }

  /** A team fact for the orchestrator's next review (D33, D34). */
  addNote(runId: string, note: string): void {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status)) return;
    run.notes = [...(run.notes ?? []), note.slice(0, 1000)].slice(-20);
    this.save(run);
  }

  /** Ask the team coordinator (if any) whether this task may start, then start it. */
  private async admitAndRun(run: OrchestraRun, task: OrchestraTask): Promise<void> {
    const coord = this.host.coordinator?.();
    if (!coord) return this.runTask(run, task);
    const key = `${run.id}/${task.id}`;
    this.admitting.add(key);
    let a: Admission;
    try {
      a = await coord.admit(run, task);
    } catch (err) {
      a = { go: false, hold: { kind: "capacity", reason: `team hub unreachable: ${(err as Error).message}`, since: Date.now() } };
    }
    this.admitting.delete(key);
    if (isTerminal(run.status) || task.status !== "pending") return;
    if (!a.go) {
      const was = task.hold?.reason;
      task.hold = { ...a.hold, since: task.hold?.since ?? a.hold.since, checkedAt: Date.now() };
      task.reported = false;
      this.save(run);
      if (was !== task.hold.reason) {
        this.emit(run, "task", { task: taskSummary(task) });
        this.emit(run, "task_held", { taskId: task.id, hold: task.hold }, task.chat);
      }
      this.schedule(run);
      return;
    }
    task.hold = undefined;
    if (a.note) this.addNote(run.id, a.note);
    if (a.rebase) {
      try {
        await this.syncWithBase(run);
      } catch (err) {
        task.hold = { kind: "decide", reason: `couldn't bring fresh ${run.baseBranch ?? "main"} into the goal before starting: ${(err as Error).message}`, since: Date.now() };
        this.save(run);
        this.emit(run, "task", { task: taskSummary(task) });
        this.maybeReview(run);
        return;
      }
    }
    return this.runTask(run, task);
  }

  /**
   * Bring the base branch's latest into the integration branch (D30): a task
   * that waited for a teammate's PR must build on the merged code.
   */
  private async syncWithBase(run: OrchestraRun): Promise<void> {
    const base = run.baseBranch;
    if (!base) return;
    await this.gitLock.run(async () => {
      await git(["fetch", "-q", "origin", base], run.dir).catch(() => {});
      const ref = (await gitOk(["rev-parse", "--verify", `origin/${base}`], run.dir)) ? `origin/${base}` : base;
      await commitAll(run.dir, `orchestra ${run.id}: orchestrator edits`);
      try {
        await git(["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "merge", "--no-edit", "-q", ref], run.dir);
      } catch (err) {
        await git(["merge", "--abort"], run.dir).catch(() => {});
        throw err;
      }
    });
    this.emit(run, "synced", { with: base });
  }

  /** When nothing can move without the orchestrator, give it a turn. */
  private maybeReview(run: OrchestraRun): void {
    if (run.status !== "running" || this.orchestratorBusy.has(run.id)) return;
    if (run.tasks.some((t) => t.status === "running" || this.admitting.has(`${run.id}/${t.id}`))) return;
    const ready = (t: OrchestraTask) =>
      t.status === "pending" && t.dependsOn.every((d) => run.tasks.find((x) => x.id === d)?.status === "done");
    if (run.tasks.some((t) => ready(t) && !t.hold)) return;
    // Waiting on teammates (a PR, a zone, capacity) is not a reason to wake
    // the orchestrator — unless something needs its decision.
    const needsDecision = run.tasks.some((t) => ready(t) && t.hold?.kind === "decide");
    if (!needsDecision && run.tasks.some((t) => ready(t) && t.hold)) return;
    run.status = "reviewing";
    this.save(run);
    this.emit(run, "reviewing", { round: run.round + 1 });
    void this.orchestratorTurn(run, this.statusReport(run));
  }

  /** The report the orchestrator reviews: every task's outcome since last time. */
  statusReport(run: OrchestraRun): string {
    const lines = [`Status of orchestra run ${run.id} (integration branch ${run.branch}):`];
    for (const t of run.tasks) {
      const head = `\n### ${t.id} · ${t.title} — ${t.status.toUpperCase()} (worker: ${t.agent}, attempts: ${t.attempts})`;
      lines.push(head);
      if (t.reported && (t.status === "done" || t.status === "cancelled")) {
        lines.push("(already reviewed)");
        continue;
      }
      if (t.files?.length) lines.push(`Files changed: ${t.files.slice(0, 30).join(", ")}${t.files.length > 30 ? " …" : ""}`);
      if (t.status === "conflict") {
        lines.push(
          `Its branch ${t.branch} conflicts with the integration branch. To fix, send it a follow-up asking it to ` +
            `run \`git merge ${run.branch}\` in its worktree, resolve the conflicts, and verify.`,
        );
      }
      if (t.hold) {
        lines.push(`On hold (${t.hold.kind}): ${t.hold.reason}`);
        if (t.hold.kind === "decide") {
          lines.push(
            `Answer by re-sending the spawn for ${t.id} (same id) with "overlap": "wait:<goal id>" (start after that ` +
              `teammate's PR merges), "narrow" (with revised, non-overlapping "touches"), or "proceed:<why it's safe>"; ` +
              `or give it "touches" / another agent as the reason says.`,
          );
        }
      }
      if (t.error) lines.push(`Error: ${t.error}`);
      if (t.result) lines.push(`Worker report:\n${t.result}`);
      t.reported = true;
    }
    if (run.notes?.length) {
      lines.push("\n## From your team");
      for (const n of run.notes) lines.push(`- ${n}`);
      run.notes = [];
    }
    lines.push(
      "\nReview the results (the integration branch in your working directory has every merged task). " +
        "Reply with your next actions — follow-ups, new tasks, or done.",
    );
    this.save(run);
    return lines.join("\n");
  }

  private async runTask(run: OrchestraRun, task: OrchestraTask): Promise<void> {
    task.status = "running";
    task.attempts++;
    task.startedAt ??= Date.now();
    task.error = undefined;
    this.save(run);
    this.emit(run, "task", { task: taskSummary(task) });
    this.emit(run, "task_started", { taskId: task.id, agent: task.agent, title: task.title }, task.chat);

    const key = `${run.id}/${task.id}`;
    try {
      this.host.gate(task.agent);
      if (!task.dir) {
        const slug = task.id;
        const branch = `${run.branch.replace(/\/main$/, "")}/${slug}`;
        const dir = path.join(path.dirname(run.dir), slug);
        await this.gitLock.run(async () => {
          // Branch from the integration tip, so dependencies' work is there.
          const tip = (await git(["rev-parse", "HEAD"], run.dir)).trim();
          await git(["worktree", "add", "-q", "-b", branch, dir, tip], this.host.projectDir);
        });
        task.branch = branch;
        task.dir = dir;
        this.save(run);
      }
      let agent = this.live.get(key);
      if (!agent) {
        const cfg = this.resolveAgent(task.agent) ?? { id: task.agent, kind: task.kind, role: "worker" };
        agent = this.host.makeAgent({ ...cfg, role: "worker" }, task.dir!);
        this.live.set(key, agent);
        this.wire(run, agent, cfg.id, task.chat, key);
        await agent.start();
      }

      // The first attempt always sends the task itself — a follow-up the
      // orchestrator queued in the same breath waits its turn behind it.
      const first = task.attempts === 1;
      const text = first ? task.prompt : task.queued.shift()!;
      this.host.append({
        kind: "message",
        chat: task.chat,
        payload: { text, author: first ? "orchestrator" : "orchestrator", orchestra: { runId: run.id, taskId: task.id } },
      });
      this.turnText.set(key, "");
      const briefing = first
        ? workerBriefing({
            project: this.host.projectName,
            runGoal: run.goal,
            task,
            branch: task.branch!,
            brain: this.host.briefingFor(task.prompt, task.agent, task.touches ?? task.files ?? []),
            ...(run.plan ? { planFile: `${planDir(run)}/${task.id}.md` } : {}),
          })
        : undefined;
      await agent.send({ text, ...(briefing ? { briefing } : {}) });
      if ((task.status as TaskStatus) === "cancelled" || isTerminal(run.status)) return;
      // paused mid-turn (pauseTask): not finished, nothing to integrate yet
      if ((task.status as TaskStatus) === "pending") {
        this.schedule(run);
        return;
      }

      const reply = (this.turnText.get(key) ?? "").trim();
      task.result = reply.length > RESULT_CHARS ? `${reply.slice(0, RESULT_CHARS)}\n… (truncated)` : reply || "(no report)";
      const turnError = this.lastError.get(key);
      this.lastError.delete(key);
      if (turnError) task.error = turnError;

      // A turn that errored and said nothing died — it is not "done", and a
      // task depending on it must not start on top of it. (An error event
      // alongside a real report is a warning the orchestrator gets to read.)
      if (turnError && !reply) {
        task.status = "failed";
      } else if (task.queued.length) {
        // The orchestrator already queued a follow-up: keep going on the same
        // worktree before merging.
        task.status = "pending";
      } else {
        await this.integrate(run, task);
      }
    } catch (err) {
      if ((task.status as TaskStatus) !== "cancelled") {
        task.status = "failed";
        task.error = (err as Error).message.slice(0, 1000);
      }
    }
    task.finishedAt = Date.now();
    task.reported = false;
    this.save(run);
    this.emit(run, "task", { task: taskSummary(task) });
    this.emit(run, "task_finished", { taskId: task.id, status: task.status, files: task.files ?? [] }, task.chat);
    if ((task.status as TaskStatus) === "done") this.host.coordinator?.()?.onTaskDone?.(run, task);
    this.schedule(run);
  }

  private lastError = new Map<string, string>();

  private async integrate(run: OrchestraRun, task: OrchestraTask): Promise<void> {
    const dir = task.dir!;
    await this.gitLock.run(async () => {
      await commitAll(dir, taskCommitMessage(run, task, this.host.member?.() ?? null));
      const files = (await git(["diff", "--name-only", `${run.baseCommit}...HEAD`], dir).catch(() => ""))
        .split("\n")
        .filter(Boolean);
      task.files = files;
      // Anything the orchestrator left lying in the integration tree would
      // block the merge; record it rather than lose it.
      await commitAll(run.dir, `orchestra ${run.id}: orchestrator edits`);
      try {
        await git(
          ["-c", "user.name=Loom Orchestra", "-c", "user.email=orchestra@loom.local", "merge", "--no-ff", "--no-edit", "-m", `orchestra ${task.id}: ${task.title}`, task.branch!],
          run.dir,
        );
        task.status = "done";
        task.mergeCommit = (await git(["rev-parse", "HEAD"], run.dir)).trim();
        const stat = await git(["diff", "--shortstat", `${task.mergeCommit}^1`, task.mergeCommit], run.dir).catch(() => "");
        task.lines = [...stat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
      } catch (err) {
        await git(["merge", "--abort"], run.dir).catch(() => {});
        task.status = "conflict";
        task.error = `merge conflict: ${(err as Error).message.slice(0, 400)}`;
      }
    });
    if (task.status === "needs_input") return;
    if (task.status === "done" && /\?\s*$/.test(task.result ?? "") && !task.files?.length) {
      // Ended on a question and changed nothing: it's asking, not done.
      task.status = "needs_input";
    }
  }

  // ── event wiring ──

  private wire(run: OrchestraRun, agent: Adapter, agentId: string, chat: string, key: string): void {
    agent.onEvent((e) => {
      const p = e.payload as Record<string, unknown>;
      if (e.kind === "message" && !p.reasoning && p.role !== "user") {
        const prev = this.turnText.get(key) ?? "";
        this.turnText.set(key, `${prev}\n${String(p.text ?? "")}`.slice(-20_000));
      }
      if (e.kind === "error") this.lastError.set(key, String(p.message ?? "error"));
      if (e.kind === "file_edit" && !key.endsWith("/orch") && typeof p.path === "string") {
        const task = run.tasks.find((t) => `${run.id}/${t.id}` === key);
        if (task) this.host.coordinator?.()?.onEdit?.(run, task, p.path);
      }
      const event = this.host.append({
        kind: e.kind,
        agentId,
        chat,
        payload: { ...p, orchestra: { runId: run.id, ...(key.endsWith("/orch") ? { role: "orchestrator" } : { taskId: key.split("/")[1] }) } },
      });
      if (e.kind === "status" && p.state === "turn_cost") {
        const usd = Number(p.costUsd ?? 0);
        if (usd > 0) {
          run.costUsd += usd;
          const task = run.tasks.find((t) => `${run.id}/${t.id}` === key);
          if (task) task.costUsd = (task.costUsd ?? 0) + usd;
        }
      }
      this.host.observe(event);
    });
  }

  private async finish(run: OrchestraRun, status: "completed" | "failed", error?: string, summary?: string): Promise<void> {
    // Do the slow parts first, then flip the status and announce it in one
    // synchronous step: a client that sees "completed" must also find the
    // completed event (polling status in the gap raced this).
    await this.stopAll(run);
    if (run.plan) {
      // The plan's final state — statuses and results — rides the branch too.
      const final = { ...run, status, ...(error ? { error } : {}), ...(summary ? { summary } : {}) };
      await this.writePlan(final as OrchestraRun, "final");
    }
    const commits = await git(["rev-list", "--count", `${run.baseCommit}..${run.branch}`], this.host.projectDir).catch(() => "0");
    // Aborted while we were finishing up: the human's abort stands.
    if (run.status === "aborted") return;
    run.status = status;
    if (error) run.error = error;
    if (summary) run.summary = summary;
    this.save(run);
    this.emit(run, status, {
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
      branch: run.branch,
      commits: Number(commits.trim()) || 0,
      tasks: run.tasks.map(taskSummary),
      costUsd: run.costUsd,
    });
    if (summary) {
      this.host.append({
        kind: "message",
        agentId: run.orchestrator.agent,
        chat: run.chat,
        payload: { text: `**Orchestra complete.** ${summary}\n\nAll work is on branch \`${run.branch}\` — apply it to merge into your branch.`, orchestra: { runId: run.id, role: "summary" } },
      });
    }
    this.host.coordinator?.()?.onRunEnd?.(run);
    // A goal that already has a PR (a fix round, an adopted goal) always goes back to that PR.
    if (status === "completed") await this.deliver(run, run.from || run.delivered?.prUrl ? "pr" : undefined);
  }

  /**
   * Do what the project's git delivery policy says with a completed run:
   * nothing, merge it in, merge and push, or push its branch and open a PR.
   * A failure here never un-completes the run — the work is safe on its
   * branch — it's reported, and the manual Apply is still there.
   */
  /**
   * D59: where a big goal's stack is cut — tasks in the order they merged into
   * the integration branch, sliced by size (cutStack). Null when unknowable.
   */
  private async stackSlices(run: OrchestraRun): Promise<MergedTask[][] | null> {
    const order = (await git(["rev-list", "--first-parent", "--reverse", `${run.baseCommit}..${run.branch}`], run.dir).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    const merged = run.tasks
      .filter((t) => t.status === "done" && t.mergeCommit && order.includes(t.mergeCommit))
      .sort((a, b) => order.indexOf(a.mergeCommit!) - order.indexOf(b.mergeCommit!))
      .map((t) => ({ id: t.id, commit: t.mergeCommit!, lines: t.lines ?? 0, dependsOn: t.dependsOn }));
    return merged.length ? cutStack(merged) : null;
  }

  /**
   * Push one branch per slice and open a PR for each, each based on the one
   * below; the top slice is the goal's own branch (so fixes land on it). The
   * landing manager lands them bottom-up with the merge method.
   */
  private async deliverStack(run: OrchestraRun, slices: MergedTask[][]): Promise<string> {
    const prefix = run.branch.replace(/\/main$/, "");
    const base = run.baseBranch ?? "main";
    const stack: NonNullable<LandingState["stack"]> = [];
    let below = base;
    for (let i = 0; i < slices.length; i++) {
      const top = i === slices.length - 1;
      const branch = top ? run.branch : `${prefix}/stack-${i + 1}`;
      if (!top) await git(["push", "-q", "-f", "origin", `${slices[i]!.at(-1)!.commit}:refs/heads/${branch}`], run.dir);
      const ids = slices[i]!.map((t) => t.id);
      const out = await gh(
        ["pr", "create", "--head", branch, "--base", below,
          "--title", `${run.goal.split("\n")[0]!.slice(0, 60)} (${i + 1}/${slices.length})`,
          "--body", prBody(run, [`Part ${i + 1} of ${slices.length} of a stacked goal — tasks ${ids.join(", ")}. Land bottom-up.`, ""])],
        this.host.projectDir,
      );
      const url = out.match(/https:\/\/\S+/)?.[0] ?? "";
      stack.push({ pr: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url, branch, base: below });
      below = branch;
    }
    const topPr = stack.at(-1)!;
    run.landing = { ...newLanding(topPr.pr, topPr.url), stack };
    this.emit(run, "stacked", { stack });
    return topPr.url;
  }

  async deliver(run: OrchestraRun, mode: GitDelivery = this.host.gitDelivery?.() ?? "none"): Promise<void> {
    if (mode === "none") return;
    // D38: a protected branch only receives PRs, whatever the project setting says.
    const intoBranch = run.baseBranch ?? "";
    if ((mode === "commit" || mode === "push") && intoBranch && this.host.coordinator?.()?.isProtected?.(intoBranch)) {
      this.emit(run, "delivery_policy", { from: mode, to: "pr", branch: intoBranch });
      mode = "pr";
    }
    try {
      if (mode === "commit" || mode === "push") {
        const { into } = await this.apply(run.id);
        let pushed: string | undefined;
        if (mode === "push") {
          const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], this.host.projectDir).catch(() => "");
          await git(up.trim() ? ["push", "-q"] : ["push", "-q", "-u", "origin", into], this.host.projectDir);
          pushed = into;
        }
        run.delivered = { mode, into, ...(pushed ? { pushed } : {}), at: Date.now() };
      } else if (mode === "pr") {
        await this.gitLock.run(() => commitAll(run.dir, `orchestra ${run.id}: final edits`).catch(() => false));
        const target = this.prBranch(run);
        await git(["push", "-q", "-u", "origin", `${run.branch}:${target}`], run.dir);
        if (run.delivered?.prUrl || run.from) {
          // A fix to a PR that already exists (Phase 4): the push is the delivery.
          const prUrl = run.delivered?.prUrl ?? run.from!.url;
          run.delivered = { mode, pushed: target, prUrl, at: Date.now() };
        } else {
          const stack = this.host.coordinator?.()?.stackMode?.() === "auto" ? await this.stackSlices(run) : null;
          if (stack && stack.length > 1) {
            run.delivered = { mode, pushed: target, prUrl: await this.deliverStack(run, stack), at: Date.now() };
          } else {
            const out = await gh(
              ["pr", "create", "--head", run.branch, ...(run.baseBranch ? ["--base", run.baseBranch] : []),
                "--title", run.goal.split("\n")[0]!.slice(0, 70), "--body", prBody(run)],
              this.host.projectDir,
            );
            const prUrl = out.match(/https:\/\/\S+/)?.[0];
            run.delivered = { mode, pushed: run.branch, ...(prUrl ? { prUrl } : {}), at: Date.now() };
            const n = Number(/\/pull\/(\d+)/.exec(prUrl ?? "")?.[1]);
            if (prUrl && n) run.landing = newLanding(n, prUrl);
          }
        }
      }
      run.deliveryError = undefined;
      this.save(run);
      this.emit(run, "delivered", { ...run.delivered });
    } catch (err) {
      run.deliveryError = (err as Error).message.slice(0, 500);
      this.save(run);
      this.emit(run, "delivery_failed", { mode, error: run.deliveryError });
    }
  }
}

/** A new PR's landing record. */
export function newLanding(pr: number, url: string): LandingState {
  return { pr, url, state: "open", fixAttempts: 0, reruns: [], flaky: [], reviews: 0, updatedAt: Date.now() };
}

/** The goal PR's description: the summary, the task table, the plan. */
export function prBody(run: OrchestraRun, extra: string[] = []): string {
  return [
    run.summary ?? "",
    "",
    ...extra,
    "| task | agent | status | files |",
    "|---|---|---|---|",
    ...run.tasks.map((t) => `| ${t.id} · ${t.title} | ${t.agent} | ${t.status} | ${t.files?.length ?? 0} |`),
    "",
    ...(run.plan ? [`Plan: \`${planDir(run)}/PLAN.md\``, ""] : []),
    `Orchestrated by Loom · ${run.orchestrator.agent} with ${run.workers.join(", ")}`,
  ].join("\n");
}

/**
 * Verification commands a Claude orchestrator may run while reviewing.
 *
 * Headless Claude in acceptEdits mode can't run any shell command, so a Claude
 * orchestrator could only read the workers' code and take their word that the
 * tests passed (seen on a real run: "could not run node --test, approval not
 * granted"). Codex, sandboxed, just ran them. These are the checks a reviewer
 * runs — tests, typecheck, build, and read-only git — and nothing else.
 */
export const ORCHESTRATOR_VERIFY_TOOLS = [
  "npm test", "npm run test", "npm run build", "npm run typecheck", "npm run lint",
  "pnpm test", "yarn test", "bun test", "node --test", "npx vitest run", "npx tsc --noEmit",
  "cargo test", "cargo check", "go test", "go build", "pytest", "python -m pytest",
  "git log", "git diff", "git status", "git show",
].map((c) => `Bash(${c}:*)`);

function orchestratorOptions(cfg: AgentConfig): Record<string, unknown> | undefined {
  if (cfg.kind !== "claude-code") return cfg.options;
  const extra = Array.isArray(cfg.options?.extraArgs) ? (cfg.options!.extraArgs as string[]) : [];
  return { ...(cfg.options ?? {}), extraArgs: [...extra, "--allowedTools", ORCHESTRATOR_VERIFY_TOOLS.join(",")] };
}

export function taskSummary(t: OrchestraTask): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    agent: t.agent,
    kind: t.kind,
    status: t.status,
    dependsOn: t.dependsOn,
    chat: t.chat,
    attempts: t.attempts,
    files: t.files ?? [],
    ...(t.touches?.length ? { touches: t.touches } : {}),
    ...(t.overlap ? { overlap: t.overlap } : {}),
    ...(t.hold ? { hold: t.hold } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.costUsd ? { costUsd: t.costUsd } : {}),
  };
}

export function isTerminal(s: OrchestraStatus): boolean {
  return s === "completed" || s === "failed" || s === "aborted" || s === "moved";
}

/** Where a moved goal's branches travel: hidden refs, like WIP refs (D11, D75). */
export function runRef(runId: string, name: string): string {
  return `refs/loom/run/${runId}/${name}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(Number(n) || lo)));
}
