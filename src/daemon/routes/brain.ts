import type { Express } from 'express';
import { findConflicts } from "../../core/brain-index.js";
import type { MemoryKind, MemoryPatch } from "../../core/brain.js";
import type { WithRuntime } from './context.js';
import { z } from "zod";
import { ContextItemV1, ContinuityError, Id, parseBounded } from "../../core/continuity/contracts.js";
import { NATIVE_KINDS } from "../../core/continuity/capabilities.js";
/** Register brain routes in the order established by LoomDaemon.routes(). */
export function registerBrainRoutes(app: Express, withRuntime: WithRuntime): void {
  // Keep concrete continuity routes before /brain/:mid. Diagnostics contain
  // stored evidence; provider acceptance is never labelled understanding.
  const requireBrain = (rt: Parameters<Parameters<WithRuntime>[0]>[0]) => {
    if (!rt.continuity) throw new ContinuityError("unsupported", "enable brain.continuity in project settings first");
    return rt.continuity;
  };
  // Reviewed items and checkpoints carry user authority. Any local process can
  // obtain the admin token, and a native agent can only act while it runs — so
  // user-authority writes are refused while any turn is preparing or running.
  const requireIdle = (rt: Parameters<Parameters<WithRuntime>[0]>[0]) => {
    const brain = requireBrain(rt);
    if (rt.anyBusy() || brain.store.activeReceipts().length)
      throw new ContinuityError("conflict", "reviewed context can only change while no agent turn is running");
    return brain;
  };
  const failure = (res: import("express").Response, error: unknown) => {
    res.status(error instanceof ContinuityError ? (error.code === "unsupported" ? 422 : error.code === "invalid" ? 400 : 409) : 400)
      .json({ error: error instanceof Error ? error.message : String(error), code: error instanceof ContinuityError ? error.code : "invalid" });
  };
  app.get("/api/projects/:id/brain/continuity", withRuntime(async (rt, req, res) => {
    if (!rt.continuity) { res.json({ enabled: false, supportedHarnesses: NATIVE_KINDS }); return; }
    try {
      const requestId = req.query.requestId === undefined ? undefined : parseBounded(Id, req.query.requestId);
      res.json({ enabled: true, ...rt.continuity.diagnostics(requestId) });
    } catch (error) { failure(res, error); }
  }));
  app.get("/api/projects/:id/brain/continuity/source/:eventId", withRuntime(async (rt, req, res) => {
    try {
      const brain = requireBrain(rt), chat = Id.parse(req.query.chat);
      const eventId = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).parse(req.params.eventId);
      const event = brain.store.event(eventId);
      if (!event) { res.status(404).json({ error: "source not found" }); return; }
      const source = brain.store.source(event, rt.info.id);
      res.json({ source, text: brain.readSource(source, chat) });
    } catch (error) { failure(res, error); }
  }));
  app.get("/api/projects/:id/brain/continuity/packets/:packetId", withRuntime(async (rt, req, res) => {
    try {
      const entry = requireBrain(rt).store.packet(Id.parse(req.params.packetId));
      if (!entry) { res.status(404).json({ error: "packet not found" }); return; }
      res.json(entry);
    } catch (error) { failure(res, error); }
  }));
  app.get("/api/projects/:id/brain/continuity/items", withRuntime(async (rt, req, res) => {
    try { res.json({ items: requireBrain(rt).store.items(Id.parse(req.query.chat)) }); }
    catch (error) { failure(res, error); }
  }));
  app.post("/api/projects/:id/brain/continuity/items", withRuntime(async (rt, req, res) => {
    try { res.json({ item: requireIdle(rt).putItem(parseBounded(ContextItemV1, req.body)) }); }
    catch (error) { failure(res, error); }
  }));
  app.post("/api/projects/:id/brain/continuity/checkpoint", withRuntime(async (rt, req, res) => {
    try {
      const brain = requireIdle(rt);
      const input = parseBounded(z.strictObject({ chat: Id, itemId: Id,
        eventIds: z.array(z.number().int().positive()).min(1).max(1000), reviewed: z.literal(true) }), req.body);
      brain.store.disposeMany(input.eventIds, input.chat, input.itemId);
      res.json({ checkpointed: input.eventIds.length });
    } catch (error) { failure(res, error); }
  }));
  app.post("/api/projects/:id/brain/continuity/search/rebuild", withRuntime(async (rt, req, res) => {
    try {
      parseBounded(z.strictObject({}), req.body);
      const brain = requireBrain(rt); brain.store.rebuildSearch();
      res.json({ search: brain.store.searchMode, rebuilt: true });
    } catch (error) { failure(res, error); }
  }));
  app.post("/api/projects/:id/brain/continuity/reconcile", withRuntime(async (rt, req, res) => {
    try {
      const input = parseBounded(z.strictObject({ receiptId: Id, evidence: z.string().min(1).max(2000),
        quiescent: z.literal(true) }), req.body);
      const brain = requireBrain(rt);
      if ((await rt.status()).agents.some(a => a.busy)) throw new ContinuityError("conflict", "a native agent is still busy");
      brain.store.reconcile(input.receiptId, input.evidence);
      res.json({ reconciled: true, replayed: false });
    } catch (error) { failure(res, error); }
  }));
  app.post("/api/projects/:id/brain/continuity/requests/:requestId/resume", withRuntime(async (rt, req, res) => {
    try {
      const brain = requireBrain(rt), request = brain.store.request(Id.parse(req.params.requestId));
      const input = parseBounded(z.strictObject({ targetAddedTokens: z.number().int().min(128).max(100_000) }), req.body);
      if (!request) { res.status(404).json({ error: "request not found" }); return; }
      const latest = brain.store.receipts(request.id).at(-1);
      if (latest && !["prepared", "failed"].includes(latest.status)) throw new ContinuityError("recovery_required", "submitted requests cannot be replayed through overflow recovery");
      res.json(await rt.sendMessage(request.text, request.agentInstanceId, { requestId: request.id, resume: true,
        chat: request.conversationId, source: request.source, plan: request.plan, capturedModel: request.model,
        contextTarget: input.targetAddedTokens }));
    } catch (error) { failure(res, error); }
  }));

  app.post(
    "/api/projects/:id/decisions",
    withRuntime(async (rt, req, res) => {
      const { text } = (req.body ?? {}) as { text?: string };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      const event = rt.log.append({ kind: "decision", payload: { text } });
      // Also a memory. The decision event stays because the projection and
      // forty other things read it; the memory is the addressable copy — the
      // one that can be retrieved by what it's about, corrected, and
      // forgotten. Seeding the brain from the surface people already use
      // beats asking them to fill a second box.
      rt.brain.add({
        kind: "decision",
        text,
        provenance: { agentId: "user", eventId: event.id, ts: event.ts },
      });
      res.json({ event });
    }),
  );

  // Mend decisions whose underscores were stripped before #275, from the planner's own words (#318).
  app.post(
    "/api/projects/:id/brain/repair-decisions",
    withRuntime(async (rt, req, res) => {
      res.json(rt.repairDecisions({ dryRun: (req.body as { dryRun?: unknown } | undefined)?.dryRun === true }));
    }),
  );

  // --- the brain ---------------------------------------------------------

  app.get(
    "/api/projects/:id/brain",
    withRuntime(async (rt, req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const memories = rt.brain.list({
        ...(q.kind ? { kind: q.kind as MemoryKind } : {}),
        ...(q.chat ? { chat: q.chat } : {}),
        ...(q.includeExpired === "1" ? { includeExpired: true } : {}),
        ...(q.limit ? { limit: Math.min(500, Number(q.limit) || 100) } : {}),
      });
      res.json({ memories, stats: rt.brain.stats() });
    }),
  );

  app.get(
    "/api/projects/:id/brain/search",
    withRuntime(async (rt, req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const files = q.files ? q.files.split(",").filter(Boolean) : [];
      if (!q.q?.trim() && !files.length) {
        return void res.status(400).json({ error: "missing q or files" });
      }
      // searchBrain, not retrieve: a search that scored differently from
      // the briefing it exists to explain would be worse than no search.
      const hits = await rt.searchBrain({
        ...(q.q ? { query: q.q } : {}),
        ...(files.length ? { files } : {}),
        ...(q.chat ? { chat: q.chat } : {}),
        ...(q.agent ? { agent: q.agent } : {}),
        limit: Math.min(50, Number(q.limit) || 12),
        explain: q.explain === "1",
      });
      res.json({ hits });
    }),
  );

  app.post(
    "/api/projects/:id/brain",
    withRuntime(async (rt, req, res) => {
      const body = (req.body ?? {}) as {
        text?: string;
        kind?: MemoryKind;
        entities?: string[];
        confidence?: number;
        chat?: string;
      };
      if (!body.text?.trim()) return void res.status(400).json({ error: "missing text" });
      try {
        const { memory, created } = rt.brain.add({
          kind: body.kind ?? "fact",
          text: body.text,
          ...(body.entities ? { entities: body.entities } : {}),
          ...(body.chat ? { scope: { chat: body.chat } } : {}),
          ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
          provenance: { agentId: "user", eventId: rt.log.lastId(), ts: Date.now() },
        });
        res.json({ memory, created });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  // The event log on disk: how big, and a VACUUM to give back free pages.
  app.get(
    "/api/projects/:id/log/size",
    withRuntime(async (rt, _req, res) => {
      res.json(rt.log.size());
    }),
  );
  app.post(
    "/api/projects/:id/log/compact",
    withRuntime(async (rt, _req, res) => {
      const before = rt.log.size();
      try {
        rt.log.compact();
      } catch (err) {
        return void res.status(409).json({ error: `couldn't compact the log right now: ${err instanceof Error ? err.message : String(err)}` });
      }
      res.json({ before, after: rt.log.size() });
    }),
  );

  // How often each memory reached an agent's prompt.
  app.get(
    "/api/projects/:id/brain/usage",
    withRuntime(async (rt, _req, res) => {
      res.json({ usage: rt.memoryUsage() });
    }),
  );

  // Likely contradictions between units, heuristically flagged for a human
  // to resolve — each flag names the signal that tripped it.
  app.get(
    "/api/projects/:id/brain/conflicts",
    withRuntime(async (rt, _req, res) => {
      res.json({ conflicts: findConflicts(rt.brain.all()) });
    }),
  );

  // The brain as a file. Export is the live memories — history stays where it
  // happened; what travels is what the project knows. Import dedupes by hash,
  // so bringing the same file in twice reports "known", not duplicates.
  app.get(
    "/api/projects/:id/brain/export",
    withRuntime(async (rt, _req, res) => {
      res.json(rt.brain.export(rt.info.name));
    }),
  );

  app.post(
    "/api/projects/:id/brain/import",
    withRuntime(async (rt, req, res) => {
      try {
        const out = rt.brain.import(req.body as Parameters<typeof rt.brain.import>[0], {
          agentId: "import",
          eventId: rt.log.lastId(),
          ts: Date.now(),
        });
        res.json(out);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.patch(
    "/api/projects/:id/brain/:mid",
    withRuntime(async (rt, req, res) => {
      try {
        res.json({ memory: rt.brain.update(String(req.params.mid), (req.body ?? {}) as MemoryPatch, "user") });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(/no such memory/.test(msg) ? 404 : 400).json({ error: msg });
      }
    }),
  );

  app.delete(
    "/api/projects/:id/brain/:mid",
    withRuntime(async (rt, req, res) => {
      const reason = String((req.query as Record<string, string>).reason ?? "").trim();
      if (!reason) return void res.status(400).json({ error: "forgetting needs a reason" });
      const forgot = rt.brain.forget(String(req.params.mid), reason, "user");
      if (!forgot) return void res.status(404).json({ error: "no such memory" });
      res.json({ forgot: true });
    }),
  );

  app.get(
    "/api/projects/:id/brain/:mid/history",
    withRuntime(async (rt, req, res) => {
      res.json({ history: rt.brain.history(String(req.params.mid)) });
    }),
  );
}
