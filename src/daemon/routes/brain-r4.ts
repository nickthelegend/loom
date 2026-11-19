import { logbook } from "../../core/logbook.js";
import type { Express, Request } from "express";
import { z } from "zod";
import { MEMORY_KINDS, type MemoryKind } from "../../core/brain.js";
import { askBrain } from "../../core/brain-r4/ask.js";
import { INTERVIEW, sinceTime } from "../../core/brain-r4/knowledge.js";
import { configureSource, refreshSources, sourcePatterns } from "../../core/brain-r4/sources.js";
import { readMarkdownUrl } from "../../core/brain-markdown.js";
import { helperText } from "../../core/provider-text.js";
import type { AuthManager } from "../auth.js";
import type { WithRuntime } from "./context.js";

const text = z.string().trim().min(1).max(100_000);
const name = z.string().trim().min(1).max(100).regex(/^[\w .-]+$/);
const scope = { chat: z.string().min(1).max(200).optional(), agent: z.string().min(1).max(200).optional(), crew: z.string().min(1).max(200).optional(), task: z.string().min(1).max(200).optional() };
const packSchema = z.object({ format: z.literal("loom-brain"), version: z.literal(1), pack: name, project: z.string().max(500), exportedAt: z.number().finite(),
  memories: z.array(z.object({ kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]), text, ...scope,
    entities: z.array(z.string().max(200)).max(200).optional(), confidence: z.number().min(0).max(1).optional(),
    private: z.boolean().optional(), untrusted: z.boolean().optional(), evidence: z.string().max(100_000).optional(),
    expiresAt: z.number().finite().optional(), pinned: z.boolean().optional(), priority: z.number().int().min(-1000).max(1000).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(), paths: z.array(z.string().min(1).max(500)).max(50).optional(),
  })).max(2000) });

