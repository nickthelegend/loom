import type { Express, Request } from "express";
import { z } from "zod";
import type { RouteContext, WithRuntime } from "./context.js";
import { mcpTools } from "../../core/mcp-server.js";
import { loomToolScope } from "../../core/loom-tools.js";
import { readSettings, writeSettings } from "../../core/agentic-r4/state.js";
import { attachHooks, listHooks, runHook, HOOK_EVENTS } from "../../core/agentic-r4/hooks.js";
import { draftChatSkill } from "../../core/agentic-r4/skills.js";
import { recentToolCalls } from "../../core/agentic-r4/call-log.js";
import { consult } from "../../core/agentic-r4/consult.js";
import { findProject, listProjects } from "../../core/registry.js";
import { bearerToken } from "../auth.js";

export function registerAgenticRoutes(app: Express, ctx: RouteContext, withRuntime: WithRuntime, toolWrites: RegExp[]) {
  toolWrites.push(/^\/r4\/(consult|log|retry)$/, /^\/queue$/, /^\/reviews$/);
  const owner = (req: Request) => !(req as Request & { projectScope?: string[] | null; guest?: unknown }).projectScope && !(req as Request & { guest?: unknown }).guest;
  app.use("/api/projects/:id", (req, _res, next) => {
    const project = findProject(String(req.params.id));
    if (!project) return void next();
    void ctx.runtime(project.id).then(rt => { attachHooks(rt); next(); }, () => next());
  });
  // Enabled projects are attached at startup even when their first work is a scheduled run.
  for (const p of listProjects()) if (readSettings(p.id).hooks) void ctx.runtime(p.id).then(attachHooks).catch(() => {});

  app.get("/api/projects/:id/r4/tools", withRuntime(async (rt, _req, res) => {
    const settings = readSettings(rt.info.id);
    res.json({ ...settings, loomTools: Boolean(rt.config.loomTools), tools: mcpTools().map(t => ({ name: t.name, description: t.description, enabled: !settings.disabledTools.includes(t.name) })) });
  }));
  app.put("/api/projects/:id/r4/tools", withRuntime(async (rt, req, res) => {
    const parsed = z.strictObject({ disabledTools: z.array(z.string()).max(100) }).safeParse(req.body);
    if (!parsed.success || parsed.data.disabledTools.some(name => !mcpTools().some(t => t.name === name))) return void res.status(400).json({ error: "disabledTools must contain known Loom tool names" });
    res.json(writeSettings(rt.info.id, { disabledTools: [...new Set(parsed.data.disabledTools)] }));
  }));
  app.get("/api/projects/:id/r4/log", withRuntime(async (rt, req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    res.json({ calls: recentToolCalls(rt.log, limit) });
  }));
  app.post("/api/projects/:id/r4/log", withRuntime(async (rt, req, res) => {
    const parsed = z.strictObject({ tool: z.string().max(100), ok: z.boolean(), durationMs: z.number().nonnegative().finite(), error: z.string().max(4000).optional() }).safeParse(req.body);
    if (!parsed.success || !mcpTools().some(t => t.name === parsed.data.tool)) return void res.status(400).json({ error: "invalid tool call record" });
    const token = bearerToken(req.headers.authorization), scope = loomToolScope(token), device = ctx.auth.clientFor(token);
    const actor = scope ? scope.agent ?? (scope.run && scope.task ? rt.orchestra.get(scope.run)?.tasks.find(t => t.id === scope.task)?.agent : undefined) ?? `agent turn ${scope.turnId ?? "unknown"}` : device?.name ?? "owner";
    rt.log.append({ kind: "status", payload: { state: "mcp_call", ...parsed.data, actor, ...(scope?.turnId ? { turn: scope.turnId } : {}), ...(scope?.run ? { run: scope.run, task: scope.task } : {}) } });
    res.json({ recorded: true });
  }));
  app.get("/api/projects/:id/r4/hooks", withRuntime(async (rt, req, res) => {
    res.json({ ...listHooks(rt.info.id, rt.info.dir), canEnable: owner(req) });
  }));
  app.put("/api/projects/:id/r4/hooks", withRuntime(async (rt, req, res) => {
    if (req.body?.enabled !== false && !owner(req)) return void res.status(403).json({ error: "enabling repository hooks requires the owner or an unscoped paired device" });
    if (typeof req.body?.enabled !== "boolean") return void res.status(400).json({ error: "enabled must be boolean" });
    writeSettings(rt.info.id, { hooks: req.body.enabled });
    res.json(listHooks(rt.info.id, rt.info.dir));
  }));
  app.post("/api/projects/:id/r4/hooks/test", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "testing repository hooks requires the owner or an unscoped paired device" });
    if (!HOOK_EVENTS.includes(req.body?.event)) return void res.status(400).json({ error: "unknown hook event" });
    try { res.json(await runHook(rt.info.id, rt.info.dir, req.body.event, { test: true })); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));
  app.post("/api/projects/:id/r4/skills/from-chat", withRuntime(async (rt, req, res) => {
    const parsed = z.strictObject({ chat: z.string().min(1), name: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "chat and name are required" });
    const { chat, name } = parsed.data;
    if (!rt.chats().some(c => c.id === chat)) return void res.status(404).json({ error: "no such chat" });
    if ((await rt.status()).agents.some(a => a.busy && (a.chat ?? "main") === chat)) return void res.status(409).json({ error: "wait for the chat to finish" });
    try {
      const draft = draftChatSkill(rt.info.dir, chat, name, rt.log.list({ chat }));
      rt.setSkillEnabled(name, false);
      res.json(draft);
    }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));
  app.post("/api/projects/:id/r4/retry", withRuntime(async (rt, req, res) => {
    const parsed = z.strictObject({ run: z.string().min(1), task: z.string().min(1), agent: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "run, task and agent are required" });
    if (readSettings(rt.info.id).disabledTools.includes("loom_orchestra_retry")) return void res.status(403).json({ error: "loom_orchestra_retry is disabled" });
    try { res.json({ run: await rt.orchestra.retryTask(parsed.data.run, parsed.data.task, parsed.data.agent) }); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));
  app.post("/api/projects/:id/r4/consult", withRuntime(async (rt, req, res) => {
    if (readSettings(rt.info.id).disabledTools.includes("loom_consult")) return void res.status(403).json({ error: "loom_consult is disabled for this project" });
    const parsed = z.object({ chat: z.string().optional(), agent: z.string().optional(), model: z.string().optional(), question: z.string().min(1).max(32_000) }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "send question and agent or model" });
    try { res.json(await consult(rt, parsed.data, loomToolScope(bearerToken(req.headers.authorization)))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));
}
