import type { Express } from 'express';
import type { WithRuntime } from './context.js';

/** Register Council routes (daemon/council.ts) in the order established by LoomDaemon.routes(). */
export function registerCouncilRoutes(app: Express, withRuntime: WithRuntime): void {
  // Start one: { goal, planner, reviewers: string[] | "a,b" }
  app.post(
    "/api/projects/:id/councils",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { goal?: unknown; planner?: unknown; reviewers?: unknown };
      const reviewers = Array.isArray(b.reviewers) ? b.reviewers.map(String) : typeof b.reviewers === "string" ? b.reviewers.split(",").map((r) => r.trim()).filter(Boolean) : [];
      try {
        res.json({ council: rt.councils.start({ goal: String(b.goal ?? ""), planner: String(b.planner ?? ""), reviewers }) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.get("/api/projects/:id/councils", withRuntime(async (rt, _req, res) => void res.json({ active: rt.councils.active, councils: rt.councils.recent() })));

  app.get(
    "/api/projects/:id/councils/:councilId",
    withRuntime(async (rt, req, res) => {
      const council = rt.councils.status(String(req.params.councilId));
      if (!council) return void res.status(404).json({ error: "no such council" });
      res.json({ council });
    }),
  );

  // Stop after the current stage (a turn in progress is interrupted).
  app.delete(
    "/api/projects/:id/councils",
    withRuntime(async (rt, _req, res) => {
      const council = await rt.councils.stop();
      if (!council) return void res.status(404).json({ error: "no council is running" });
      res.json({ council });
    }),
  );
}
