import type { DaemonClient } from "../daemon/client.js";
import type { OrchestraRun } from "../core/orchestra.js";

export function orchestraLines(runs: OrchestraRun[]): string[] {
  if (!runs.length) return ["  Orchestra", "", "  No runs yet."];
  return ["  Orchestra · /retry-task <run> <task> <agent>", "", ...runs.flatMap(r => [
    `  ${r.id} · ${r.status} · ${r.goal}`,
    ...r.tasks.map(t => `    ${t.id} · ${t.status} · ${t.agent ?? "unassigned"} · ${t.title}`), "",
  ])];
}
export interface ApprovalRow { id: string; agent: string; tool: string; input: unknown; chat?: string }
export function approvalLines(approvals: ApprovalRow[]): string[] {
  return ["  Approvals · /allow <id> or /deny <id>", "", ...(approvals.length ? approvals.flatMap(a => [
    `  ${a.id} · ${a.agent} · ${a.tool} · ${a.chat ?? "main"}`, `    ${JSON.stringify(a.input)}`,
  ]) : ["  No pending approvals."])];
}
export async function loadAgenticView(client: DaemonClient, project: string, view: "orchestra" | "approvals") {
  if (view === "approvals") return approvalLines((await client.api<{ approvals: ApprovalRow[] }>("GET", `/api/projects/${encodeURIComponent(project)}/approvals`)).approvals);
  const { runs } = await client.orchestraRuns(project);
  return orchestraLines(await Promise.all(runs.map(r => client.orchestraRun(project, r.id).then(x => x.run))));
}
export async function agenticAction(client: DaemonClient, project: string, command: string, args: string[]) {
  if (command === "retry-task") {
    if (args.length !== 3) throw new Error("usage: /retry-task <run> <task> <agent>");
    await client.retryOrchestraTask(project, args[0]!, args[1]!, args[2]!);
    return "Task retried";
  }
  if (args.length !== 1) throw new Error(`usage: /${command} <approval id>`);
  await client.api("POST", `/api/projects/${encodeURIComponent(project)}/approvals/${encodeURIComponent(args[0]!)}`, { decision: command === "allow" ? "allow" : "deny" });
  return command === "allow" ? "Approval allowed" : "Approval denied";
}
