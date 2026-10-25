import type { Express, Request } from "express";
import {
  newSecret,
  newTriggerId,
  nextFire,
  parseCron,
  parseEvery,
  publicTrigger,
  readTriggers,
  verifyDelivery,
  writeTriggers,
  type Trigger,
} from "../../core/triggers.js";
import { findWebhook, type TriggerRunner } from "../triggers.js";
import type { WithRuntime } from "./context.js";

const isAdmin = (req: Request) => Boolean((req as Request & { isAdmin?: boolean }).isAdmin);

/** What a client may set on a trigger, checked; throws with a message a person can act on. */
function patchFrom(b: Record<string, unknown>, kind: Trigger["kind"]): Partial<Trigger> {
  const out: Partial<Trigger> = {};
  if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 80) || "trigger";
  if (b.prompt !== undefined) {
    const p = String(b.prompt).trim();
    if (!p) throw new Error("a trigger needs a prompt");
    out.prompt = p.slice(0, 20_000);
  }
  if (b.agent !== undefined) out.agent = b.agent ? String(b.agent) : undefined;
  if (b.enabled !== undefined) out.enabled = Boolean(b.enabled);
  if (kind === "schedule") {
    if (b.cron) { parseCron(String(b.cron)); out.cron = String(b.cron).trim(); out.everyMin = undefined; }
    if (b.every) { out.everyMin = parseEvery(String(b.every)); out.cron = undefined; }
  }
  if (kind === "webhook" && b.minIntervalSec !== undefined) {
    const n = Number(b.minIntervalSec);
    if (!(n >= 0)) throw new Error("minIntervalSec is a number of seconds");
    out.minIntervalSec = n || undefined;
  }
  return out;
}

/** Triggers: schedules and webhooks that start a turn on their own (core/triggers.ts). */
export function registerTriggerRoutes(app: Express, withRuntime: WithRuntime, runner: TriggerRunner): void {
  app.get("/api/projects/:id/triggers", withRuntime(async (rt, _req, res) => {
    const { triggers, runs } = readTriggers(rt.info.dir);
    res.json({ triggers: triggers.map((t) => ({ ...publicTrigger(t), nextAt: nextFire(t) })), runs: runs.slice(-50).reverse() });
  }));

  // A trigger runs this machine's agents as you, unattended: only the owner makes or changes one.
  app.post("/api/projects/:id/triggers", withRuntime(async (rt, req, res) => {
    if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can add a trigger" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "webhook" ? "webhook" : "schedule";
    let patch: Partial<Trigger>;
    try { patch = patchFrom(b, kind); } catch (e) { return void res.status(400).json({ error: (e as Error).message }); }
    if (!patch.prompt) return void res.status(400).json({ error: "a trigger needs a prompt" });
    if (kind === "schedule" && !patch.cron && !patch.everyMin) return void res.status(400).json({ error: "a schedule needs cron or every (e.g. every: \"30m\")" });
    if (patch.agent && !rt.config.agents.some((a) => a.id === patch.agent)) return void res.status(400).json({ error: `no agent "${patch.agent}" in this project` });
    const secret = kind === "webhook" ? newSecret() : undefined;
    const t: Trigger = { id: newTriggerId(), name: patch.name ?? (kind === "webhook" ? "webhook" : "schedule"), kind, prompt: patch.prompt,
      ...patch, ...(secret ? { secret } : {}), enabled: patch.enabled ?? true, createdAt: Date.now() };
    const data = readTriggers(rt.info.dir);
    if (data.triggers.length >= 50) return void res.status(400).json({ error: "50 triggers per project is the limit" });
    data.triggers.push(t);
    writeTriggers(rt.info.dir, data);
    // the secret is shown this once; after this only its existence is
    res.json({ trigger: { ...publicTrigger(t), nextAt: nextFire(t) }, ...(secret ? { secret, path: `/api/webhooks/trigger/${t.id}` } : {}) });
  }));

  app.patch("/api/projects/:id/triggers/:tid", withRuntime(async (rt, req, res) => {
    if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can change a trigger" });
    const data = readTriggers(rt.info.dir);
    const t = data.triggers.find((x) => x.id === req.params.tid);
    if (!t) return void res.status(404).json({ error: "no such trigger" });
    try { Object.assign(t, patchFrom((req.body ?? {}) as Record<string, unknown>, t.kind)); } catch (e) { return void res.status(400).json({ error: (e as Error).message }); }
    writeTriggers(rt.info.dir, data);
    res.json({ trigger: { ...publicTrigger(t), nextAt: nextFire(t) } });
  }));

  app.delete("/api/projects/:id/triggers/:tid", withRuntime(async (rt, req, res) => {
    if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can remove a trigger" });
    const data = readTriggers(rt.info.dir);
    const left = data.triggers.filter((x) => x.id !== req.params.tid);
    if (left.length === data.triggers.length) return void res.status(404).json({ error: "no such trigger" });
    writeTriggers(rt.info.dir, { ...data, triggers: left });
    res.json({ removed: true });
  }));

  // Fire one now — to try it, or because you want it now. A webhook's can carry a test payload.
  app.post("/api/projects/:id/triggers/:tid/fire", withRuntime(async (rt, req, res) => {
    if (!isAdmin(req)) return void res.status(403).json({ error: "only this machine's owner can fire a trigger" });
    const b = (req.body ?? {}) as { payload?: unknown };
    const run = await runner.fire(rt.info.id, rt.info.dir, String(req.params.tid), { kind: "manual", ...(b.payload !== undefined ? { body: b.payload } : {}) });
    res.status(run.note === "no such trigger" ? 404 : 200).json({ run });
  }));

  // The webhook itself: past the bearer wall (server.ts lets /api/webhooks/ through), so it proves
  // itself with the trigger's secret. Unknown and disabled look the same: 404.
  app.post("/api/webhooks/trigger/:tid", (req, res) => {
    void (async () => {
      const hit = findWebhook(String(req.params.tid));
      if (!hit || !hit.trigger.enabled || !hit.trigger.secret) return void res.status(404).json({ error: "not found" });
      const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      if (!verifyDelivery(hit.trigger.secret, raw, req.headers, typeof req.query.token === "string" ? req.query.token : undefined)) {
        return void res.status(401).json({ error: "bad signature" });
      }
      const event = String(req.headers["x-github-event"] ?? req.headers["x-gitlab-event"] ?? req.headers["x-event-type"] ?? "");
      const delivery = String(req.headers["x-github-delivery"] ?? req.headers["x-request-id"] ?? req.headers["x-delivery-id"] ?? "") || undefined;
      const run = await runner.fire(hit.projectId, hit.dir, hit.trigger.id, { kind: "webhook", body: req.body ?? {}, event, ...(delivery ? { delivery } : {}) });
      // a skipped delivery is still a 200: the sender did nothing wrong and shouldn't retry
      res.json({ ok: run.ok, note: run.note });
    })().catch((e) => res.status(500).json({ error: (e as Error).message }));
  });
}