export function registerBrainR4Routes(app: Express, withRuntime: WithRuntime, auth: AuthManager): void {
  const actor = (req: Request) => {
    const client = auth.clientFor(req.headers.authorization?.replace(/^Bearer /i, ""));
    return client ? `${client.name} (${client.id})` : "user";
  };
  const route = (method: "get" | "post" | "patch" | "delete", suffix: string, handler: Parameters<WithRuntime>[0]) => {
    app[method]("/api/projects/:id/brain" + suffix, withRuntime(async (rt, req, res) => {
      try { await handler(rt, req, res); }
      catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    }));
  };
  route("post", "/ask", async (rt, req, res) => {
    const input = z.strictObject({ question: text, ...scope, tag: z.string().max(100).optional(), helper: z.boolean().optional() }).parse(req.body);
    try { refreshSources(rt.brain, rt.info.dir); }
    catch (error) { logbook.warn("brain", "document refresh failed; using indexed chunks", String(error), rt.info.id); }
    res.json(await askBrain(rt.brain, input.question, input, input.helper ? prompt => helperText(rt.config.brain?.model ?? "haiku", prompt, { timeoutMs: 30_000 }) : undefined));
  });
  route("post", "/:mid/tags", async (rt, req, res) => {
    const input = z.strictObject({ tags: z.array(z.string().trim().min(1).max(100)).min(1).max(50) }).parse(req.body);
    res.json({ memory: rt.brain.knowledge.tag(String(req.params.mid), input.tags, actor(req)) });
  });
  route("get", "/settings", async (rt, _req, res) => { res.json(rt.brain.knowledge.settings()); });
  route("patch", "/settings", async (rt, req, res) => {
    const input = z.strictObject({ reviewBeforeSaving: z.boolean() }).parse(req.body);
    res.json(rt.brain.knowledge.configure(input.reviewBeforeSaving, actor(req)));
  });
  route("get", "/inbox", async (rt, _req, res) => { res.json({ proposals: rt.brain.knowledge.inbox() }); });
  route("post", "/inbox/:proposal", async (rt, req, res) => {
    const input = z.strictObject({ action: z.enum(["approve", "edit", "reject"]), text: text.optional() }).parse(req.body);
    res.json(rt.brain.knowledge.review(String(req.params.proposal), input.action, actor(req), input.text));
  });
  route("get", "/packs", async (rt, _req, res) => { res.json({ packs: rt.brain.knowledge.packs() }); });
  route("post", "/packs", async (rt, req, res) => {
    const input = z.strictObject({ name, tag: z.string().max(100).optional() }).parse(req.body);
    res.json(rt.brain.knowledge.savePack(input.name, rt.info.name, input.tag));
  });
  route("post", "/packs/install", async (rt, req, res) => {
    const input = z.union([z.strictObject({ url: z.string().max(4000) }), z.strictObject({ pack: packSchema })]).parse(req.body);
    const remote = "url" in input;
    const who = req as Request & { isAdmin?: boolean; projectScope?: string[] | null; guest?: unknown };
    if (remote && !(who.isAdmin || (!who.projectScope && !who.guest))) {
      res.status(403).json({ error: "URL install requires the owner" }); return;
    }
    const pack = remote ? packSchema.parse(JSON.parse(await readMarkdownUrl(input.url))) : input.pack;
    res.json(rt.brain.knowledge.installPack(pack, actor(req), remote));
  });
  route("delete", "/packs/:name", async (rt, req, res) => { res.json(rt.brain.knowledge.removePack(name.parse(req.params.name), actor(req))); });
  route("post", "/:mid/feedback", async (rt, req, res) => {
    const input = z.strictObject({ value: z.enum(["helpful", "wrong"]), injection: z.number().int().positive() }).parse(req.body);
    res.json(rt.brain.knowledge.feedback(String(req.params.mid), input.value, input.injection, actor(req)));
  });
  route("get", "/stats", async (rt, _req, res) => {
    const usage = rt.memoryUsage();
    res.json({ ...rt.brain.stats(), usage, timesBriefed: Object.values(usage).reduce((n, u) => n + u.n, 0),
      inbox: rt.brain.knowledge.inbox().length, feedback: rt.brain.knowledge.events("feedback").map(e => e.payload) });
  });
  route("get", "/sources", async (rt, _req, res) => {
    try { refreshSources(rt.brain, rt.info.dir); }
    catch (error) { logbook.warn("brain", "document refresh failed; using indexed chunks", String(error), rt.info.id); }
    res.json({ sources: sourcePatterns(rt.brain).map(pattern => ({ pattern, chunks: rt.brain.all().filter(m => m.source?.pattern === pattern).length })) });
  });
  route("post", "/sources", async (rt, req, res) => {
    const input = z.strictObject({ pattern: z.string().min(1).max(500), action: z.enum(["add", "rm", "refresh"]) }).parse(req.body);
    if (input.action !== "refresh") configureSource(rt.brain, input.pattern, rt.info.dir, input.action === "rm");
    res.json(input.action === "rm" ? { removed: true } : refreshSources(rt.brain, rt.info.dir, input.pattern));
  });
  route("get", "/changes", async (rt, req, res) => {
    const input = z.object({ since: z.string().optional() }).parse(req.query);
    res.json({ changes: rt.brain.knowledge.changes(sinceTime(input.since)) });
  });
  route("get", "/teach", async (_rt, _req, res) => { res.json({ questions: INTERVIEW }); });
  route("post", "/teach", async (rt, req, res) => {
    const input = z.strictObject({ tests: text.optional(), conventions: text.optional(), avoid: text.optional(), chat: scope.chat }).parse(req.body);
    if (input.chat && !rt.chats().some(c => c.id === input.chat)) throw new Error("no such chat");
    if (!INTERVIEW.some(q => input[q.key])) throw new Error("answer at least one interview question");
    const memories = INTERVIEW.flatMap(q => input[q.key] ? [rt.brain.add({ kind: q.kind, text: q.prefix + input[q.key], tags: ["interview"],
      scope: input.chat ? { chat: input.chat } : {}, provenance: { agentId: actor(req), eventId: rt.log.lastId(), ts: Date.now() } }).memory] : []);
    res.json({ memories });
  });
}
