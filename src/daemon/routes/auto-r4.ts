import type { Express, Request } from "express";
import type { WithRuntime, RouteContext } from "./context.js";
import type { TriggerRunner } from "../triggers.js";
import { readTriggers, writeTriggers, publicTrigger, nextFire, parseEvery } from "../../core/triggers.js";
import { automationTrigger } from "../../core/auto-r4/validation.js";
import { schedulePreview } from "../../core/auto-r4/model.js";
import { readAutomation, changeAutomation, readControl, writeControl, parseQuiet, automationHold } from "../../core/auto-r4/state.js";
import { addWebhook, readWebhooks, writeWebhooks, resendWebhook } from "../../core/auto-r4/webhooks.js";
import { listOrchestraRecipes } from "../../core/orchestra-options.js";

const admin = (req: Request) => Boolean((req as Request & { isAdmin?: boolean }).isAdmin);
const owner = (req: Request) => {
  const r = req as Request & { isAdmin?: boolean; guest?: unknown; projectScope?: string[] | null };
  return !r.guest && (Boolean(r.isAdmin) || !r.projectScope);
};

export function registerAutomationRoutes(app: Express, withRuntime: WithRuntime, runner: TriggerRunner, ctx: RouteContext): void {
  runner.setOpenRuntimes(() => ctx.runtimes.values());
  const base = "/api/projects/:id/automation";
  app.get(base, withRuntime(async (rt, req, res) => {
    const state = readAutomation(rt.info.dir), data = readTriggers(rt.info.dir), control = readControl();
    const heldQueue = rt.queue.snapshot().items.filter(i => (i.automation || i.when?.kind === "at") && automationHold()).length;
    res.json({ ...data, triggers: data.triggers.map(t => ({ ...publicTrigger(t), nextAt: nextFire(t) })),
      control: owner(req) ? control : { quiet: Boolean(control.quiet), paused: Boolean(control.paused) }, canEditTriggers: admin(req), hold: automationHold(), held: state.held.length + heldQueue, owner: owner(req), ...readWebhooks(rt.info.dir) });
  }));
  app.post(base + "/preview", withRuntime(async (_rt, req, res) => {
    try { res.json(schedulePreview(String(req.body?.when ?? ""))); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));
  for (const method of ["post", "patch"] as const) app[method](base + "/triggers" + (method === "patch" ? "/:tid" : ""), withRuntime(async (rt, req, res) => {
    const pauseOnly = method === "patch" && Object.keys(req.body ?? {}).length === 1 && typeof req.body.enabled === "boolean";
    if (!admin(req) && !(pauseOnly && owner(req))) return void res.status(403).json({ error: "only the machine owner can configure triggers; their own phone can pause or resume" });
    try {
      let data = readTriggers(rt.info.dir);
      const prior = data.triggers.find(t => t.id === req.params.tid);
      if (method === "patch" && !prior) return void res.status(404).json({ error: "no such trigger" });
      const trigger = automationTrigger(req.body ?? {}, prior);
      if (trigger.agent && !rt.config.agents.some(a => a.id === trigger.agent)) throw new Error("no such agent");
      if (trigger.recipe && !listOrchestraRecipes().some(r => r.name === trigger.recipe)) throw new Error("no such Orchestra recipe");
      if (trigger.route && !rt.config.routes?.[trigger.route]) throw new Error("no such saved route");
      if (!prior && data.triggers.length >= 50) throw new Error("50 triggers per project is the limit");
      if (!prior || prior.onChange !== trigger.onChange || prior.onCommit !== trigger.onCommit) await runner.prepare(rt, trigger);
      data = readTriggers(rt.info.dir);
      if (!prior && data.triggers.length >= 50) throw new Error("50 triggers per project is the limit");
      const inactive = !data.triggers.length && !readWebhooks(rt.info.dir).webhooks.length;
      if (prior) {
        const index = data.triggers.findIndex(t => t.id === prior.id);
        if (index < 0) throw new Error("trigger was removed while preparing the watch");
        data.triggers[index] = trigger;
      } else data.triggers.push(trigger);
      writeTriggers(rt.info.dir, data);
      changeAutomation(rt.info.dir, s => { if (inactive) s.cursor = rt.log.lastId(); else s.cursor ??= rt.log.lastId(); if (prior?.watchUrl !== trigger.watchUrl || prior?.select !== trigger.select) delete s.watches[trigger.id]; });
      res.json({ trigger: { ...publicTrigger(trigger), nextAt: nextFire(trigger) }, ...(!prior && trigger.secret ? { secret: trigger.secret, path: `/api/webhooks/trigger/${trigger.id}` } : {}) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));
  app.delete(base + "/triggers/:tid", withRuntime(async (rt, req, res) => {
    if (!admin(req)) return void res.status(403).json({ error: "only the machine owner can remove triggers" });
    const data = readTriggers(rt.info.dir), trigger = data.triggers.find(t => t.id === req.params.tid);
    if (!trigger) return void res.status(404).json({ error: "no such trigger" });
    data.triggers = data.triggers.filter(t => t.id !== trigger.id); writeTriggers(rt.info.dir, data);
    changeAutomation(rt.info.dir, s => { s.held = s.held.filter(h => h.trigger !== trigger.id); delete s.watches[trigger.id]; delete s.pending[trigger.id]; });
    res.json({ removed: true });
  }));
  app.post(base + "/triggers/:tid/fire", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner may run triggers" });
    const run = await runner.fire(rt.info.id, rt.info.dir, String(req.params.tid), { kind: "manual", body: req.body?.payload });
    res.status(run.note === "no such trigger" ? 404 : 200).json({ run });
  }));
  app.post(base + "/webhooks", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner may configure outgoing webhooks" });
    try {
      const inactive = !readTriggers(rt.info.dir).triggers.length && !readWebhooks(rt.info.dir).webhooks.length;
      if (!Array.isArray(req.body?.events)) throw new Error("events must be an array");
      const webhook = addWebhook(rt.info.dir, String(req.body.url), req.body.events);
      changeAutomation(rt.info.dir, s => { if (inactive) s.cursor = rt.log.lastId(); else s.cursor ??= rt.log.lastId(); });
      res.json({ webhook });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  }));
  app.delete(base + "/webhooks/:wid", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner may remove outgoing webhooks" });
    const state = readWebhooks(rt.info.dir); state.webhooks = state.webhooks.filter(w => w.id !== req.params.wid); writeWebhooks(rt.info.dir, state); res.json({ removed: true });
  }));
  app.post(base + "/deliveries/:did/resend", withRuntime(async (rt, req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner may resend outgoing webhooks" });
    try { res.json({ delivery: resendWebhook(rt.info.dir, String(req.params.did)) }); }
    catch (e) { res.status(404).json({ error: (e as Error).message }); }
  }));
  app.get("/api/automation", (req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner may read machine automation controls" });
    res.json({ control: readControl(), hold: automationHold() });
  });
  app.put("/api/automation", (req, res) => {
    if (!owner(req)) return void res.status(403).json({ error: "only the owner may change machine automation controls" });
    try {
      const control = readControl(), b = req.body ?? {};
      if (b.quiet !== undefined) { if (b.quiet === "off") delete control.quiet; else control.quiet = parseQuiet(String(b.quiet), b.days === undefined ? undefined : String(b.days)); }
      if (b.paused !== undefined) {
        if (typeof b.paused !== "boolean") throw new Error("paused must be a boolean");
        control.paused = b.paused; control.resumeAt = b.paused && b.for ? Date.now() + parseEvery(String(b.for)) * 60_000 : undefined;
      }
      writeControl(control);
      for (const rt of ctx.runtimes.values()) void rt.drainPromptQueue();
      res.json({ control, hold: automationHold() });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
}
