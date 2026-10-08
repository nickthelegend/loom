import type { Express } from 'express';
import express from "express";
import { CREW_TEMPLATES, type CrewTeammate } from "../../core/crew.js";
import type { WithRuntime } from './context.js';
/** Register crew routes (Agent Teams, core/crew.ts) in the order established by LoomDaemon.routes(). */
export function registerCrewsRoutes(app: Express, withRuntime: WithRuntime): void {

  // ---- crews: agents with roles working a goal together ------------------
  // Every step is also a `crew` event in the crew's channel, so clients
  // render live from events and use these for actions.
  const crewError = (res: express.Response, err: unknown) =>
    void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

  app.get(
    "/api/projects/:id/crews",
    withRuntime(async (rt, _req, res) => {
      res.json({ crews: rt.crews.list(), templates: CREW_TEMPLATES });
    }),
  );

  app.post(
    "/api/projects/:id/crews",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { name?: string; template?: string; teammates?: CrewTeammate[]; planApproval?: boolean; testCommand?: string };
      try {
        res.json({ crew: rt.crews.create({
          ...(b.name ? { name: String(b.name) } : {}),
          ...(b.template ? { template: String(b.template) } : {}),
          ...(Array.isArray(b.teammates) ? { teammates: b.teammates } : {}),
          ...(typeof b.planApproval === "boolean" ? { planApproval: b.planApproval } : {}),
          ...(b.testCommand ? { testCommand: String(b.testCommand) } : {}),
        }) });
      } catch (err) {
        crewError(res, err);
      }
    }),
  );

  app.get(
    "/api/projects/:id/crews/:crew",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ crew: rt.crews.get(String(req.params.crew)) });
      } catch (err) {
        res.status(404).json({ error: (err as Error).message });
      }
    }),
  );

  app.patch(
    "/api/projects/:id/crews/:crew",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { name?: string; teammates?: CrewTeammate[]; planApproval?: boolean; testCommand?: string | null };
      try {
        res.json({ crew: rt.crews.update(String(req.params.crew), b) });
      } catch (err) {
        crewError(res, err);
      }
    }),
  );

  app.delete(
    "/api/projects/:id/crews/:crew",
    withRuntime(async (rt, req, res) => {
      try {
        await rt.crews.remove(String(req.params.crew));
        res.json({ ok: true });
      } catch (err) {
        crewError(res, err);
      }
    }),
  );

  app.get(
    "/api/projects/:id/crews/:crew/diff",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ diff: await rt.crews.goalDiff(String(req.params.crew)) });
      } catch (err) {
        crewError(res, err);
      }
    }),
  );

  // goal | say | approve | stop | resume | apply
  app.post(
    "/api/projects/:id/crews/:crew/:action",
    withRuntime(async (rt, req, res) => {
      const id = String(req.params.crew);
      const b = (req.body ?? {}) as { text?: string; to?: string };
      try {
        const action = String(req.params.action);
        let out: unknown;
        if (action === "goal") out = { goal: await rt.crews.goal(id, String(b.text ?? "")) };
        else if (action === "say") out = await rt.crews.say(id, String(b.text ?? ""), b.to ? String(b.to) : undefined);
        else if (action === "approve") out = { goal: rt.crews.approve(id) };
        else if (action === "stop") out = { goal: await rt.crews.stop(id) };
        else if (action === "resume") out = { goal: rt.crews.resume(id) };
        else if (action === "apply") out = await rt.crews.apply(id);
        else return void res.status(404).json({ error: `unknown crew action "${action}"` });
        res.json({ ...(out as object), crew: rt.crews.get(id) });
      } catch (err) {
        crewError(res, err);
      }
    }),
  );
}
