import type { Express, Request } from "express";
import { readAliases, saveAlias } from "../../core/aliases.js";
import { starterTemplates } from "../../core/starter-templates.js";
import { validateConfigFile } from "../../core/config-validation.js";
import { findProject } from "../../core/registry.js";

export function registerCliSettingsRoutes(app: Express): void {
  app.get("/api/templates", (_req, res) => res.json({ templates: starterTemplates() }));
  app.get("/api/projects/:id/config/validate", (req, res) => {
    const project = findProject(String(req.params.id));
    if (!project) return void res.status(404).json({ error: "no such project" });
    res.json(validateConfigFile(project.dir));
  });
  app.use("/api/aliases", (req, res, next) => {
    const r = req as Request & { projectScope?: string[] | null; guest?: unknown };
    if (r.projectScope || r.guest) return void res.status(403).json({ error: "aliases require an owner or unscoped device" });
    next();
  });
  app.get("/api/aliases", (_req, res) => {
    try { res.json({ aliases: readAliases() }); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.put("/api/aliases", (req, res) => {
    try {
      if (!Array.isArray(req.body?.args)) throw new Error("args must be an array of command arguments");
      res.json({ aliases: saveAlias(req.body?.name, req.body.args) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.delete("/api/aliases", (req, res) => {
    try { res.json({ aliases: saveAlias(req.body?.name) }); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
}
