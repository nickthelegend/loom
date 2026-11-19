import type { Command } from "commander";
import { ensureDaemon, type DaemonClient } from "../daemon/client.js";
import { resolveCurrentProject } from "./common.js";
import { readDaemonConfig } from "../core/registry.js";
import { hoursCsv, type agentHours } from "../observability/r4/analytics.js";

export async function insightsRequest(client: DaemonClient, project: string, route: string, method = "GET", body?: unknown): Promise<Record<string, any>> {
  const config = readDaemonConfig();
  if (!config) throw new Error("daemon is not configured");
  const response = await fetch(`${client.baseUrl}/api/projects/${encodeURIComponent(project)}${route}`, {
    method, headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(String(result.error ?? response.status));
  return result;
}
export function formatInsight(name: string, result: Record<string, any>): string {
  const d = result[name];
  if (name === "compare") return Object.keys(d.current).map(k => `${k}: ${d.current[k].toFixed(2)} ${d.changes[k].direction === "up" ? "↑" : d.changes[k].direction === "down" ? "↓" : "→"} (previous ${d.previous[k].toFixed(2)})`).join("\n");
  if (name === "tools") {
    const line = (r: any) => `${r.name}: ${r.calls} calls · ${r.failureRate === null ? "outcomes unknown" : r.failureRate.toFixed(1) + "% failed"} · ${r.averageMs === null ? "duration unmeasured" : r.averageMs.toFixed(1) + "ms average"}`;
    return ["Per tool", ...d.byTool.map(line), "Per agent", ...d.byAgent.map(line)].join("\n");
  }
  const measured = (value: number | null) => value === null ? "unmeasured" : value.toFixed(1);
  const empty = "Nothing recorded yet.";
  if (name === "latency") {
    const line = (r: any) => `${r.name}: first output p50/p95 ${measured(r.firstOutputMs.p50)}/${measured(r.firstOutputMs.p95)} ms · turn p50/p95 ${measured(r.durationMs.p50)}/${measured(r.durationMs.p95)} ms (${r.durationMs.samples} samples; ${r.firstOutputMs.samples} first-output samples)`;
    return d.byAgent.length || d.byModel.length ? ["Per agent", ...d.byAgent.map(line), "Per model", ...d.byModel.map(line)].join("\n") : empty;
  }
  if (name === "approvals") return d.commands.length ? [
    `Answered wait p50/p95 ${measured(d.waitMs.p50)}/${measured(d.waitMs.p95)} ms (${d.waitMs.samples} samples)`,
    ...d.commands.map((r: any) => `${r.count} × ${r.command} (${r.tool}) · ${measured(r.totalWaitMs)} ms total wait`),
  ].join("\n") : empty;
  if (name === "errors") return d.map((r: any) => `${r.count} × ${r.error} · last seen ${new Date(r.lastSeen).toISOString()}${r.examples.map((e: any) => `\n  ${e.href}`).join("")}`).join("\n") || empty;
  if (name === "files") return [d.rows.map((r: any) => `${r.path}: ${r.edits} edits · ${r.reEdits} re-edits · ${r.rewinds} rewinds`).join("\n") || empty,
    ...(d.unavailableRewinds ? [`${d.unavailableRewinds} older rewinds no longer have checkpoint trees.`] : []),
  ].join("\n");
  if (name === "hours") return d.entries.map((r: any) => `${r.day} UTC · ${r.project} · ${r.agent}: ${(r.activeMs / 3_600_000).toFixed(2)}h`).join("\n") || "No measured working time yet.";
  return JSON.stringify(d ?? result, null, 2);
}
export function registerR4Insights(program: Command): void {
  const run = async (route: string, method = "GET", body?: unknown) => { const client = await ensureDaemon(); const project = await resolveCurrentProject(client); return insightsRequest(client, project.id, route, method, body); };
  const insights = program.command("insights").description("project reliability, speed and working time");
  for (const name of ["tools", "latency", "approvals", "errors", "compare", "files", "hours"]) insights.command(name)
    .option("--json", "print JSON").option("--period <duration>", "comparison window", "7d").option("--agent <agent>", "filter by agent")
    .option("--since <when>", "ISO date, epoch milliseconds or lookback such as 7d").option("--csv", "export agent hours as CSV")
    .action(async opts => {
      if (opts.csv && name !== "hours") throw new Error("--csv is only supported for hours");
      const query = new URLSearchParams({ period: opts.period }); if (opts.agent) query.set("agent", opts.agent); if (opts.since) query.set("since", opts.since);
      const result = await run(`/insights/${name}?${query}`);
      process.stdout.write((opts.csv ? hoursCsv(result.hours as ReturnType<typeof agentHours>) : opts.json ? JSON.stringify(result) : formatInsight(name, result)) + (opts.csv ? "" : "\n"));
    });
  program.command("events").description("query the project event log, newest first")
    .option("--type <type>", "event type (or comma-separated types)").option("--agent <agent>", "agent id").option("--since <when>", "ISO date or lookback")
    .option("--limit <count>", "maximum events, 1–500", "100").option("--before <id>", "page before event id").option("--json", "print one JSON object")
    .action(async opts => { const query = new URLSearchParams(); for (const k of ["type", "agent", "since", "limit", "before"]) if (opts[k]) query.set(k, opts[k]); const result = await run(`/events/query?${query}`); console.log(opts.json ? JSON.stringify(result) : result.events.map((e: any) => `${e.id} ${new Date(e.ts).toISOString()} ${e.kind} ${e.agentId ?? "—"} ${JSON.stringify(e.payload)}`).join("\n") || "No matching events."); });
  const alerts = program.command("alerts").description("project reliability and speed alerts");
  alerts.command("add <expression>").action(async expression => { console.log(JSON.stringify(await run("/alerts", "POST", { expression }), null, 2)); });
  alerts.command("list").action(async () => { console.log(JSON.stringify(await run("/alerts"), null, 2)); });
  for (const action of ["pause", "resume", "test", "remove"]) alerts.command(`${action} <id>`).action(async id => {
    console.log(JSON.stringify(await run(`/alerts/${encodeURIComponent(id)}${action === "test" ? "/test" : ""}`, action === "test" ? "POST" : action === "remove" ? "DELETE" : "PATCH", action === "pause" || action === "resume" ? { paused: action === "pause" } : undefined), null, 2));
  });
}
