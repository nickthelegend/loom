/**
 * Runners' view model (Loom Teams Phase 5, D67–D78), kept free of React Native
 * so it can be tested with plain node (`npm test` in app/): what a runner job's
 * state looks like, which buttons a goal or job offers, the deploy chips, and
 * where a tapped push notification leads.
 *
 * Only type imports from ./api, so running this file under node strips them
 * and never loads the app's network layer. Colours are named as tones (the
 * same ones Landing uses); the view maps a tone onto the theme.
 */

import type { OrchestraRun, RunnerJob, TeamDeployment, TeamRunner, TeamRunners } from "./api";
import type { Tone } from "./team-landing-model";

export interface Chip {
  label: string;
  tone: Tone;
}

export const JOB_STATE_CHIP: Record<string, Chip> = {
  queued: { label: "queued", tone: "dim" },
  claimed: { label: "on runner", tone: "live" },
  done: { label: "done", tone: "ok" },
  failed: { label: "failed", tone: "err" },
  cancelled: { label: "cancelled", tone: "dim" },
};

/** A state a newer daemon invents still gets a quiet chip rather than a crash. */
export function jobStateChip(state: string): Chip {
  return JOB_STATE_CHIP[state] ?? { label: state || "unknown", tone: "dim" };
}

const KIND_LABEL: Record<string, string> = {
  start: "start",
  continue: "moved",
  fix: "CI fix",
  return: "bring back",
  land: "land",
};

export function jobKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** "3/5 tasks" from the runner's snapshot; null before it has planned any. */
export function jobTasks(j: Pick<RunnerJob, "progress">): { done: number; total: number } | null {
  const tasks = j.progress?.tasks ?? [];
  if (!tasks.length) return null;
  return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length };
}

/** Kinds of job whose runner holds a whole goal (a "fix" or "land" only touches its PR). */
const HOLDS_GOAL = new Set(["start", "continue"]);
const LANDING_DONE = new Set(["merged", "closed"]);

/** The goal a job carries — the snapshot's run id first (a start job learns its id once running). */
export function jobRunId(j: Pick<RunnerJob, "runId" | "progress">): string | null {
  return j.progress?.runId ?? j.runId ?? null;
}

export type JobButton = "bring-back" | "land";

/**
 * Which buttons a job's card shows. Only your own goals, and only while a
 * runner holds them (claimed): Bring back moves it home (D76); Land once the
 * runner's snapshot shows a goal PR that isn't merged, closed or landing already.
 */
export function jobButtons(j: Pick<RunnerJob, "kind" | "state" | "mine" | "runId" | "progress">): JobButton[] {
  if (!j.mine || j.state !== "claimed" || !HOLDS_GOAL.has(j.kind) || !jobRunId(j)) return [];
  const out: JobButton[] = [];
  const l = j.progress?.landing;
  const landingNow = !!l && (l.state === "landing" || (l.landRequested && l.state !== "needs_human"));
  if (l?.pr && !LANDING_DONE.has(l.state) && !landingNow) out.push("land");
  out.push("bring-back");
  return out;
}

/** The job currently holding a goal (the daemon's holderJob, from what the phone can see). */
export function holderJob(jobs: readonly RunnerJob[], runId: string): RunnerJob | null {
  return (
    jobs.find((j) => HOLDS_GOAL.has(j.kind) && (j.state === "queued" || j.state === "claimed") && jobRunId(j) === runId) ?? null
  );
}

const LIVE = new Set(["starting", "planning", "running", "reviewing", "waiting_human"]);

/** A goal still working here, that could move to a runner (D75). */
export function isRunLive(status: string): boolean {
  return LIVE.has(status);
}

/** Runners this project's goals can go to: yours, and teammates' shared ones. Online first. */
export function usableRunners(runners: readonly TeamRunner[]): TeamRunner[] {
  return runners
    .filter((r) => r.mine || r.shared)
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.mine) - Number(a.mine) || b.lastSeen - a.lastSeen);
}

export type RunButton = "continue" | "bring-back" | "land";

/**
 * Which runner buttons a local Orchestra run shows: Continue on runner while it
 * runs here (and some runner can take it), Bring back / Land once it has moved
 * and a runner holds it.
 */
