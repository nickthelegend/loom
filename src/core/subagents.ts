/**
 * Every agent working for an orchestrator, in one list: the tasks of an
 * Orchestra run, the entrants of a race, the teammates of a crew. The desktop
 * opens it as a "Subagents" tab when a goal starts, and the phone shows the
 * same list — who is working right now, who has finished, and a way into each
 * one's own thread.
 */

import type { CrewView } from "./crew.js";
import type { OrchestraRun } from "./orchestra.js";

export type SubagentStatus = "running" | "asks" | "pending" | "done" | "failed" | "cancelled";

export interface Subagent {
  /** Stable across polls, so a client can keep its selection. */
  id: string;
  /** What it's doing: the task's title, or the teammate's role. */
  name: string;
  /** Roster agent id and adapter kind, for the logo. */
  agentId: string;
  kind: string;
  status: SubagentStatus;
  /** Its own thread. */
  chat?: string;
  /** Where it came from: an Orchestra run, a race, a crew. */
  source: "orchestra" | "race" | "crew";
  /** The goal it serves, for grouping. */
  goal: string;
  goalId: string;
  /** Last time it did anything (start, finish, or its thread's latest event). */
  at: number;
  costUsd?: number;
  /** One line of what it's on or what it produced. */
  note?: string;
}

export interface SubagentList {
  active: Subagent[];
  done: Subagent[];
}

/** A report as one plain line: markdown marks and runs of whitespace gone. */
function oneLine(md: string): string {
  return md.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 160);
}

const ACTIVE: ReadonlySet<SubagentStatus> = new Set(["running", "asks", "pending"]);

function taskStatus(s: string): SubagentStatus {
  if (s === "running") return "running";
  if (s === "needs_input") return "asks";
  if (s === "pending") return "pending";
  if (s === "done") return "done";
  if (s === "cancelled") return "cancelled";
  return "failed"; // failed, conflict
}

/**
 * @param lastActivity  chat id → latest event time, so a teammate's "when" is
 *                      its last word rather than when the goal began.
 * @param recentRuns    how many Orchestra runs back to include (newest first).
 */
export function subagents(
  runs: readonly OrchestraRun[],
  crews: readonly CrewView[],
  lastActivity: ReadonlyMap<string, number>,
  opts: { kindOf?: (agentId: string) => string | undefined; recentRuns?: number } = {},
): SubagentList {
  const out: Subagent[] = [];
  const recent = [...runs].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).slice(0, opts.recentRuns ?? 5);
  for (const run of recent) {
    const live = run.status !== "completed" && run.status !== "failed" && run.status !== "aborted" && run.status !== "moved";
    for (const t of run.tasks) {
      // a task the run never started, in a run that's over, isn't a subagent anyone met
      if (!live && t.status === "pending") continue;
      out.push({
        id: `o:${run.id}:${t.id}`,
        name: run.race ? `${t.agent}'s take` : t.title,
        agentId: t.agent,
        kind: t.kind,
        status: taskStatus(t.status),
        chat: t.chat,
        source: run.race ? "race" : "orchestra",
        goal: run.goal,
        goalId: run.id,
        at: Math.max(t.finishedAt ?? 0, t.startedAt ?? 0, lastActivity.get(t.chat) ?? 0, run.createdAt),
        ...(t.costUsd ? { costUsd: t.costUsd } : {}),
        ...(t.error ? { note: t.error.slice(0, 160) } : t.result ? { note: oneLine(t.result) } : {}),
      });
    }
  }
  for (const crew of crews) {
    const goal = crew.state.goal;
    if (!goal) continue;
    const running = goal.status === "running" || goal.status === "planning" || goal.status === "awaiting_approval" || goal.status === "waiting_human";
    for (const tm of crew.teammates) {
      const chat = crew.state.threads[tm.id];
      const onIt = running && goal.current?.teammate === tm.id;
      const asked = running && goal.question?.teammate === tm.id;
      const card = onIt && goal.current?.card ? goal.cards.find((c) => c.id === goal.current!.card) : undefined;
      // a teammate that never spoke on a finished goal had no part in it
      if (!running && !(chat && lastActivity.has(chat))) continue;
      out.push({
        id: `c:${crew.id}:${tm.id}`,
        name: `${crew.name} · ${tm.id}`,
        agentId: tm.agent,
        kind: opts.kindOf?.(tm.agent) ?? tm.agent,
        status: asked ? "asks" : onIt ? "running" : running ? "pending" : goal.status === "failed" ? "failed" : goal.status === "stopped" || goal.status === "interrupted" ? "cancelled" : "done",
        ...(chat ? { chat } : {}),
        source: "crew",
        goal: goal.text,
        goalId: goal.id,
        at: Math.max((chat && lastActivity.get(chat)) || 0, goal.startedAt),
        ...(asked ? { note: goal.question!.text.slice(0, 160) } : card ? { note: `${goal.current!.step} · ${card.title}`.slice(0, 160) } : {}),
      });
    }
  }
  const newest = (a: Subagent, b: Subagent) => b.at - a.at;
  return {
    active: out.filter((s) => ACTIVE.has(s.status)).sort(newest),
    done: out.filter((s) => !ACTIVE.has(s.status)).sort(newest).slice(0, 60),
  };
}
