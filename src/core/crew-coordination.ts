/** Adapt crew state to the existing team lease/WIP coordinator. No transcript is shared. */
import type { CrewConfig, CrewState } from "./crew.js";
import type { AgentConfig } from "../types.js";
import type { OrchestraRun } from "./orchestra.js";

export const crewRunId = (crew: string, goal: string) => `crew-${crew}-${goal}`;
export function coordinationRun(cfg: CrewConfig, st: CrewState, roster: AgentConfig[]): OrchestraRun | undefined {
  const g = st.goal; if (!g) return undefined;
  const lead = cfg.teammates.find(t => t.role === "lead") ?? cfg.teammates[0]!;
  const kind = (agent: string) => roster.find(a => a.id === agent)?.kind ?? agent;
  return { id: crewRunId(cfg.id, g.id), goal: g.text, chat: st.channel,
    orchestrator: { agent: lead.agent, kind: kind(lead.agent) }, workers: cfg.teammates.map(t => t.agent),
    status: g.status === "stopped" ? "aborted" : g.status === "failed" ? "failed" : g.status === "completed" ? "completed"
      : g.status === "planning" ? "planning" : g.status === "running" ? "running" : "waiting_human",
    baseBranch: g.baseBranch, baseCommit: g.base, branch: g.branch, dir: g.dir,
    tasks: g.cards.map(c => {
      const seat = cfg.teammates.find(t => t.id === (c.builder ?? c.assignee)) ?? cfg.teammates.find(t => t.role === "builder") ?? lead;
      return { id: c.id, title: c.title, prompt: c.detail ?? c.title, agent: seat.agent, kind: kind(seat.agent),
        dependsOn: c.blockedBy, touches: c.touches, overlap: c.overlap, hold: c.teamHold,
        status: c.stage === "done" || c.stage === "ready" ? "done" : c.stage === "failed" ? "failed" : c.stage === "planned" ? "pending" : "running",
        chat: st.threads[seat.id] ?? st.channel, branch: c.workspace?.branch, dir: c.workspace?.dir ?? g.dir,
        attempts: c.rounds + 1, queued: [], result: c.summary, error: c.error };
    }), round: 0, maxRounds: cfg.maxRounds ?? 2, maxParallel: cfg.maxParallel ?? 3,
    summary: g.summary, error: g.error, question: g.question?.text, applied: g.applied,
    costUsd: g.costUsd, createdAt: g.startedAt, updatedAt: Date.now() };
}
