import type { LoomEvent } from "../../types.js";
export interface NowRow { projectId: string; project: string; chat: string; kind: "running" | "needs-you" | "approval"; title: string; id: string; expiresAt?: number; held?: boolean }
/** A reply in another chat must not clear this chat's question. */
export function waitingQuestions(events: LoomEvent[]): LoomEvent[] {
  const pending = new Map<string, LoomEvent>();
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    const chat = e.chat ?? "main";
    if (e.kind === "needs_input") pending.set(chat, e);
    if (e.kind === "message" && !e.agentId) pending.delete(chat);
    if (e.kind === "status" && e.payload.state === "question_answered" && typeof e.payload.requestId === "string" && pending.get(chat)?.payload.requestId === e.payload.requestId) pending.delete(chat);
  }
  return [...pending.values()];
}
export function briefTotals(events: LoomEvent[], start: number, end: number) {
  const yesterday = events.filter(e => e.ts >= start && e.ts < end);
  return { finishedTurns: yesterday.filter(e => e.kind === "run_complete" && !e.payload.error).length,
    spend: yesterday.filter(e => e.kind === "status" && e.payload.state === "turn_cost").reduce((sum, e) => sum + (Number(e.payload.costUsd) || 0), 0) };
}

/** Goal workers are not roster agents, so their waiting and running turns need their own rows. */
export function goalRows(projectId: string, project: string,
  runs: Array<{ id: string; goal: string; status: string; chat: string; question?: string; tasks: Array<{ id: string; title: string; status: string; chat?: string }> }>,
  crews: Array<{ id: string; name: string; state: { channel: string; threads: Record<string, string>; goal?: { status: string; text: string; pauseReason?: string; question?: { text: string }; current?: { teammate: string } } } }>): NowRow[] {
  const rows: NowRow[] = [], base = { projectId, project };
  for (const run of runs) {
    if (["completed", "failed", "aborted", "moved"].includes(run.status)) continue;
    if (run.status === "waiting_human") rows.push({ ...base, id: `orchestra:${run.id}`, chat: run.chat, kind: "needs-you", title: run.question ?? run.goal });
    for (const task of run.tasks) if (["running", "needs_input", "conflict"].includes(task.status)) rows.push({ ...base, id: `task:${run.id}:${task.id}`, chat: task.chat ?? run.chat, kind: task.status === "running" ? "running" : "needs-you", title: task.title });
  }
  for (const crew of crews) {
    const g = crew.state.goal; if (!g) continue;
    if (["awaiting_approval", "waiting_human", "paused", "interrupted"].includes(g.status)) rows.push({ ...base, id: `crew:${crew.id}`, chat: crew.state.channel, kind: g.status === "awaiting_approval" ? "approval" : "needs-you", title: `${crew.name}: ${g.question?.text ?? g.pauseReason ?? g.text}` });
    if (g.current && ["planning", "running"].includes(g.status)) rows.push({ ...base, id: `crew-turn:${crew.id}`, chat: crew.state.threads[g.current.teammate] ?? crew.state.channel, kind: "running", title: `${crew.name}: ${g.current.teammate}` });
  }
  return rows;
}
