import { listOrchestraRecipes, saveOrchestraRecipe, runRecipeOptions, orchestraGraph, projectWebhookSecret } from "../../core/orchestra-options.js";
import { createShare } from "../../core/shares.js";
import { shareHours } from "../../core/team-sharing.js";
import { loomToolScope } from "../../core/loom-tools.js";
import type { Express } from 'express';
import express from "express";
import { bearerToken } from "../auth.js";
import { recordRecent } from "../../core/prompts.js";
import { subagents } from "../../core/subagents.js";
import type { CompareOptions } from "../../core/orchestra.js";
import type { WithRuntime } from './context.js';
/** Register orchestra routes in the order established by LoomDaemon.routes(). */
export function registerOrchestraRoutes(app: Express, withRuntime: WithRuntime): void {

  app.post("/api/projects/:id/orchestra/:runId/share", withRuntime(async (rt, req, res) => {
    const run = rt.orchestra.get(String(req.params.runId));
    if (!run) return void res.status(404).json({ error: "no such run" });
    try {
      const { share, token } = createShare({ projectId: rt.info.id, chat: run.chat, runId: run.id, title: run.goal, hours: shareHours(req.body ?? {}) });
      res.json({ id: share.id, url: `${req.protocol}://${req.headers.host}/share/${token}`, title: share.title, expiresAt: share.expiresAt });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));

  // ---- orchestra: one orchestrator, many parallel workers ---------------
  // See core/orchestra.ts. Every step is also an `orchestra` event on the
  // WebSocket, so clients render live from events and use these for actions.
  // POST workers is string[]: each fleet row is agent[@model][:effort][xN]
  // (×N also works, count 1..100), or @saved-name. workers: ["best:N"] opts
  // into the project's 30-day scoreboard (five entries per model, roster fallback).
  // orchestrator accepts a spec or saved fleet resolving to exactly one agent.
  // Responses keep workers as instance ids and add workerDetails: [{ id, kind,
  // model?, effort?, account?, configDir? }]. account is the machine-local registry
  // id and configDir the pinned path. Fleet copies rotate through same-kind accounts.
  // orchestrator and tasks also expose model?/effort?.
  // Missing selections mean provider defaults; older saved runs may lack
  // workerDetails. The started event includes it; task events include selections.
  const orchestraError = (res: express.Response, err: unknown) =>
    void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

  const owner = (req: express.Request, res: express.Response): boolean => {
    // The admin, or one of the owner's own unscoped devices (the rule accounts, terminals and
    // editors use). Project-scoped tokens and share-live guests are refused.
    const who = req as express.Request & { isAdmin?: boolean; projectScope?: string[] | null; guest?: unknown };
    if (who.isAdmin || (!who.projectScope && !who.guest)) return true;
    res.status(403).json({ error: "only the owner can change Orchestra recipes, webhooks or run settings" });
    return false;
  };

  app.get("/api/orchestra-recipes", (req, res) => {
    if (owner(req, res)) res.json({ recipes: listOrchestraRecipes() });
  });
  app.put("/api/orchestra-recipes", (req, res) => {
    if (!owner(req, res)) return;
    try { res.json({ recipe: saveOrchestraRecipe(req.body?.name, req.body?.options) }); }
    catch (err) { orchestraError(res, err); }
  });
  app.post("/api/projects/:id/orchestra-recipes/:name/run", withRuntime(async (rt, req, res) => {
    if (!owner(req, res)) return;
    try {
      const recipe = listOrchestraRecipes().find(r => r.name === req.params.name);
      if (!recipe) return void res.status(404).json({ error: "no such Orchestra recipe" });
      res.json({ run: await rt.orchestra.start(recipe.options) });
    } catch (err) { orchestraError(res, err); }
  }));
  app.get("/api/projects/:id/orchestra-webhook-secret", withRuntime(async (rt, req, res) => {
    if (owner(req, res)) res.json({ secret: projectWebhookSecret(rt.info.dir) });
  }));
  for (const resource of ["graph", "timeline"] as const) {
    app.get(`/api/projects/:id/orchestra/:runId/${resource}`, withRuntime(async (rt, req, res) => {
      const run = rt.orchestra.get(String(req.params.runId));
      if (!run) return void res.status(404).json({ error: "no such run" });
      res.json(resource === "graph" ? { mermaid: orchestraGraph(run) } : { events: run.timeline ?? [] });
    }));
  }
  app.post("/api/projects/:id/orchestra/:runId/tasks/:taskId/retry", withRuntime(async (rt, req, res) => {
    if (!owner(req, res)) return;
    try {
      if (typeof req.body?.agent !== "string" || !req.body.agent.trim()) throw new Error("agent is required (agent[@model][:effort])");
      res.json({ run: await rt.orchestra.retryTask(String(req.params.runId), String(req.params.taskId), req.body.agent) });
    } catch (err) { orchestraError(res, err); }
  }));
  for (const action of ["approve-plan", "budget", "recipe"] as const) {
    app.post(`/api/projects/:id/orchestra/:runId/${action}`, withRuntime(async (rt, req, res) => {
      if (!owner(req, res)) return;
      try {
        const id = String(req.params.runId), run = rt.orchestra.get(id);
        if (!run) return void res.status(404).json({ error: "no such run" });
        if (action === "recipe") res.json({ recipe: saveOrchestraRecipe(req.body?.name, runRecipeOptions(run)) });
        else res.json({ run: action === "budget" ? rt.orchestra.setBudget(id, req.body?.maxUsd) : await rt.orchestra.approvePlan(id) });
      } catch (err) { orchestraError(res, err); }
    }));
  }

  // Ask several: { prompt, entrants?: string[], best?: number, chat? } -> { run }.
  // best (2..8) opts into scoreboard selection; insufficient eligible models use
  // entrants (including @saved-name) or the roster. Without best, entrants is required.
  // 2–8 entrants after fleet expansion; ids, kinds/aliases and acp:<preset>
  // resolve only to enabled project agents. run.compare and run.race are true.
  // Read/poll via orchestra/:runId, or consume orchestra task events: tasks carry
  // result, files, diffStat { files, insertions, deletions }, costUsd and timestamps
  // in milliseconds. Missing cost means unknown. GET tasks/:taskId/diff returns
  // { patch } (unified diff, capped at 400k chars). Keep this one uses POST
  // orchestra/:runId/apply { task: taskId }; discarded worktrees are removed.
  app.post(
    "/api/projects/:id/compare",
    withRuntime(async (rt, req, res) => {
      try {
        const run = await rt.orchestra.compare((req.body ?? {}) as CompareOptions);
        recordRecent(run.goal, { project: rt.info.name, mode: "orchestrate" });
        res.json({ run });
      } catch (err) {
        orchestraError(res, err);
      }
    }),
  );

  app.get(
    "/api/projects/:id/orchestra",
    withRuntime(async (rt, _req, res) => {
      res.json({ runs: rt.orchestra.list(), active: rt.orchestra.active()?.id ?? null });
    }),
  );

  /** POST { kind: "checkpoint" | "needs_input" | "stuck" | "done", text?: string }
   * returns { report: { at, kind, text } }. Text is required except for done (max 4000).
   * A report never changes task status. GET runs include reports (latest 20) and
   * lastReport; WS orchestra phase "task_report" includes taskId, report and task.
   * Only the run's worker token or an owner/admin token may post.
   */
  app.post(
    "/api/projects/:id/orchestra/:runId/tasks/:taskId/report",
    withRuntime(async (rt, req, res) => {
      const runId = String(req.params.runId), taskId = String(req.params.taskId);
      const scope = loomToolScope(bearerToken(req.headers.authorization));
      const worker = scope?.project === rt.info.id && scope.run === runId && scope.task === taskId;
      if (!worker && !(req as express.Request & { isAdmin?: boolean }).isAdmin &&
          !rt.orchestra.acceptsReportToken(runId, bearerToken(req.headers.authorization))) {
        return void res.status(403).json({ error: "report requires this run's worker token or an owner/admin token" });
      }
      const run = rt.orchestra.get(runId);
      if (!run?.tasks.some(t => t.id === taskId)) return void res.status(404).json({ error: "no such task in this run" });
      try { res.json({ report: rt.orchestra.report(runId, taskId, req.body) }); }
      catch (err) { orchestraError(res, err); }
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
        planOnly?: boolean;
        stallMinutes?: number;
        kindLimits?: Record<string, number>;
        webhookUrl?: string;
        /** The thread the goal was typed in; the orchestrator answers there. */
        chat?: string;
        /** Every worker gets the same prompt; you pick the best. */
        race?: boolean;
        /** false: no teammates' agents, even with their runners online. */
        team?: boolean;
      };
      // Any paired client may start a run; only the owner may point it at an outbound webhook.
      if (b.webhookUrl !== undefined && !owner(req, res)) return;
      if (typeof b.goal !== "string" || !b.goal.trim()) return void res.status(400).json({ error: "missing goal" });
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
          maxUsd: b.maxUsd, planOnly: b.planOnly, stallMinutes: b.stallMinutes, kindLimits: b.kindLimits, webhookUrl: b.webhookUrl,
          ...(b.race ? { race: true } : {}),
          ...(b.team === false ? { team: false } : {}),
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
