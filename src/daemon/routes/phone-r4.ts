import { registerPendingApprovals, wasApprovalHeld } from "../../core/phone-r4/held-approvals.js";
import type { Express, Request } from "express";
import os from "node:os";
import { bearerToken } from "../auth.js";
import { listProjects } from "../../core/registry.js";
import { preferences, setQuiet, setLevel, chatKey, quietNow } from "../../core/phone-r4/preferences.js";
import { briefTotals, goalRows, waitingQuestions, type NowRow } from "../../core/phone-r4/activity.js";
import { nextCron, parseCron, parseEvery } from "../../core/triggers.js";
import { buildBoard } from "../board.js";
import type { RouteContext } from "./context.js";

const nowCache = new Map<string, { at: number; rows: NowRow[] }>();
const briefCache = new Map<string, { at: number; response: Promise<unknown> }>();
type AuthRequest = Request & { isAdmin?: boolean; guest?: unknown; projectScope?: string[] | null };
export function registerPhoneRoutes(app: Express, ctx: RouteContext): void {
  registerPendingApprovals((project, id) => { const a = ctx.approvals.get(id); return !!a && a.projectId === project && (!a.expiresAt || a.expiresAt > Date.now()); }, (project, id) => {
    void ctx.runtime(project).then(rt => { rt.log.append({ kind: "approval", payload: { phase: "push_held", approvalId: id } }); }).catch(() => {});
  });
  app.get("/api/phone/capabilities", (req, res) => { const r = req as AuthRequest; res.json({ owner: !r.guest && !r.projectScope }); });
  app.use(["/api/push/quiet", "/api/projects/:id/chats/:chat/notification-level"], (req, res, next) => {
    if (req.query.device === undefined) return void next();
    const own = ctx.auth.clientFor(bearerToken(req.headers.authorization))?.id;
    const r = req as AuthRequest;
    if (r.projectScope && req.query.device !== own) return void res.status(403).json({ error: "this device may change only its own notification preferences" });
    if (typeof req.query.device !== "string" || !ctx.auth.clients().some(c => c.id === req.query.device)) return void res.status(404).json({ error: "unknown paired device" });
    next();
  });
  const device = (req: Request) => typeof req.query.device === "string" ? req.query.device : ctx.auth.clientFor(bearerToken(req.headers.authorization))?.id ?? "owner";
  app.get("/api/push/quiet", (req, res) => { res.json({ quiet: preferences(device(req)).quiet }); });
  app.put("/api/push/quiet", (req, res) => {
    try { res.json({ quiet: setQuiet(device(req), req.body) }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get("/api/projects/:id/chats/:chat/notification-level", async (req, res) => {
    const rt = await ctx.runtime(String(req.params.id));
    res.json({ level: preferences(device(req)).chats[chatKey(rt.info.id, String(req.params.chat))] ?? "all" });
  });
  app.put("/api/projects/:id/chats/:chat/notification-level", async (req, res) => {
    const rt = await ctx.runtime(String(req.params.id));
    if (!rt.chats().some(c => c.id === req.params.chat)) return void res.status(404).json({ error: "unknown chat" });
    try { res.json({ level: setLevel(device(req), rt.info.id, String(req.params.chat), req.body?.level) }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get("/api/phone/now", async (req, res) => {
    const rows: NowRow[] = [], errors: Array<{ projectId: string; error: string }> = [];
    const scope = (req as AuthRequest).projectScope;
    for (const p of listProjects().filter(p => !scope || scope.includes(p.id))) {
      try {
        const rt = await ctx.runtime(p.id), status = await rt.status();
        const base = { projectId: p.id, project: p.name };
        for (const a of status.agents.filter(a => a.busy)) rows.push({ ...base, id: `running:${a.id}`, chat: (a as typeof a & { chat?: string }).chat ?? "main", kind: "running", title: `${a.id} is running` });
        // Cache the expensive history scan; live approvals and running state stay fresh.
        let cached = nowCache.get(p.id);
        if (!cached || Date.now() - cached.at >= 5000) {
          const recent: NowRow[] = [];
          for (const e of waitingQuestions(rt.log.list({ kinds: ["needs_input", "message", "status"], activeLineages: true, sinceTs: Date.now() - 7 * 24 * 3600000 }))) recent.push({ ...base, id: `question:${e.id}`, chat: e.chat ?? "main", kind: "needs-you", title: String(e.payload.question ?? "Needs you") });
          const approvals = rt.log.list({ kinds: ["approval"], sinceTs: Date.now() - 24 * 3600000 });
          const heldIds = new Set(approvals.filter(e => e.payload.phase === "push_held").map(e => e.payload.approvalId));
          for (const e of approvals) {
            const v = e.payload;
            if (v.phase === "decided" && v.behavior === "deny" && String(v.message ?? "").startsWith("No answer within")) recent.push({ ...base, id: `missed:${v.approvalId}`, kind: "approval", chat: e.chat ?? "main", title: `${e.agentId}: ${v.tool} timed out unanswered${(heldIds.has(v.approvalId) || wasApprovalHeld(p.id, String(v.approvalId))) ? " · timed out while quiet" : ""}` });
          }
          cached = { at: Date.now(), rows: recent }; nowCache.set(p.id, cached);
        }
        rows.push(...cached.rows);
        rows.push(...goalRows(p.id, p.name, rt.orchestra.list(), rt.crews.list()));
        const q = preferences(device(req)).quiet, held = quietNow(q) && !q.allowApprovals;
        for (const a of ctx.approvals.values()) if (a.projectId === p.id) rows.push({ ...base, id: a.id, chat: a.chat ?? "main", kind: "approval", expiresAt: a.expiresAt, held, title: `${a.agent}: ${a.tool}${held ? " · held during quiet hours" : ""}${a.expiresAt ? ` · answer by ${new Date(a.expiresAt).toISOString()}` : ""}` });
      } catch (e) { errors.push({ projectId: p.id, error: (e as Error).message }); }
    }
    res.json({ machine: os.hostname(), rows, errors });
  });
  app.get("/api/projects/:id/phone/brief", async (req, res) => {
    const start = Number(req.query.start), end = Number(req.query.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 26 * 3600000) return void res.status(400).json({ error: "start and end must bound yesterday" });
    const rt = await ctx.runtime(String(req.params.id));
    const key = JSON.stringify([rt.info.id, start, end]);
    // Prune expired windows and share the in-flight request across callers too.
    for (const [k, v] of briefCache) if (Date.now() - v.at >= 10 * 60000) briefCache.delete(k);
    let cached = briefCache.get(key);
    if (!cached) {
      const response = (async () => {
        const board = await buildBoard(rt.info.dir, [], []);
        return { ...briefTotals(rt.log.list({ kinds: ["run_complete", "status"], sinceTs: start }), start, end), prs: board.cards.filter(c => c.pr && c.pr.state === "open"), ...(board.ghError ? { prError: board.ghError.detail } : {}) };
      })();
      cached = { at: Date.now(), response }; briefCache.set(key, cached);
      void response.catch(() => { if (briefCache.get(key)?.response === response) briefCache.delete(key); });
    }
    res.json(await cached.response);
  });
  app.post("/api/projects/:id/phone/trigger-preview", (req, res) => {
    try {
      const runs: number[] = []; let at = Date.now();
      const interval = req.body?.every ? parseEvery(String(req.body.every)) * 60000 : 0;
      const cron = interval ? null : parseCron(String(req.body?.cron ?? ""));
      for (let i = 0; i < 5; i++) { const next = interval ? at + interval : nextCron(cron!, new Date(at))?.getTime(); if (!next) break; runs.push(next); at = next; }
      res.json({ runs, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // Reuse the existing trigger validation and persistence. Only these two owner
  // operations opt into phone editing; legacy clients keep their contract,
  // and no other admin capability is elevated. The flag is not authorization.
  app.use((req, res, next) => {
    const r = req as AuthRequest;
    if (req.body?.phoneEditor === true && !r.guest && !r.projectScope && ((req.method === "POST" && /^\/api\/projects\/[^/]+\/triggers\/?$/.test(req.path)) || (req.method === "PATCH" && /^\/api\/projects\/[^/]+\/triggers\/[^/]+\/?$/.test(req.path)))) {
      const before = r.isAdmin; r.isAdmin = true;
      res.once("finish", () => { r.isAdmin = before; });
    }
    next();
  });
}
