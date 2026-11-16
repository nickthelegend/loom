import type { Express, Request } from "express";
import { intakeMode, intakeSource } from "../../core/intake.js";
import { listIntake, startIntake } from "../intake.js";
import type { WithRuntime } from "./context.js";

// Assignment and provider credentials belong to the owner, not shared-chat guests.
const owner = (req: Request) => {
  const r = req as Request & { isAdmin?: boolean; guest?: unknown; projectScope?: string[] | null };
  return Boolean(r.isAdmin) || (!r.guest && !r.projectScope);
};

export function registerIntakeRoutes(app: Express, withRuntime: WithRuntime): void {
  /** GET ?source=github|linear&label=... -> { issues: IntakeIssue[] } (core/intake.ts). */
  app.get("/api/projects/:id/intake", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner or their own device can list assigned issues" });
    try {
      if (req.query.label !== undefined && typeof req.query.label !== "string") throw new Error("label must be a string");
      res.json({ issues: await listIntake(rt, intakeSource(req.query.source ?? "github"), req.query.label as string | undefined) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));

  /** POST { source, ids: string[], mode: "chat"|"orchestra", agent?: string }
   * -> { issues: IntakeIssue[] }. Work enters the persistent prompt queue. Orchestra
   * run IDs appear on subsequent GETs once dispatched; paused queues remain paused.
   * A partial failure returns 400; retrying the same IDs resumes without duplicates.
   */
  app.post("/api/projects/:id/intake/start", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner or their own device can start assigned issues" });
    try {
      const b = req.body ?? {};
      const source = intakeSource(b.source), mode = intakeMode(b.mode);
      if (!Array.isArray(b.ids) || b.ids.length > 1000 || b.ids.some((id: unknown) => typeof id !== "string" || !id || id.length > 2000)) throw new Error("ids must be an array of issue id strings (at most 1000)");
      if (b.agent !== undefined && (typeof b.agent !== "string" || !b.agent.trim())) throw new Error("agent must be an agent id");
      res.json({ issues: await startIntake(rt, source, b.ids, mode, b.agent) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));
}
