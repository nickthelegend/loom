import type { Express } from 'express';
import { recordRecent } from "../../core/prompts.js";
import type { WithRuntime } from './context.js';
import { ContinuityError, Id, Text, parseBounded } from "../../core/continuity/contracts.js";
import { z } from "zod";
/** Register messages routes in the order established by LoomDaemon.routes(). */
export function registerMessagesRoutes(app: Express, withRuntime: WithRuntime): void {

  /**
   * {text, chat?, agentId?} -> {steered:true}, or
   * {steered:false, queued:number, queueId:string, reason:string}.
   * chat defaults to main; agentId overrides the chat binding and current holder.
   * An idle chat uses the normal queue (no 409). Accepted input is a user message
   * with payload.steer=true. A transport error is not retried: delivery may be unknown.
   */
  app.post("/api/projects/:id/steer", withRuntime(async (rt, req, res) => {
    const body = z.strictObject({ text: Text.refine(t => t.trim().length > 0, "missing text"),
      chat: Id.optional(), agentId: Id.optional() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "expected {text, chat?, agentId?} with nonempty text and string ids" });
    const { text, chat, agentId } = body.data;
    const result = await rt.steerMessage(text, agentId, { ...(chat ? { chat } : {}) });
    recordRecent(text, { project: rt.info.name, mode: "chat" });
    res.json(result);
  }));

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
      // a Share-live guest reads its chat, whatever it asks for
      const guest = (req as unknown as { guest?: { chat: string; name: string } }).guest;
      const chat = guest ? guest.chat : req.query.chat ? String(req.query.chat) : undefined;
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

  // How heavy an agent's session in a chat is, and whether its cache has likely gone cold —
  // so a short question can be warned before it re-reads 170k tokens (#280)
  app.get(
    "/api/projects/:id/agents/:agentId/session",
    withRuntime(async (rt, req, res) => {
      res.json({ session: rt.sessionWeight(String(req.params.agentId), String(req.query.chat ?? "main")) });
    }),
  );

  app.post(
    "/api/projects/:id/messages",
    withRuntime(async (rt, req, res) => {
      if (rt.continuity) {
        try { parseBounded(z.strictObject({ text: Text.min(1), agentId: Id.optional(), chat: Id.optional(),
          plan: z.boolean().optional(), fresh: z.boolean().optional(), requestId: Id.optional(), length: z.enum(["brief", "normal", "detailed"]).optional() }), req.body); }
        catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "invalid continuity request", code: "invalid" }); return; }
      }
      const guest = (req as unknown as { guest?: { chat: string; name: string } }).guest;
      const body = { ...(req.body ?? {}), ...(guest ? { chat: guest.chat, plan: false } : {}) };
      const { text, agentId, chat, plan, fresh, requestId, length } = body as {
        text?: string;
        agentId?: string;
        chat?: string;
        plan?: boolean;
        fresh?: boolean;
        requestId?: string;
        length?: string;
      };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      let result;
      try {
        result = await rt.sendMessage(text, agentId, {
          ...(chat ? { chat } : {}),
          ...(guest ? { by: guest.name } : {}),
          ...(plan ? { plan: true } : {}),
          ...(fresh ? { fresh: true } : {}),
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