export function runButtons(
  run: Pick<OrchestraRun, "id" | "status" | "moving">,
  view: TeamRunners | null | undefined,
): RunButton[] {
  if (!view) return [];
  if (run.status === "moved") {
    const j = holderJob(view.jobs, run.id);
    return j ? jobButtons(j) : [];
  }
  if (run.moving || !isRunLive(run.status)) return [];
  return usableRunners(view.runners).length ? ["continue"] : [];
}

export function runnerName(r: Pick<TeamRunner, "label" | "github" | "mine">): string {
  const label = r.label || "runner";
  return r.mine ? label : `${label} (@${r.github})`;
}

export function continueConfirm(runner: string): string {
  return `Running tasks finish their turn (up to 2 min), then it continues on ${runner}.`;
}

export function startConfirm(runner: string, plan: boolean): string {
  return `The goal starts on ${runner}${plan ? " in plan mode" : ""}. Its tasks, cost and PR show here as it goes.`;
}

export function bringBackConfirm(): string {
  return "The runner lets running turns finish, pushes the goal's branches, and it carries on on your computer.";
}

/** "moved to runner box-1" for a run that went elsewhere. */
export function movedLabel(run: Pick<OrchestraRun, "status" | "movedTo">): string | null {
  if (run.status !== "moved") return null;
  return `moved to ${run.movedTo?.where || "another machine"}`;
}

/** Runners tab: when the project is shared with a team, or there's anything to show. */
export function runnersTabVisible(s: { shared: boolean; hidden: boolean; runners: number; jobs: number }): boolean {
  return !s.hidden && (s.shared || s.runners > 0 || s.jobs > 0);
}

/** Your goals the runners are holding or queued with — the tab badge. */
export function activeJobCount(view: TeamRunners | null | undefined): number {
  return (view?.jobs ?? []).filter((j) => j.mine && (j.state === "queued" || j.state === "claimed")).length;
}

/** Newest first; live jobs above finished ones. */
export function sortJobs(jobs: readonly RunnerJob[]): RunnerJob[] {
  const live = (j: RunnerJob) => (j.state === "queued" || j.state === "claimed" ? 0 : 1);
  const at = (j: RunnerJob) => j.progress?.at ?? j.updatedAt ?? j.createdAt ?? 0;
  return [...jobs].sort((a, b) => live(a) - live(b) || at(b) - at(a));
}

// ── deploys (D72, read-only) ──

export function deployChip(state: string): Chip {
  switch (state) {
    case "success":
      return { label: "deployed", tone: "ok" };
    case "failure":
    case "error":
      return { label: state === "error" ? "error" : "failed", tone: "err" };
    case "in_progress":
    case "queued":
    case "pending":
      return { label: state.replace(/_/g, " "), tone: "live" };
    case "inactive":
      return { label: "inactive", tone: "dim" };
    default:
      return { label: state || "unknown", tone: "dim" };
  }
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

/** Only web links leave the app — the URL comes from the git host. */
export function deployUrl(d: Pick<TeamDeployment, "url">): string | null {
  return typeof d.url === "string" && /^https?:\/\//i.test(d.url) ? d.url : null;
}

// ── push notification → where the app opens ──

export type NotificationTab = "thread" | "orchestra";

export interface NotificationRoute {
  projectId: string;
  tab: NotificationTab;
  runId?: string;
}

/**
 * The daemon's pushes carry `data: { projectId, kind, runId? }` (LoomDaemon.maybePush):
 * runId is set for orchestra alerts. A goal opens the Orchestra tab on that
 * run; anything else (a question, a finished turn) opens the project's thread.
 * Anything without a project id isn't ours to route.
 */
export function notificationRoute(data: unknown): NotificationRoute | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const projectId = typeof d.projectId === "string" ? d.projectId.trim() : "";
  if (!projectId) return null;
  const runId = typeof d.runId === "string" && d.runId.trim() ? d.runId.trim() : undefined;
  if (runId) return { projectId, tab: "orchestra", runId };
  return { projectId, tab: d.kind === "orchestra" ? "orchestra" : "thread" };
}
