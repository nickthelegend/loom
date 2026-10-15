import type { Express } from 'express';
import type { WithRuntime } from './context.js';

/** Register Night Shift routes (daemon/shift.ts) in the order established by LoomDaemon.routes(). */
export function registerShiftRoutes(app: Express, withRuntime: WithRuntime): void {
  // What's running (each task's state so far) and the last morning report.
  app.get("/api/projects/:id/shift", withRuntime(async (rt, _req, res) => void res.json(rt.shifts.status())));

  // Start one: { tasks: "one per line" | string[], to?, until?: "7:00" | ISO | ms, maxUsd? }
  app.post(
    "/api/projects/:id/shift",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { tasks?: unknown; to?: unknown; until?: unknown; maxUsd?: unknown };
      const tasks = Array.isArray(b.tasks) ? b.tasks.map(String) : typeof b.tasks === "string" ? b.tasks : "";
      try {
        const shift = rt.shifts.start({
          tasks,
          ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
          ...(typeof b.until === "string" || typeof b.until === "number" ? { until: b.until } : {}),
          ...(b.maxUsd !== undefined && b.maxUsd !== null && b.maxUsd !== "" ? { maxUsd: Number(b.maxUsd) } : {}),
        });
        res.json({ shift });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // Stop starting new tasks; the running one finishes, then the report goes out.
  app.delete(
    "/api/projects/:id/shift",
    withRuntime(async (rt, _req, res) => {
      const shift = rt.shifts.stop();
      if (!shift) return void res.status(404).json({ error: "no night shift is running" });
      res.json({ shift });
    }),
  );
}
