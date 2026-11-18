import type { Express, Request } from 'express';
import { clearRecent, deletePrompt, listPrompts, savePrompt, updatePrompt } from "../../core/prompts.js";
import { bearerToken } from "../auth.js";
import type { RouteContext } from './context.js';
/** Register prompts routes in the order established by LoomDaemon.routes(). */
export function registerPromptsRoutes(app: Express, ctx: Pick<RouteContext, "auth" | "runtimes" | "approvals">): void {

  // ---- fleet: what every agent in every open project is doing ----------
  app.get("/api/activity", (req, res) => {
    const scope = ctx.auth.allowedProjects(bearerToken(req.headers.authorization) ?? "");
    const projects = [...ctx.runtimes.values()]
      .filter((rt) => !scope || scope.includes(rt.info.id))
      .map((rt) => rt.activity());
    const pending = [...ctx.approvals.values()].filter((a) => !scope || scope.includes(a.projectId)).length;
    res.json({ projects, approvals: pending, at: Date.now() });
  });

  // ---- prompt manager (core/prompts.ts) --------------------------------
  // Both shelves are machine-wide, and Recent holds the full text of prompts
  // sent in every project: a token limited to some projects reaches neither.
  app.use("/api/prompts", (req, res, next) => {
    if (!(req as Request & { projectScope?: string[] | null }).projectScope) return void next();
    res.status(403).json({ error: "the prompt library needs an owner or unscoped token" });
  });
  app.get("/api/prompts", (req, res) => {
    res.json(listPrompts(String(req.query.q ?? "")));
  });

  app.post("/api/prompts", (req, res) => {
    try {
      res.json({ prompt: savePrompt((req.body ?? {}) as { title?: string; text: string; pinned?: boolean }) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/prompts/recent", (_req, res) => {
    clearRecent();
    res.json({ ok: true });
  });

  app.patch("/api/prompts/:promptId", (req, res) => {
    try {
      res.json({ prompt: updatePrompt(String(req.params.promptId), (req.body ?? {}) as never) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/prompts/:promptId", (req, res) => {
    if (!deletePrompt(String(req.params.promptId))) return void res.status(404).json({ error: "no such prompt" });
    res.json({ ok: true });
  });
}
