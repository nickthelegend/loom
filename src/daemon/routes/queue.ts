import { ChatMoveError } from "../../core/chat-move.js";
import type { Express } from 'express';
import express from "express";
import { parseCondition, parseTarget, QueueItemGone } from "../../core/prompt-queue.js";
import { recordRecent } from "../../core/prompts.js";
import { deleteRecipe, getRecipe, listRecipes, roleToTarget, saveRecipe, targetToRole } from "../../core/recipes.js";
import { ProjectRuntime } from "../runtime.js";
import type { WithRuntime } from './context.js';
/** Register queue routes in the order established by LoomDaemon.routes(). */
export function registerQueueRoutes(app: Express, withRuntime: WithRuntime): void {

  /** The queue as clients read it: the items, plus why the head is waiting. */
  const queueView = (rt: ProjectRuntime) => {
    const q = rt.queue.snapshot();
    const head = q.items[0];
    const waitingFor = head && !q.paused ? rt.queueBlocker(head) : null;
    return { queue: q.items, paused: q.paused, ...(q.reason ? { reason: q.reason } : {}), ...(waitingFor ? { waitingFor } : {}) };
  };

  const queueError = (res: express.Response, err: unknown) =>
    void res.status(err instanceof QueueItemGone ? 404 : 400).json({ error: err instanceof Error ? err.message : String(err) });

  /**
   * The prompt queue: what you've lined up for this project.
   *
   * A prompt typed while an agent is mid-turn — or a goal typed while one is
   * still running — waits here instead of being refused, and stays yours
   * until it's sent: edit the text, change who takes it, reorder it, drop it.
   * The daemon sends the head as soon as nothing is in its way, one at a time.
   */
  app.get(
    "/api/projects/:id/queue",
    withRuntime(async (rt, _req, res) => {
      res.json(queueView(rt));
    }),
  );

  app.post(
    "/api/projects/:id/queue",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { text?: string; target?: unknown; chat?: string; plan?: boolean; when?: unknown };
      if (!b.text?.trim()) return void res.status(400).json({ error: "missing text" });
      try {
        const item = rt.enqueue({
          text: b.text,
          target: parseTarget(b.target),
          ...(b.chat ? { chat: b.chat } : {}),
          ...(b.plan ? { plan: true } : {}),
          ...(parseCondition(b.when) ? { when: parseCondition(b.when)! } : {}),
        });
        recordRecent(b.text, { project: rt.info.name, mode: item.target.kind === "orchestra" ? "orchestrate" : "chat" });
        res.json({ item, ...queueView(rt) });
      } catch (err) {
        res.status(err instanceof ChatMoveError ? err.status : 400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.patch(
    "/api/projects/:id/queue/:itemId",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { text?: string; target?: unknown; plan?: boolean; to?: number; when?: unknown };
      try {
        if (b.text !== undefined || b.target !== undefined || b.plan !== undefined || b.when !== undefined) {
          rt.editQueued(String(req.params.itemId), {
            ...(b.text !== undefined ? { text: String(b.text) } : {}),
            ...(b.target !== undefined ? { target: parseTarget(b.target) } : {}),
            ...(b.plan !== undefined ? { plan: Boolean(b.plan) } : {}),
            // null clears it: "go as soon as you can"
            ...(b.when !== undefined ? { when: b.when === null ? null : parseCondition(b.when) ?? null } : {}),
          });
        }
        if (b.to !== undefined) rt.queue.move(String(req.params.itemId), Number(b.to));
        void rt.drainPromptQueue();
        res.json(queueView(rt));
      } catch (err) {
        queueError(res, err);
      }
    }),
  );

  /** Same response as /steer. Uses the item's chat/target/text; removes it only on acceptance. */
  app.post("/api/projects/:id/queue/:queueId/steer", withRuntime(async (rt, req, res) => {
    try { res.json(await rt.steerQueued(String(req.params.queueId))); }
    catch (err) { queueError(res, err); }
  }));

  app.delete(
    "/api/projects/:id/queue/:itemId",
    withRuntime(async (rt, req, res) => {
      try {
        rt.queue.remove(String(req.params.itemId));
        void rt.drainPromptQueue();
        res.json(queueView(rt));
      } catch (err) {
        queueError(res, err);
      }
    }),
  );

  app.delete(
    "/api/projects/:id/queue",
    withRuntime(async (rt, _req, res) => {
      try {
        const dropped = rt.queue.clear();
        res.json({ dropped, ...queueView(rt) });
      } catch (err) { queueError(res, err); }
    }),
  );

  /**
   * Recipes: a queue worth keeping, replayed on any project.
   *
   * Saved by role rather than by agent id, because an id from one project
   * means nothing in another (core/recipes.ts).
   */
  app.get("/api/recipes", (_req, res) => {
    res.json({ recipes: listRecipes() });
  });

  app.post(
    "/api/projects/:id/queue/save",
    withRuntime(async (rt, req, res) => {
      const name = String((req.body ?? {}).name ?? "").trim();
      const items = rt.queue.snapshot().items;
      if (!items.length) return void res.status(400).json({ error: "there's nothing queued to save" });
      try {
        const roleOf = (agentId: string) => rt.config.agents.find((a) => a.id === agentId)?.role ?? rt.config.agents.find((a) => a.id === agentId)?.kind;
        const recipe = saveRecipe({
          name,
          fromProject: rt.info.name,
          steps: items.map((i) => ({ text: i.text, to: targetToRole(i.target, roleOf), ...(i.plan ? { plan: true } : {}) })),
        });
        res.json({ recipe });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post(
    "/api/projects/:id/queue/recipe",
    withRuntime(async (rt, req, res) => {
      const name = String((req.body ?? {}).name ?? "").trim();
      const recipe = getRecipe(name);
      if (!recipe) return void res.status(404).json({ error: `no recipe called "${name}"` });
      try {
        for (const step of recipe.steps) {
          rt.enqueue({
            text: step.text,
            target: roleToTarget(step.to, rt.config.agents),
            ...(step.plan ? { plan: true } : {}),
          });
        }
        res.json({ added: recipe.steps.length, ...queueView(rt) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.delete("/api/recipes/:name", (req, res) => {
    const gone = deleteRecipe(String(req.params.name));
    if (!gone) return void res.status(404).json({ error: "no such recipe" });
    res.json({ deleted: true });
  });

  /** Hold the queue where it is, or let it run again. */
  app.post(
    "/api/projects/:id/queue/pause",
    withRuntime(async (rt, req, res) => {
      const paused = (req.body ?? {}).paused !== false;
      rt.queue.setPaused(paused, paused ? "you paused the queue" : undefined);
      if (!paused) void rt.drainPromptQueue();
      res.json(queueView(rt));
    }),
  );
}
