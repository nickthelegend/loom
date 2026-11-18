import { withDigestComparison, type Digest } from "../../core/digest.js";
import type { Express, Request } from "express";
import { listProjects } from "../../core/registry.js";
import type { Server } from "node:http";
import type { ProjectRuntime } from "../runtime.js";
import type { RouteContext, WithRuntime } from "./context.js";
import { isShellTool, toolAnalytics, turns, latency, approvalInsights, failureGroups, comparison, duration, sinceTime, agentHours, hoursCsv, fileHotspots } from "../../observability/r4/analytics.js";
import { addRule, readRules, writeRules, evaluateRule } from "../../observability/r4/alerts.js";
import { checkRules, ruleRows, deliverAlert, observeRuntime, rewindPaths } from "../../observability/r4/runtime.js";

export function registerInsightsR4(app: Express, withRuntime: WithRuntime, ctx: Pick<RouteContext, "runtime" | "runtimes">, server: () => Server | null | undefined): void {
  let stopped = false;
  const attached = new Map<ProjectRuntime, () => void>();
  const checks = new Map<ProjectRuntime, { dirty: boolean; lastCheck: number }>();
  const attach = (rt: ProjectRuntime) => {
    if (stopped || attached.has(rt)) return;
    const state = { dirty: true, lastCheck: 0 }; checks.set(rt, state);
    const offObserve = observeRuntime(rt);
    const offEvent = rt.log.onEvent(e => {
      if (e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && e.payload.state === "interrupted")) state.dirty = true;
    });
    const offQueue = rt.onQueueChange(() => { state.dirty = true; });
    attached.set(rt, () => { offObserve(); offEvent(); offQueue(); checks.delete(rt); });
  };
  const dirty = (rt: ProjectRuntime) => { attach(rt); const state = checks.get(rt); if (state) state.dirty = true; };
  let hooked = false, lastRestore = 0;
  const opening = new Set<string>();
  const dispose = () => { stopped = true; clearInterval(timer); for (const off of attached.values()) off(); attached.clear(); };
  const timer = setInterval(() => {
    if (!hooked && server()) {
      if (!server()!.listening) { dispose(); return; }
      hooked = true; server()!.once("close", dispose);
    }
    if (server()?.listening && Date.now() - lastRestore >= 30_000) {
      lastRestore = Date.now();
      for (const project of listProjects()) {
        if (ctx.runtimes.has(project.id) || opening.has(project.id)) continue;
        try {
          if (!readRules(project.id).some(r => !r.paused)) continue;
          opening.add(project.id);
          void ctx.runtime(project.id).then(attach).catch(() => {}).finally(() => opening.delete(project.id));
        } catch { /* A removed project must not stop the other rules. */ }
      }
    }
    for (const [rt, off] of attached) if (ctx.runtimes.get(rt.info.id) !== rt) { off(); attached.delete(rt); }
    for (const rt of ctx.runtimes.values()) {
      attach(rt);
      const state = checks.get(rt)!;
      const now = Date.now();
      if (state.dirty || now - state.lastCheck >= 60_000) {
        state.dirty = false; state.lastCheck = now;
        try { checkRules(rt, now); } catch { /* A closing project or unavailable disk must not stop other projects. */ }
      }
    }
  }, 1000);
  timer.unref();
  // Attach before send, including the first turn in a newly opened project.
  app.use("/api/projects/:id/messages", (req, _res, next) => {
    if (req.method !== "POST") { next(); return; }
    void ctx.runtime(String(req.params.id)).then(rt => { attach(rt); next(); }, () => next());
  });
  app.get("/api/projects/:id/digest", (req, res, next) => {
    void ctx.runtime(String(req.params.id)).then(rt => {
      const send = res.json.bind(res);
      // The existing route bounds narrative events to 4,000. Comparison needs both full periods.
      res.json = body => send(body && typeof body.since === "number" && Array.isArray(body.lines)
        ? withDigestComparison(body as Digest, rt.log.list()) : body);
      next();
    }, () => next());
  });
  const owner = (req: Request) => { const r = req as Request & { guest?: unknown; projectScope?: string[] | null }; return !r.guest && !r.projectScope; };
  const route = (handler: Parameters<WithRuntime>[0]) => withRuntime(async (rt, req, res) => {
    try { await handler(rt, req, res); } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  const base = "/api/projects/:id";
  for (const name of ["tools", "latency", "approvals", "errors", "compare", "files", "hours", "r4"]) {
    app.get(`${base}/insights/${name}`, route(async (rt, req, res) => {
      const now = Date.now(), events = rt.log.list(), rows = turns(events), since = sinceTime(req.query.since ? String(req.query.since) : undefined, now);
      const agent = req.query.agent ? String(req.query.agent) : undefined;
      const filtered = events.filter(e => e.ts >= since && (!agent || e.agentId === agent));
      const selected = rows.filter(r => r.end >= since && (!agent || r.agent === agent));
      const result: Record<string, unknown> = {};
      if (name === "tools" || name === "r4") result.tools = toolAnalytics(events, { since, agent });
      if (name === "latency" || name === "r4") result.latency = latency(selected);
      if (name === "approvals" || name === "r4") result.approvals = { ...approvalInsights(events, now, { since, agent }), canAddAllowRule: owner(req) };
      if (name === "errors" || name === "r4") result.errors = failureGroups(selected).map(group => ({ ...group, examples: group.examples.map(example => ({ ...example, href: `/app#p/${encodeURIComponent(rt.info.id)}/c/${encodeURIComponent(example.chat)}/m/${example.eventId}` })) }));
      if (name === "compare" || name === "r4") result.compare = comparison(agent ? events.filter(e => e.agentId === agent) : events, duration(String(req.query.period ?? "7d")), now);
      if (name === "hours" || name === "r4") {
        const liveAgents = new Set((await rt.status()).agents.filter(a => a.busy).map(a => a.id));
        const hours = agentHours(turns(events, now, liveAgents).filter(r => r.end >= since && (!agent || r.agent === agent)).map(r => ({ ...r, start: Math.max(r.start, since) })), rt.info.id);
        if (req.query.format === "csv" && name === "hours") { res.type("text/csv").setHeader("Content-Disposition", 'attachment; filename="agent-hours.csv"'); res.send(hoursCsv(hours)); return; }
        result.hours = hours;
      }
      if (name === "files" || name === "r4") {
        const enriched = [...filtered]; let unavailableRewinds = 0;
        const known = new Set(events.filter(e => e.payload.state === "r4_rewind_files").map(e => e.payload.rewindEventId));
        for (const e of filtered.filter(e => e.kind === "checkpoint" && e.payload.reason === "rewound" && !e.payload.path && !known.has(e.id))) {
          const paths = await rewindPaths(rt, String(e.payload.id), String(e.payload.undo)).catch(() => null);
          if (paths) enriched.push({ ...e, kind: "status", payload: { state: "r4_rewind_files", paths } }); else unavailableRewinds++;
        }
        result.files = { rows: fileHotspots(enriched), unavailableRewinds };
      }
      res.json(result);
    }));
  }
  app.post(`${base}/insights/approvals/allow`, route(async (rt, req, res) => {
    if (!owner(req)) { res.status(403).json({ error: "Allow rules require the owner or an unscoped paired device." }); return; }
    const example = rt.log.list({ kinds: ["approval"] }).find(e => e.id === req.body?.eventId && e.payload.phase === "requested");
    if (!example || typeof example.payload.tool !== "string" || /[*?\r\n\0]/.test(example.payload.tool)) { res.status(400).json({ error: "choose a recorded approval with a literal tool name" }); return; }
    const tool = example.payload.tool;
    if (isShellTool(tool)) { res.status(400).json({ error: "Shell tools cannot be allow-listed by command; use Safety settings." }); return; }
    const policy = rt.safetyPolicy();
    res.json({ policy: rt.setSafetyPolicy({ ...policy, allow: [...new Set([...policy.allow, tool])] }), tool });
  }));
  app.get(`${base}/events/query`, route(async (rt, req, res) => {
    const since = sinceTime(req.query.since ? String(req.query.since) : undefined);
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit), before = req.query.before === undefined ? undefined : Number(req.query.before);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (before !== undefined && (!Number.isInteger(before) || before < 1))) throw new Error("limit must be 1–500; before must be a positive event id");
    const types = req.query.type ? String(req.query.type).split(",") : undefined;
    const matches = rt.log.list({ sinceTs: since, ...(req.query.agent ? { agentId: String(req.query.agent) } : {}), ...(before ? { before } : {}) }).filter(e => (!types || types.includes(e.kind)) && (!req.query.id || String(e.id) === String(req.query.id)));
    const events = matches.slice(-limit).reverse();
    res.json({ events, nextBefore: matches.length > limit ? events.at(-1)!.id : null });
  }));
  app.get(`${base}/alerts`, route(async (rt, _req, res) => { res.json({ rules: readRules(rt.info.id) }); }));
  app.post(`${base}/alerts`, route(async (rt, req, res) => { const rule = addRule(rt.info.id, String(req.body?.expression ?? "")); dirty(rt); res.status(201).json({ rule }); }));
  app.patch(`${base}/alerts/:ruleId`, route(async (rt, req, res) => {
    if (typeof req.body?.paused !== "boolean") throw new Error("paused must be boolean");
    const rules = readRules(rt.info.id), rule = rules.find(r => r.id === req.params.ruleId);
    if (!rule) { res.status(404).json({ error: "no such alert rule" }); return; }
    rule.paused = req.body.paused; writeRules(rt.info.id, rules); dirty(rt); res.json({ rule });
  }));
  app.delete(`${base}/alerts/:ruleId`, route(async (rt, req, res) => {
    const rules = readRules(rt.info.id); if (!rules.some(r => r.id === req.params.ruleId)) { res.status(404).json({ error: "no such alert rule" }); return; }
    writeRules(rt.info.id, rules.filter(r => r.id !== req.params.ruleId)); res.json({ ok: true });
  }));
  app.post(`${base}/alerts/:ruleId/test`, route(async (rt, req, res) => {
    const rule = readRules(rt.info.id).find(r => r.id === req.params.ruleId);
    if (!rule) { res.status(404).json({ error: "no such alert rule" }); return; }
    const now = Date.now();
    const result = evaluateRule(rule, ruleRows(rt, [rule], now)(rule), rt.queue.snapshot().items.length, now);
    deliverAlert(rt, rule, result.value, true); res.json({ ...result, test: true });
  }));
}
