import fs from "node:fs";
import path from "node:path";
import type { Express, Request, RequestHandler } from "express";
import { BackupScheduler } from "../../core/backup-schedule.js";
import { LOG_MAX_BYTES, diskBytes, projectDiskUsage, prunePolicy } from "../../core/ops.js";
import { listProjects, loomHome, readProjectConfig, writeProjectConfig } from "../../core/registry.js";
import { EventLog } from "../../core/eventlog.js";
import { usageReport } from "../../core/usage.js";
import { PromptQueue } from "../../core/prompt-queue.js";
import { bearerToken } from "../auth.js";
import type { RouteContext, WithRuntime } from "./context.js";

const owner: RequestHandler = (req, res, next) => {
  if ((req as Request & { projectScope?: string[] | null }).projectScope) return void res.status(403).json({ error: "an unscoped owner token is required" });
  next();
};
const defaultPolicy = { days: 7, keep: 10000 };

export function registerOpsRoutes(app: Express, ctx: Pick<RouteContext, "auth" | "runtimes">, withRuntime: WithRuntime, backups: BackupScheduler): void {
  app.get("/metrics", async (req, res) => {
    if (!ctx.auth.isRootAdmin(bearerToken(req.headers.authorization))) return void res.status(403).send("admin token required\n");
    const rows: Array<{ id: string; turns: number; cost: number; errors: number; queue: number }> = [];
    for (const p of listProjects()) {
      const rt = ctx.runtimes.get(p.id);
      const log = rt?.log ?? await EventLog.open(path.join(p.dir, ".loom"));
      try {
        const totals = usageReport(log.list({ allBranches: true }), { prices: null }).totals;
        rows.push({ id: p.id, turns: totals.turns, cost: totals.usd, errors: totals.errors,
          queue: (rt?.queue ?? new PromptQueue(path.join(p.dir, ".loom", "queue.json"))).snapshot().items.length });
      } finally { if (!rt) log.close(); }
    }
    const fields = [
      ["loom_turns_total", "counter", "Completed agent turns", "turns"],
      ["loom_cost_usd_total", "counter", "Reported cost in USD", "cost"],
      ["loom_errors_total", "counter", "Agent error events", "errors"],
      ["loom_queue_depth", "gauge", "Pending prompts", "queue"],
    ] as const;
    const label = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
    res.type("text/plain; version=0.0.4; charset=utf-8").send(fields.map(([name, type, help, key]) =>
      `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n` + rows.map(r => `${name}{project="${label(r.id)}"} ${Number.isFinite(r[key]) ? Math.max(0, r[key]) : 0}\n`).join("")).join(""));
  });

  app.get("/api/ops", owner, (_req, res) => {
    const dir = path.join(loomHome(), "crashes");
    const crashes = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^crash-\d+-[\w-]+\.json$/.test(n)).sort().reverse() : [];
    res.json({ backup: backups.read(), log: { cap: LOG_MAX_BYTES, bytes: diskBytes(path.join(loomHome(), "daemon.log")), rotatedBytes: diskBytes(path.join(loomHome(), "daemon.log.1")) }, crashes });
  });
  app.get("/api/ops/crashes/:file", owner, (req, res) => {
    const name = String(req.params.file);
    if (!/^crash-\d+-[\w-]+\.json$/.test(name)) return void res.status(400).json({ error: "invalid crash report" });
    const file = path.join(loomHome(), "crashes", name);
    if (!fs.existsSync(file)) return void res.status(404).json({ error: "report not found" });
    res.type("application/json").send(fs.readFileSync(file, "utf8"));
  });
  app.put("/api/ops/backups", owner, (req, res) => {
    try { res.json({ backup: backups.configure(req.body?.every, req.body?.keep) }); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  app.delete("/api/ops/backups", owner, (_req, res) => { backups.disable(); res.json({ backup: null }); });
  app.get("/api/ops/du", owner, (_req, res) => res.json({ projects: listProjects().map(projectDiskUsage) }));

  app.get("/api/projects/:id/ops", withRuntime(async (rt, _req, res) => {
    const totals = usageReport(rt.log.list({ allBranches: true }), { prices: null }).totals;
    const metrics = { turns: totals.turns, costUsd: totals.usd, errors: totals.errors, queueDepth: rt.queue.snapshot().items.length };
    res.json({ metrics, disk: projectDiskUsage(rt.info), stale: rt.staleSessions(), policy: readProjectConfig(rt.info.dir)?.orchestra?.prune ?? defaultPolicy });
  }));
  app.get("/api/projects/:id/du", withRuntime(async (rt, _req, res) => { res.json(projectDiskUsage(rt.info)); }));
  app.post("/api/projects/:id/doctor/fix", withRuntime(async (rt, _req, res) => {
    const { fixProject, doctorReport, projectChecks } = await import("../../cli/doctor.js");
    const fixes = fixProject(rt.info.dir);
    res.json({ ...fixes, ...doctorReport(projectChecks(rt.info.dir)) });
  }));
  app.put("/api/projects/:id/worktrees/policy", withRuntime(async (rt, req, res) => {
    try {
      const policy = prunePolicy(req.body);
      const config = readProjectConfig(rt.info.dir)!;
      config.orchestra = { ...config.orchestra, prune: policy };
      writeProjectConfig(rt.info.dir, config);
      res.json({ policy });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  }));
  app.post("/api/projects/:id/worktrees/prune", withRuntime(async (rt, req, res) => {
    try {
      if (req.body?.dryRun !== undefined && typeof req.body.dryRun !== "boolean") throw new Error("dryRun must be a boolean");
      const policy = prunePolicy(req.body?.policy ?? readProjectConfig(rt.info.dir)?.orchestra?.prune ?? defaultPolicy);
      res.json(await rt.orchestra.pruneWorktrees(policy, req.body?.dryRun !== false));
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  }));
  app.post("/api/projects/:id/stale/:agentId/reap", withRuntime(async (rt, req, res) => {
    const id = String(req.params.agentId);
    if (!rt.staleSessions().some(s => s.agentId === id)) return void res.status(409).json({ error: "session is no longer stale; refresh the report" });
    res.json(await rt.reapSession(id));
  }));
}
