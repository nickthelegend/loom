import { brainMarkdown, parseBrainMarkdown, readMarkdownUrl, writeBrainMarkdown } from "../../core/brain-markdown.js";
import type { Express } from 'express';
import { findConflicts, findDuplicates } from "../../core/brain-index.js";
import { MEMORY_KINDS, staleMemory, type MemoryKind } from "../../core/brain.js";
import type { WithRuntime } from './context.js';
import { z } from "zod";
import { ContextItemV1, ContinuityError, Id, parseBounded } from "../../core/continuity/contracts.js";
import { NATIVE_KINDS } from "../../core/continuity/capabilities.js";
/** Register brain routes in the order established by LoomDaemon.routes(). */
export function registerBrainRoutes(app: Express, withRuntime: WithRuntime, auth: import("../auth.js").AuthManager): void {
  const actor = (req: import("express").Request) => {
    const client = auth.clientFor(req.headers.authorization?.replace(/^Bearer /i, ""));
    return client ? `${client.name} (${client.id})` : "user";
  };
  // A project-scoped device reaches only its own projects (the scope wall), and its project's
  // memory is its own; URL import and repo export below stay with the owner.
  const scopeSchema = z.strictObject({ chat: z.string().min(1).max(200).optional(), agent: z.string().min(1).max(200).optional(),
    task: z.string().min(1).max(200).optional(), crew: z.string().min(1).max(200).optional() });
  const patchSchema = z.strictObject({ text: z.string().trim().min(1).max(100_000).optional(), kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]).optional(),
    entities: z.array(z.string().max(200)).max(200).optional(), confidence: z.number().min(0).max(1).optional(),
    scope: scopeSchema.optional(), pinned: z.boolean().optional(), priority: z.number().int().min(-1000).max(1000).optional(),
    archived: z.boolean().optional(), private: z.boolean().optional(), untrusted: z.boolean().optional(),
    evidence: z.string().max(100_000).optional(), expiresAt: z.number().finite().nullable().optional() });
  const filters = (query: import("express").Request["query"]) => {
    const input = z.object({ kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]).optional(), author: z.string().optional(),
      since: z.string().optional(), until: z.string().optional() }).parse(query);
    const date = (value: string | undefined, end: boolean) => {
      if (value === undefined) return undefined;
      const n = Date.parse(value + (/^\d{4}-\d{2}-\d{2}$/.test(value) ? end ? "T23:59:59.999Z" : "T00:00:00.000Z" : ""));
      if (!Number.isFinite(n) || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || (/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(n).toISOString().slice(0, 10) !== value)) throw new Error("invalid date filter");
      return n;
    };
    const since = date(input.since, false), until = date(input.until, true);
    if (since !== undefined && until !== undefined && since > until) throw new Error("since must precede until");
    return { kind: input.kind, author: input.author, since, until };
  };
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
        chat: request.conversationId, source: request.source, plan: request.plan, capturedModel: request.model, capturedEffort: request.effort ?? null,
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
        provenance: { agentId: actor(req), eventId: event.id, ts: event.ts },
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
      try {
        const memories = rt.brain.list({
          ...filters({ ...req.query, author: req.query.author ?? req.query.agent }),
          includeArchived: q.includeArchived === "1",
          ...(q.chat ? { chat: q.chat } : {}),
          ...(q.includeExpired === "1" ? { includeExpired: true } : {}),
          ...(q.limit ? { limit: Math.max(1, Math.min(500, Number(q.limit) || 100)) } : {}),
        });
        const usage = rt.memoryUsage();
        res.json({ memories: memories.map(m => ({ ...m, stale: staleMemory(m, usage[m.id]?.at), lastUsedAt: usage[m.id]?.at })), stats: rt.brain.stats() });
      } catch (error) { failure(res, error); }
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
      try {
        const hits = await rt.searchBrain({
          ...filters(req.query),
          ...(q.agent ? { agent: q.agent } : {}),
          includeArchived: q.includeArchived === "1",
          ...(q.q ? { query: q.q } : {}),
          ...(files.length ? { files } : {}),
          ...(q.chat ? { chat: q.chat } : {}),
          limit: Math.max(1, Math.min(500, Number(q.limit) || 12)),
          explain: q.explain === "1",
        });
        const usage = rt.memoryUsage();
        res.json({ hits: hits.map(h => ({ ...h, memory: { ...h.memory, stale: staleMemory(h.memory, usage[h.memory.id]?.at) } })), stats: rt.brain.stats() });
      } catch (error) { failure(res, error); }
    }),
  );

  app.post(
    "/api/projects/:id/brain",
    withRuntime(async (rt, req, res) => {
      try {
        const input = patchSchema.omit({ archived: true }).extend({ text: z.string().trim().min(1).max(100_000), chat: z.string().min(1).max(200).optional() }).parse(req.body);
        const scope = input.chat ? { ...input.scope, chat: input.chat } : input.scope;
        if (scope?.chat && !rt.chats().some(c => c.id === scope.chat)) throw new Error("no such chat");
        const { memory, created } = rt.brain.add({
          ...input, expiresAt: input.expiresAt ?? undefined, scope,
          kind: input.kind ?? "fact", text: input.text,
          provenance: { agentId: actor(req), eventId: rt.log.lastId(), ts: Date.now() },
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
      const doc = rt.brain.export(rt.info.name);
      if (_req.query.format === "md") { res.type("text/markdown").send(brainMarkdown(doc)); return; }
      res.json(doc);
    }),
  );

  app.post(
    "/api/projects/:id/brain/import",
    withRuntime(async (rt, req, res) => {
      try {
        const input = req.body;
        let doc = input;
        if (input?.url !== undefined) {
          if (!(req as import("express").Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "URL import requires owner/admin" });
          doc = parseBrainMarkdown(await readMarkdownUrl(z.string().max(4000).parse(input.url)));
          doc.memories = doc.memories.map((m: import("../../core/brain.js").BrainExport["memories"][number]) => ({ ...m, untrusted: true, pinned: false }));
        } else if (input?.markdown !== undefined) doc = parseBrainMarkdown(input.markdown);
        if (doc?.format !== "loom-brain" || !Array.isArray(doc.memories)) throw new Error("not a loom brain export");
        if (doc.memories.length > 2000) throw new Error("import at most 2000 memories at a time");
        const row = patchSchema.omit({ scope: true, archived: true }).extend({
          text: z.string().trim().min(1).max(100_000), kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]),
          expiresAt: z.number().finite().optional(),
          chat: z.string().max(200).optional(), agent: z.string().max(200).optional(), crew: z.string().max(200).optional(), task: z.string().max(200).optional(),
        });
        // JSON imports have always skipped malformed rows; validate new fields without changing that contract.
        const validated = { ...doc, memories: doc.memories.flatMap((m: unknown) => {
          const result = row.safeParse(m); return result.success ? [result.data] : [];
        }) };
        const out = rt.brain.import(validated as Parameters<typeof rt.brain.import>[0], {
          agentId: actor(req),
          eventId: rt.log.lastId(),
          ts: Date.now(),
        });
        res.json(out);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post("/api/projects/:id/brain/export", withRuntime(async (rt, req, res) => {
    if (!(req as import("express").Request & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "repo export requires owner/admin" });
    try { const input = z.strictObject({ md: z.string().min(1).max(1000) }).parse(req.body);
      res.json({ file: writeBrainMarkdown(rt.info.dir, input.md, rt.brain.export(rt.info.name)) });
    } catch (error) { failure(res, error); }
  }));
  app.get("/api/projects/:id/brain/duplicates", withRuntime(async (rt, _req, res) => {
    res.json({ duplicates: findDuplicates(rt.brain.all()) });
  }));
  app.post("/api/projects/:id/brain/merge", withRuntime(async (rt, req, res) => {
    try { const input = z.strictObject({ keep: z.string(), other: z.string(), text: z.string().trim().min(1).max(100_000) }).parse(req.body);
      res.json({ memory: rt.brain.merge(input.keep, input.other, input.text, actor(req)) });
    } catch (error) { failure(res, error); }
  }));
  app.post("/api/projects/:id/brain/:mid/revert", withRuntime(async (rt, req, res) => {
    try { const input = z.strictObject({ eventId: z.number().int().positive() }).parse(req.body);
      res.json({ memory: rt.brain.revert(String(req.params.mid), input.eventId, actor(req)) });
    } catch (error) { failure(res, error); }
  }));
  app.get("/api/projects/:id/brain/injections", withRuntime(async (rt, req, res) => {
    const injections = rt.log.list({ kinds: ["status"], ...(typeof req.query.chat === "string" ? { chat: req.query.chat } : {}) })
      .filter(e => e.payload.state === "memory_injection" && (!req.query.turn || String(e.payload.turn) === req.query.turn));
    res.json({ injections: injections.slice(-100) });
  }));

  app.patch(
    "/api/projects/:id/brain/:mid",
    withRuntime(async (rt, req, res) => {
      try {
        const patch = patchSchema.parse(req.body);
        if (patch.scope?.chat && !rt.chats().some(c => c.id === patch.scope!.chat)) throw new Error("no such chat");
        res.json({ memory: rt.brain.update(String(req.params.mid), patch, actor(req)) });
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
      const forgot = rt.brain.forget(String(req.params.mid), reason, actor(req));
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
