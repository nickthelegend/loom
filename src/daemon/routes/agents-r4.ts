import type { Express, Request, Response } from "express";
import type { RouteContext, WithRuntime } from "./context.js";
import { profiles, saveProfile, removeProfile, sessionSettings, updateSessionSettings, agentEnvironment, changeEnvironment } from "../../core/agents-r4/store.js";
import { catchup, setLabels } from "../../core/agents-r4/chats.js";
import { sleepingAgents, sessionBusy } from "../../core/agents-r4/runtime.js";
import { readProjectState, writeProjectState } from "../../core/registry.js";
import { validateAgentOptions } from "../../core/model-routing.js";
import type { ProjectRuntime } from "../runtime.js";

const owner = (req: Request) => !(req as Request & { guest?: unknown; projectScope?: string[] | null }).guest && !(req as Request & { projectScope?: string[] | null }).projectScope;
const fail = (res: Response, e: unknown) => { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); };
export function registerAgentsR4(app: Express, withRuntime: WithRuntime, ctx: Pick<RouteContext, "runtimes">): void {
  // Enrich existing roster responses without changing their fields or visibility.
  app.use("/api", (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: any) => {
      const decorate = (p: any) => {
        if (!p || !Array.isArray(p.agents)) return;
        const rt = ctx.runtimes.get(p.id ?? p.project?.id);
        if (!rt) return;
        for (const a of p.agents) a.asleep = sleepingAgents.get(rt)?.has(a.id) ?? false;
      };
      decorate(body); decorate(body?.project);
      if (Array.isArray(body?.projects)) body.projects.forEach(decorate);
      return json(body);
    };
    next();
  });
  app.use("/api/profiles", (req, res, next) => { if (!owner(req)) return void res.status(403).json({ error: "profiles require the owner or an unscoped device" }); next(); });
  app.get("/api/profiles", (_req, res) => { res.json({ profiles: profiles() }); });
  app.put("/api/profiles/:name", (req, res) => { try { res.json({ profile: saveProfile(String(req.params.name), req.body) }); } catch (e) { fail(res, e); } });
  app.delete("/api/profiles/:name", (req, res) => { removeProfile(String(req.params.name)); res.json({ removed: true }); });

  const route = (handler: (rt: ProjectRuntime, req: Request, res: Response) => Promise<void>) => withRuntime(async (rt, req, res) => { try { await handler(rt, req, res); } catch (e) { fail(res, e); } });
  app.get("/api/projects/:id/session-settings", route(async (rt, _req, res) => { res.json(sessionSettings(rt.info.dir)); }));
  app.put("/api/projects/:id/session-settings", route(async (rt, req, res) => { res.json(updateSessionSettings(rt.info.dir, req.body)); }));
  app.put("/api/projects/:id/agents/:agentId/limits", route(async (rt, req, res) => {
    const id = String(req.params.agentId);
    if (!rt.config.agents.some(a => a.id === id)) return void res.status(404).json({ error: "unknown agent" });
    res.json(updateSessionSettings(rt.info.dir, req.body, id));
  }));
  app.post("/api/projects/:id/agents/:agentId/clone", route(async (rt, req, res) => {
    const source = rt.config.agents.find(a => a.id === req.params.agentId);
    if (!source) return void res.status(404).json({ error: "unknown agent" });
    const count = req.body?.count ?? 1, model = req.body?.model;
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("count must be 1–8");
    if (model !== undefined && typeof model !== "string") throw new Error("model must be text");
    const options = structuredClone(source.options ?? {});
    delete options.env;
    if (model !== undefined) options.model = model;
    validateAgentOptions(source.kind, options);
    const agents = Array.from({ length: count }, () => {
      const a = rt.addAgent(source.kind, { id: source.id + "-copy", series: true, role: source.role, account: source.account, options: structuredClone(options) });
      if (source.instructions) rt.setAgentInstructions(a.id, source.instructions);
      const policy = sessionSettings(rt.info.dir).agents[source.id];
      if (policy) updateSessionSettings(rt.info.dir, policy, a.id);
      return a;
    });
    res.json({ agents });
  }));
  app.get("/api/projects/:id/agents/:agentId/env", route(async (rt, req, res) => {
    const id = String(req.params.agentId);
    if (!rt.config.agents.some(a => a.id === id)) return void res.status(404).json({ error: "unknown agent" });
    res.json({ names: Object.keys(agentEnvironment(rt.info.id, id)).sort() });
  }));
  for (const method of ["put", "delete"] as const) app[method]("/api/projects/:id/agents/:agentId/env", route(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner and unscoped devices may change environment values" });
    const id = String(req.params.agentId);
    if (!rt.config.agents.some(a => a.id === id)) return void res.status(404).json({ error: "unknown agent" });
    // Reject busy edits before storing anything. Replacement uses saved native sessions.
    if (sessionBusy(rt, id)) return void res.status(409).json({ error: "wait for this agent's turn to finish" });
    if (method === "put" && typeof req.body?.value !== "string") throw new Error("value must be text");
    const names = changeEnvironment(rt.info.id, id, req.body?.key, method === "put" ? req.body.value : undefined);
    rt.setAgentOptions(id, {});
    res.json({ names });
  }));
  app.put("/api/projects/:id/chats/:chat/labels", route(async (rt, req, res) => {
    const chat = setLabels(rt.info.dir, String(req.params.chat), req.body?.labels);
    rt.log.append({ kind: "status", chat: chat.id, payload: { state: "chat_labels", labels: chat.labels } });
    res.json({ chat });
  }));
  app.post("/api/projects/:id/chats/:chat/catchup", route(async (rt, req, res) => {
    const chat = String(req.params.chat), state = readProjectState(rt.info.dir);
    if (!rt.chats().some(c => c.id === chat)) return void res.status(404).json({ error: "no such chat" });
    const since = req.body?.since ?? state.agentsR4Read?.[chat] ?? 0, model = req.body?.model;
    if (!Number.isSafeInteger(since) || since < 0) throw new Error("since must be a nonnegative event id");
    if (model !== undefined && (typeof model !== "string" || !model.trim())) throw new Error("model must be a provider/model name");
    const result = await catchup(rt.log.list({ chat, limit: 20_000 }), since, model);
    if (req.body?.markRead !== false) { const latest = readProjectState(rt.info.dir); latest.agentsR4Read = { ...latest.agentsR4Read, [chat]: result.through }; writeProjectState(rt.info.dir, latest); }
    res.json(result);
  }));
}
