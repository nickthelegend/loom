import type { DaemonClient } from "../../daemon/client.js";
import { turnOutcome, exitCodeFor } from "../turn-wait.js";

export async function waitForTarget(client: DaemonClient, project: string, target: string, timeoutMs = 300_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");
  const end = Date.now() + timeoutMs, base = `/api/projects/${encodeURIComponent(project)}`;
  let kind = "unknown";
  const timedOut = () => ({ target, kind, status: "timeout", timedOut: true, exitCode: 124 });
  const read = <T>(suffix: string) => client.api<T>("GET", base + suffix, undefined, Math.max(1, Math.min(30_000, end - Date.now())));
  try {
    const [{ chats }, { runs }] = await Promise.all([
      read<Awaited<ReturnType<DaemonClient["chats"]>>>("/chats"), read<Awaited<ReturnType<DaemonClient["orchestraRuns"]>>>("/orchestra"),
    ]);
    const chat = chats.find(c => c.id === target || c.title === target), run = runs.find(r => r.id === target);
    if (!chat && !run) throw new Error(`no chat or run ${target}`);
    kind = run ? "run" : "chat";
    do {
      if (run) {
        const { run: current } = await read<Awaited<ReturnType<DaemonClient["orchestraRun"]>>>(`/orchestra/${encodeURIComponent(run.id)}`);
        if (["completed", "failed", "aborted", "moved", "waiting_human"].includes(current.status))
          return { target: run.id, kind, status: current.status, exitCode: current.status === "completed" ? 0 : current.status === "waiting_human" ? 2 : 1, timedOut: false };
      } else {
        const [{ project: status }, { events }, queue] = await Promise.all([
          read<Awaited<ReturnType<DaemonClient["project"]>>>(""),
          read<Awaited<ReturnType<DaemonClient["chatEvents"]>>>(`/events?chat=${encodeURIComponent(chat!.id)}&limit=1000`),
          read<Awaited<ReturnType<DaemonClient["queue"]>>>("/queue"),
        ]);
        const busy = status.agents.some(a => a.busy && (a.chat ?? "main") === chat!.id);
        const start = events.filter(e => e.kind === "status" && e.payload.state === "turn_started").at(-1);
        const question = events.filter(e => e.id > (start?.id ?? 0) && e.kind === "needs_input").at(-1);
        const answered = question && events.some(e => e.id > question.id &&
          ((e.kind === "status" && e.payload.state === "question_answered") || (e.kind === "message" && !e.agentId)));
        const outcome = start?.agentId ? turnOutcome(events, start.agentId, answered ? question.id : start.id, chat!.id) : null;
        if (outcome?.status === "needs_input") return { target: chat!.id, kind, ...outcome, exitCode: 2, timedOut: false };
        const queued = queue.queue.some(item => (item.chat ?? "main") === chat!.id);
        if (!busy && !queued) {
          const interrupted = events.some(e => e.id > (start?.id ?? 0) && e.kind === "status" && e.payload.state === "interrupted");
          if (interrupted) return { target: chat!.id, kind, status: "aborted", exitCode: 1, timedOut: false };
          return { target: chat!.id, kind, status: outcome?.status ?? "idle", ...(outcome ?? {}), exitCode: outcome ? exitCodeFor(outcome) : 0, timedOut: false };
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, end - Date.now()))));
    } while (Date.now() < end);
    return timedOut();
  } catch (error) {
    if (Date.now() >= end) return timedOut();
    throw error;
  }
}

// Runtime status already includes the active chat; expose that additive field to clients.
declare module "../../types.js" { interface AgentStatus { chat?: string } }
