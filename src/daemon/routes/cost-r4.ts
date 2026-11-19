import type { Express, RequestHandler } from "express";
import type { WithRuntime } from "./context.js";
import { listProjects } from "../../core/registry.js";
import { priceBook } from "../../core/prices.js";
import { readScoreboard } from "../../core/scoreboard.js";
import { resolveModel } from "../../core/model-routing.js";
import { costSettings, priceOverrides, writePriceOverrides, updateCostSettings } from "../../core/cost-r4/settings.js";
import { costReport, costsCsv, exportCosts, sinceDate, whatIf } from "../../core/cost-r4/report.js";
import { budgetNotices, budgetSnapshot } from "../../core/cost-r4/budgets.js";
import { compareModels, suggestFleet } from "../../core/cost-r4/models.js";

export function registerCostRoutes(app: Express, withRuntime: WithRuntime): void {
  const projectRoute: WithRuntime = handler => withRuntime(async (rt, req, res) => {
    try { await handler(rt, req, res); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  const owner: RequestHandler = (req, res, next) => {
    const auth = req as typeof req & { guest?: unknown; projectScope?: string[] | null };
    if (auth.guest || auth.projectScope) return void res.status(403).json({ error: "requires this machine's owner" });
    next();
  };
  app.get("/api/prices", owner, (_req, res) => res.json({ overrides: priceOverrides(), prices: priceBook(), unit: "USD/M", pricesUnit: "USD/token" }));
  app.put("/api/prices", owner, (req, res) => {
    try { res.json({ overrides: writePriceOverrides(req.body?.overrides ?? req.body), unit: "USD/M" }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get("/api/models/compare", owner, async (req, res) => {
    try { const board = await readScoreboard(listProjects()); res.json({ models: compareModels(String(req.query.models ?? "").split(","), board.byModel) }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.post("/api/fleets/suggest", owner, async (req, res) => {
    try { const board = await readScoreboard(listProjects()); res.json(suggestFleet(req.body?.goal, board.byKindModel, { budget: req.body?.budget, size: req.body?.size })); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get("/api/projects/:id/costs/export", projectRoute(async (rt, req, res) => {
    const report = costReport(rt.log.list({ allBranches: true }), sinceDate(req.query.since));
    const result = exportCosts(report, String(req.query.by ?? "agent"));
    const format = req.query.format ?? "json";
    if (!["json", "csv", "csv-json"].includes(String(format))) { res.status(400).json({ error: "format must be json or csv" }); return; }
    if (format === "csv") { res.type("text/csv").attachment("loom-costs.csv").send(costsCsv(result)); return; }
    res.json(format === "csv-json" ? { csv: costsCsv(result) } : result);
  }));
  app.get("/api/projects/:id/costs/whatif", projectRoute(async (rt, req, res) => {
    if (typeof req.query.model !== "string" || !req.query.model.trim()) { res.status(400).json({ error: "model is required" }); return; }
    res.json(whatIf(rt.log.list({ allBranches: true }), resolveModel(req.query.model), { since: sinceDate(req.query.since), ...(req.query.chat ? { chat: String(req.query.chat) } : {}) }));
  }));
  app.get("/api/projects/:id/costs/settings", projectRoute(async (rt, _req, res) => { res.json(budgetSnapshot(rt)); }));
  app.put("/api/projects/:id/costs/settings", projectRoute(async (rt, req, res) => {
    const patch = req.body;
    if (patch?.chats && Object.keys(patch.chats).some(id => !rt.chats().some(c => c.id === id))) { res.status(400).json({ error: "unknown chat" }); return; }
    updateCostSettings(rt.info.dir, patch); budgetNotices(rt); res.json(budgetSnapshot(rt));
  }));
  app.put("/api/projects/:id/chats/:chat/budget", projectRoute(async (rt, req, res) => {
    const chat = String(req.params.chat);
    if (!rt.chats().some(c => c.id === chat)) { res.status(404).json({ error: "unknown chat" }); return; }
    const current = costSettings(rt.info.dir);
    updateCostSettings(rt.info.dir, { chats: { ...current.chats, [chat]: req.body?.usd } });
    budgetNotices(rt, chat);
    res.json(budgetSnapshot(rt));
  }));
}
