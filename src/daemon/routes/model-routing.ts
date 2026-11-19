import { canUseSaver } from "../../core/cost-r4/turns.js";
import { budgetSnapshot } from "../../core/cost-r4/budgets.js";
import { costSettings } from "../../core/cost-r4/settings.js";
import type { Express, Request } from "express";
import { configuredModels, modelHealth, modelUsage, promptEstimate, savedModelHealth, readModelRouting, writeModelRouting } from "../../core/model-routing.js";
import type { WithRuntime } from "./context.js";

export function registerModelRoutingRoutes(app: Express, withRuntime: WithRuntime): void {
  app.use("/api/model-routing", (req, res, next) => {
    // The owner: the admin or one of their own unscoped devices (the phone's Model settings sheet).
    const auth = req as Request & { isAdmin?: boolean; projectScope?: string[] | null; guest?: unknown };
    if (auth.guest || auth.projectScope) return void res.status(403).json({ error: "model routing requires this machine's owner" });
    next();
  });
  app.get("/api/model-routing", async (_req, res) => {
    res.json({ ...readModelRouting(), health: savedModelHealth(), usage: await Promise.all(configuredModels().map(m => modelUsage(m))) });
  });
  app.put("/api/model-routing", (req, res) => {
    try { res.json(writeModelRouting(req.body)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  app.post("/api/model-routing/health", async (_req, res) => { res.json({ health: await modelHealth() }); });
  app.use(["/api/projects/:id/estimate", "/api/projects/:id/agents/:agentId/options"], (req, res, next) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) return void res.status(403).json({ error: "model settings require an unscoped session" });
    next();
  });
  app.post("/api/projects/:id/estimate", withRuntime(async (rt, req, res) => {
    const { text, agentId, chat, model } = req.body ?? {};
    if (typeof text !== "string" || text.length > 1_000_000 || (model !== undefined && typeof model !== "string")) return void res.status(400).json({ error: "expected text and optional model" });
    const bound = rt.chatBinding(chat);
    const id = agentId ?? bound.agentId ?? rt.baton.holder() ?? rt.config.defaultAgent ?? rt.config.agents[0]?.id;
    const agent = rt.config.agents.find(a => a.id === id);
    if (!agent) return void res.status(404).json({ error: "unknown agent" });
    const explicit = model || (bound.agentId === id ? bound.model : undefined) || String(agent.options?.model ?? "");
    const candidate = !explicit && costSettings(rt.info.dir).saver ? budgetSnapshot(rt).saver : null;
    const saver = candidate?.active && await canUseSaver(agent, candidate.model) ? candidate : null;
    const selected = explicit || (saver?.active ? saver.model : "");
    const estimate = promptEstimate(selected, text, rt.sessionWeight(id, chat)?.tokens ?? 0, Number(agent.options?.maxTokens ?? 1024));
    res.json({ ...estimate, ...(saver?.active ? { saver: { alias: saver.alias, model: saver.model } } : {}), usage: selected ? await modelUsage(selected) : null });
  }));
  app.get("/api/projects/:id/agents/:agentId/options", withRuntime(async (rt, req, res) => {
    const agent = rt.config.agents.find(a => a.id === req.params.agentId);
    if (!agent) return void res.status(404).json({ error: "unknown agent" });
    // Environment values and account paths are not part of this editor.
    const { extraArgs, fallbacks, effort } = agent.options ?? {};
    res.json({ extraArgs: extraArgs ?? [], fallbacks: fallbacks ?? [], effort: effort ?? "" });
  }));
  app.put("/api/projects/:id/agents/:agentId/options", withRuntime(async (rt, req, res) => {
    try { res.json(rt.setAgentOptions(String(req.params.agentId), req.body)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  }));
}
