import type { Express } from 'express';
import express from "express";
import { recordRecent } from "../../core/prompts.js";
import { subagents } from "../../core/subagents.js";
import type { WithRuntime } from './context.js';
/** Register orchestra routes in the order established by LoomDaemon.routes(). */
export function registerOrchestraRoutes(app: Express, withRuntime: WithRuntime): void {

  // ---- orchestra: one orchestrator, many parallel workers ---------------
  // See core/orchestra.ts. Every step is also an `orchestra` event on the
  // WebSocket, so clients render live from events and use these for actions.
  const orchestraError = (res: express.Response, err: unknown) =>
    void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

  app.get(
    "/api/projects/:id/orchestra",
    withRuntime(async (rt, _req, res) => {
      res.json({ runs: rt.orchestra.list(), active: rt.orchestra.active()?.id ?? null });
    }),
  );

  // Every agent working for an orchestrator (Orchestra tasks, race entrants,
  // crew teammates), active first — the desktop's Subagents tab and the phone.
  app.get(
    "/api/projects/:id/subagents",
    withRuntime(async (rt, _req, res) => {
      const last = new Map<string, number>();
      for (const e of rt.log.list({ kinds: ["message", "tool_call", "run_complete", "needs_input"], limit: 4000 })) {
        if (e.chat && e.ts > (last.get(e.chat) ?? 0)) last.set(e.chat, e.ts);
      }
      const status = await rt.status();
      const kinds = new Map(status.agents.map((a) => [a.id, a.kind]));
      res.json(subagents(rt.orchestra.list(), rt.crews.list(), last, { kindOf: (id) => kinds.get(id) }));
    }),
  );

  app.post(
    "/api/projects/:id/orchestra",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as {
        goal?: string;
        orchestrator?: string;
        workers?: unknown;
        maxParallel?: number;
        maxRounds?: number;
        plan?: boolean;
        maxUsd?: number;
        /** The thread the goal was typed in; the orchestrator answers there. */
        chat?: string;
        /** Every worker gets the same prompt; you pick the best. */
        race?: boolean;
      };
      if (!b.goal?.trim()) return void res.status(400).json({ error: "missing goal" });
      const workers = Array.isArray(b.workers) ? b.workers.map(String).filter(Boolean) : undefined;
      try {
        const run = await rt.orchestra.start({
          goal: b.goal,
          ...(b.chat ? { chat: String(b.chat) } : {}),
          ...(b.orchestrator ? { orchestrator: String(b.orchestrator) } : {}),
          ...(workers?.length ? { workers } : {}),
          ...(b.maxParallel ? { maxParallel: Number(b.maxParallel) } : {}),
          ...(b.maxRounds ? { maxRounds: Number(b.maxRounds) } : {}),
          ...(b.plan ? { plan: true } : {}),
          ...(Number(b.maxUsd) > 0 ? { maxUsd: Number(b.maxUsd) } : {}),
          ...(b.race ? { race: true } : {}),
        });
        recordRecent(b.goal, { project: rt.info.name, mode: "orchestrate" });
        res.json({ run });
      } catch (err) {
        orchestraError(res, err);
      }
    }),
  );

  app.get(
    "/api/projects/:id/orchestra/:runId/tasks/:taskId/diff",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ patch: await rt.orchestra.taskDiff(String(req.params.runId), String(req.params.taskId)) });
      } catch (err) {
        orchestraError(res, err);
      }
    }),
  );
  app.get(
    "/api/projects/:id/orchestra/:runId",
    withRuntime(async (rt, req, res) => {
      const run = rt.orchestra.get(String(req.params.runId));
      if (!run) return void res.status(404).json({ error: "no such run" });
      res.json({ run });
    }),
  );

  // D32: the owner releases a task that waits on a teammate's goal.
  app.post(
    "/api/projects/:id/orchestra/:runId/tasks/:taskId/stop-waiting",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ task: rt.orchestra.stopWaiting(String(req.params.runId), String(req.params.taskId)) });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // Re-run the delivery policy by hand (e.g. after fixing a push rejection).
  app.post(
    "/api/projects/:id/orchestra/:runId/deliver",
    withRuntime(async (rt, req, res) => {
      const run = rt.orchestra.get(String(req.params.runId));
      if (!run) return void res.status(404).json({ error: "no such run" });
      const mode = String((req.body as { mode?: string } | undefined)?.mode ?? "");
      const modes = ["commit", "push", "pr"];
      if (mode && !modes.includes(mode)) return void res.status(400).json({ error: `mode must be ${modes.join(", ")}` });
      await rt.orchestra.deliver(run, (mode || undefined) as never);
      res.json({ run });
    }),
  );

  for (const action of ["abort", "reply", "apply", "cleanup", "resume"] as const) {
    app.post(
      `/api/projects/:id/orchestra/:runId/${action}`,
      withRuntime(async (rt, req, res) => {
        const runId = String(req.params.runId);
        try {
          if (action === "abort") res.json({ run: await rt.orchestra.abort(runId) });
          else if (action === "resume") res.json({ run: await rt.orchestra.resume(runId) });
          else if (action === "reply") {
            const text = String((req.body as { text?: string } | undefined)?.text ?? "");
            res.json({ run: await rt.orchestra.reply(runId, text) });
          } else if (action === "apply") {
            const task = (req.body as { task?: unknown } | undefined)?.task;
            res.json(await rt.orchestra.apply(runId, task ? String(task) : undefined));
          }
          else {
            await rt.orchestra.cleanup(runId);
            res.json({ ok: true });
          }
        } catch (err) {
          orchestraError(res, err);
        }
      }),
    );
  }
}
