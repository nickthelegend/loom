import { owner } from "./orchestra.js";
import type { Express } from "express";
import type { WithRuntime } from "./context.js";
import { compareRuns, runReport } from "../../core/orchestra-r4/model.js";

export function registerOrchestraR4Routes(app: Express, withRuntime: WithRuntime): void {
  const base = "/api/projects/:id/orchestra";
  app.get(`${base}/compare`, withRuntime(async (rt, req, res) => {
    const a = rt.orchestra.get(String(req.query.a)), b = rt.orchestra.get(String(req.query.b));
    if (!a || !b) return void res.status(404).json({ error: "no such run" });
    res.json(compareRuns(a, b));
  }));
  app.get(`${base}/:runId/report`, withRuntime(async (rt, req, res) => {
    const run = rt.orchestra.get(String(req.params.runId));
    if (!run) return void res.status(404).json({ error: "no such run" });
    res.json(runReport(run));
  }));
  for (const [suffix, action] of [
    ["tasks", "add"], ["hold", "hold"], ["release", "release"], ["say", "say"], ["plan", "plan"],
    ["approve", "approve"], ["rerun", "rerun"], ["tasks/:taskId/skip", "skip"],
    ["tasks/:taskId/extend", "extend"], ["tasks/:taskId/reassign", "reassign"],
  ]) {
    app.post(`${base}/:runId/${suffix}`, withRuntime(async (rt, req, res) => {
      if (["approve", "plan", "reassign", "extend"].includes(action!) && !owner(req, res)) return;
      if (!rt.orchestra.get(String(req.params.runId))) return void res.status(404).json({ error: "no such run" });
      try {
        res.json({ run: await rt.orchestra.control(String(req.params.runId), action!, { ...req.body, ...(req.params.taskId ? { task: String(req.params.taskId) } : {}) }) });
      } catch (error) { res.status(400).json({ error: (error as Error).message }); }
    }));
  }
}
