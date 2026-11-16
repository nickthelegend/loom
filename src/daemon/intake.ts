import { assignedIssues, intakePrompt, publicIntake, readIntake, saveIntake, type IntakeIssue, type IntakeMode, type IntakeSource } from "../core/intake.js";
import type { ProjectRuntime } from "./runtime.js";

const starting = new Map<string, Promise<unknown>>();

export async function listIntake(rt: ProjectRuntime, source: IntakeSource, label?: string): Promise<IntakeIssue[]> {
  const issues = await assignedIssues(rt.info.dir, source, label);
  const rows = readIntake(rt.info.dir);
  return issues.map(issue => publicIntake({ ...issue, started: rows.find(r => r.source === source && r.id === issue.id)?.started }));
}

/** API and schedules share one lane per project, including the provider lookup. */
export function startIntake(rt: ProjectRuntime, source: IntakeSource, ids: string[] | undefined, mode: IntakeMode, agent?: string, label?: string): Promise<IntakeIssue[]> {
  const prior = starting.get(rt.info.dir) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const agentId = agent ?? rt.baton.holder() ?? rt.config.agents.find(a => a.enabled !== false)?.id;
    if (!agentId || !rt.config.agents.some(a => a.id === agentId && a.enabled !== false)) throw new Error("no enabled agent with that id in this project");
    const existing = readIntake(rt.info.dir);
    const wanted = ids ? [...new Set(ids)] : undefined;
    // An idempotent retry must still work after the issue is closed or unassigned.
    const need = !wanted || wanted.some(id => !existing.some(r => r.source === source && r.id === id && !r.pending));
    const fetched = need ? await assignedIssues(rt.info.dir, source, label) : [];
    const selected = wanted ?? fetched.map(i => i.id);
    for (const id of selected) {
      if (!existing.some(r => r.source === source && r.id === id && !r.pending) && !fetched.some(i => i.id === id)) throw new Error(`issue is no longer open and assigned to you: ${id}`);
    }
    const out: IntakeIssue[] = [];
    for (const id of selected) {
      let row = readIntake(rt.info.dir).find(r => r.source === source && r.id === id);
      if (row && !row.pending) { out.push(publicIntake(row)); continue; }
      const issue = fetched.find(i => i.id === id)!;
      const input = { text: intakePrompt(issue), source: "user" as const, target: mode === "orchestra"
        ? { kind: "orchestra" as const, orchestrator: agentId }
        : { kind: "agent" as const, agentId } };
      if (!row) {
        rt.queue.assertCanAdd(input);
        const title = `${issue.number ? `#${issue.number}` : issue.identifier} ${issue.title}`;
        const chat = rt.createChat(title, agent ? { agentId: agent } : {}).id;
        row = { ...publicIntake(issue), started: { chat }, pending: true, prs: [] };
        saveIntake(rt.info.dir, row);
      }
      const chat = row.started.chat;
      const alreadySent = rt.queue.snapshot().items.some(i => i.chat === chat) || rt.log.list({ chat, kinds: ["message"], limit: 1 }).length > 0 || rt.orchestra.list().some(r => r.chat === chat);
      if (!alreadySent) rt.enqueue({ ...input, chat });
      saveIntake(rt.info.dir, { ...row, pending: false });
      out.push(publicIntake(row));
    }
    return out;
  });
  starting.set(rt.info.dir, next);
  void next.finally(() => { if (starting.get(rt.info.dir) === next) starting.delete(rt.info.dir); }).catch(() => {});
  return next;
}
