import type { Express, Request } from 'express';
import type { WithRuntime } from './context.js';
/** Register config routes in the order established by LoomDaemon.routes(). */
export function registerConfigRoutes(app: Express, withRuntime: WithRuntime): void {

  // loomTools is a boolean, default false; PATCH applies it to subsequent agent turns.
  // The Settings screen reads its editable knobs here — brain extractor,
  // projection mode, default agent — with the roster the picker chooses from.
  app.get(
    "/api/projects/:id/config",
    withRuntime(async (rt, _req, res) => {
      res.json(rt.settings());
    }),
  );

  // The Settings screen's editable knobs: the brain extractor, the projection
  // mode, the default agent. Everything is read live from config, so a merge
  // here lands on the next turn/handoff with no restart. Partial — send only
  // what changed. Returns the full config so the screen can re-render.
  app.patch(
    "/api/projects/:id/config",
    withRuntime(async (rt, req, res) => {
      if (req.body?.defaultEffort !== undefined && (req as Request & { projectScope?: string[] | null }).projectScope) return void res.status(403).json({ error: "project effort requires an unscoped session" });
      const body = (req.body ?? {}) as Parameters<typeof rt.patchConfig>[0];
      try {
        const cfg = rt.patchConfig({
          defaultEffort: body.defaultEffort,
          loomTools: body.loomTools,
          brain: body.brain,
          projection: body.projection,
          defaultAgent: body.defaultAgent,
          git: body.git,
          safety: body.safety,
        });
        res.json({
          defaultEffort: cfg.defaultEffort ?? "",
          loomTools: Boolean(cfg.loomTools),
          brain: cfg.brain ?? {},
          projection: cfg.projection ?? {},
          defaultAgent: cfg.defaultAgent ?? "",
          git: cfg.git ?? {},
          safety: cfg.safety ?? {},
        });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
}
