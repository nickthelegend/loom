import type { Express } from 'express';
import { recordRecent } from "../../core/prompts.js";
import type { WithRuntime } from './context.js';
import { ContinuityError, Id, Text, parseBounded } from "../../core/continuity/contracts.js";
import { z } from "zod";
/** Register messages routes in the order established by LoomDaemon.routes(). */
export function registerMessagesRoutes(app: Express, withRuntime: WithRuntime): void {

  app.get(
    "/api/projects/:id/events",
    withRuntime(async (rt, req, res) => {
      const since = req.query.since ? Number(req.query.since) : undefined;
      // ?before= pages backwards: the thread's "earlier messages"
      const before = req.query.before ? Number(req.query.before) : undefined;
      // 1–1000: ?limit=0 or a non-number used to mean the whole log in one response
      const asked = req.query.limit ? Number(req.query.limit) : 200;
      const limit = Number.isFinite(asked) ? Math.min(1000, Math.max(1, Math.floor(asked))) : 200;
      // no ?chat= means the whole project — old clients keep seeing the
      // whole thread, which is what they've always shown
      const chat = req.query.chat ? String(req.query.chat) : undefined;
      const events = rt.log.list({
        since,
        limit,
        ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
        ...(chat ? { chat } : {}),
      });
      // A thread's first page also carries the replies being typed in it
      // right now: reload mid-reply and you see the reply so far.
      const opening = chat && since === undefined && before === undefined;
      res.json({ events, ...(opening ? { live: rt.liveNow(chat) } : {}) });
    }),
  );

  app.post(
    "/api/projects/:id/messages",
    withRuntime(async (rt, req, res) => {
      if (rt.continuity) {
        try { parseBounded(z.strictObject({ text: Text.min(1), agentId: Id.optional(), chat: Id.optional(),
          plan: z.boolean().optional(), requestId: Id.optional(), length: z.enum(["brief", "normal", "detailed"]).optional() }), req.body); }
        catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "invalid continuity request", code: "invalid" }); return; }
      }
      const { text, agentId, chat, plan, requestId, length } = (req.body ?? {}) as {
        text?: string;
        agentId?: string;
        chat?: string;
        plan?: boolean;
        requestId?: string;
        length?: string;
      };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      let result;
      try {
        result = await rt.sendMessage(text, agentId, {
          ...(chat ? { chat } : {}),
          ...(plan ? { plan: true } : {}),
          ...(requestId ? { requestId } : {}),
          ...(length === "brief" || length === "detailed" ? { length } : {}),
        });
      }
      catch (error) {
        if (!(error instanceof ContinuityError)) throw error;
        res.status(error.code === "invalid" ? 400 : error.code === "unsupported" ? 422 : 409).json({ error: error.message, code: error.code }); return;
      }
      recordRecent(text, { project: rt.info.name, mode: plan ? "plan" : "chat" });
      res.json(result);
    }),
  );
}
