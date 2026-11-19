import type { Express, Request, RequestHandler } from "express";
import type { RouteContext, WithRuntime } from "./context.js";
import { helpGuides, whatsNew, featureTours } from "../../core/help/catalog.js";
import { projectReadiness, starterPrompts } from "../../core/help/readiness.js";
import { examples, installExample } from "../../core/help/examples.js";
import { assertDemo, lessons, runScenario, scenarioNames } from "../../core/help/scenarios.js";
import { readTriggers } from "../../core/triggers.js";
import { providerGuideStep, testedProvider } from "../../core/help/provider.js";

export function registerHelpRoutes(app: Express, ctx: Pick<RouteContext, "runtime">, withRuntime: WithRuntime) {
  const projectAction: WithRuntime = handler => withRuntime(async (rt, req, res) => {
    try { await handler(rt, req, res); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  const owner: RequestHandler = (req, res, next) => {
    const who = req as Request & { guest?: unknown; projectScope?: string[] | null };
    if (who.guest || who.projectScope) return void res.status(403).json({ error: "requires an owner or unscoped device" });
    next();
  };
  const action = (fn: (req: Request) => unknown | Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  };
  app.get("/api/help", (req, res) => res.json({ guides: helpGuides(String(req.query.q ?? "")), tours: featureTours }));
  app.get("/api/help/whatsnew", (_req, res) => res.json(whatsNew()));
  app.get("/api/help/examples", (_req, res) => res.json({ examples }));
  app.get("/api/help/tutorial", (_req, res) => res.json({ lessons }));
  app.post("/api/help/examples/:name/install", owner, action(req => {
    const name = String(req.params.name);
    if (examples.find(e => e.name === name)?.kind === "trigger") throw new Error("install trigger examples through the project route");
    return installExample(name);
  }));
  app.post("/api/help/provider/:step", owner, action(async req => {
    if (req.params.step !== "agent") return providerGuideStep(String(req.params.step), req.body ?? {});
    const b = req.body ?? {};
    if (typeof b.provider !== "string" || typeof b.project !== "string") throw new Error("provider and project are required");
    const state = testedProvider(b.provider);
    if (!state.model) throw new Error("pick the default model first");
    const rt = await ctx.runtime(b.project);
    const agent = rt.config.agents.find(a => a.kind === "model" && a.options?.model === "default")
      ?? rt.addAgent("model", { options: { model: "default" } });
    rt.patchConfig({ defaultAgent: agent.id });
    return { step: "done", agent, model: state.model, project: rt.info.id };
  }));
  app.get("/api/projects/:id/ready", projectAction(async (rt, _req, res) => { res.json(await projectReadiness(rt.info.dir)); }));
  app.post("/api/projects/:id/ready", projectAction(async (rt, req, res) => {
    if (req.body?.fix !== true) return void res.status(400).json({ error: "send { fix: true } to apply the offered fixes" });
    res.json(await projectReadiness(rt.info.dir, true));
  }));
  app.get("/api/projects/:id/starter-prompts", projectAction(async (rt, _req, res) => { res.json(await starterPrompts(rt.info.dir)); }));
  app.post("/api/projects/:id/examples/:name/install", owner, projectAction(async (rt, req, res) => {
    if (examples.find(e => e.name === req.params.name)?.kind !== "trigger") return void res.status(400).json({ error: "machine-wide examples use /api/help/examples/:name/install" });
    if (readTriggers(rt.info.dir).triggers.length >= 50) return void res.status(400).json({ error: "50 triggers per project is the limit" });
    res.json(installExample(String(req.params.name), rt.info.dir));
  }));
  app.get("/api/projects/:id/demo-scenarios", (_req, res) => res.json({ scenarios: scenarioNames }));
  app.post("/api/projects/:id/demo-scenarios/:scenario", projectAction(async (rt, req, res) => { res.json(await runScenario(rt, String(req.params.scenario))); }));
  app.post("/api/projects/:id/tutorial/:lesson", projectAction(async (rt, req, res) => {
    assertDemo(rt);
    const lesson = String(req.params.lesson);
    if (lesson === "fleet" || lesson === "memory") return void res.json(await runScenario(rt, lesson));
    if (lesson !== "send" && lesson !== "steer") return void res.status(400).json({ error: "unknown lesson" });
    if (rt.anyBusy()) throw new Error("wait for the current demo work to finish");
    const agent = rt.config.agents[0]!.id;
    const chat = rt.createChat(`Tutorial · ${lesson}`);
    await rt.handoff(agent, { chat: chat.id });
    const turn = await rt.sendMessage(lesson === "send" ? "Add dark mode" : "Write tests", agent, { chat: chat.id });
    const steer = lesson === "steer" ? await rt.steerMessage("Also cover an empty list", agent, { chat: chat.id }) : undefined;
    res.json({ chat: chat.id, turn, ...(steer ? { steer } : {}) });
  }));
}
