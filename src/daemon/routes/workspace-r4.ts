import { dormantState } from "../../core/workspace-r4/paused.js";
import type { ProjectRuntime } from "../runtime.js";
import type { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listProjects } from "../../core/registry.js";
import { chatFiles, safeRelative, type InboxItem } from "../../core/workspace-r4/projections.js";
import { changePreferences, dismiss, notes, preferences, saveNotes, WorkspaceConflict } from "../../core/workspace-r4/store.js";
import { liveWorkspace } from "../../core/workspace-r4/live.js";
import type { RouteContext, WithRuntime } from "./context.js";

type Context = Pick<RouteContext, "runtimes" | "approvals">;
const scopeOf = (req: Request) => (req as Request & { projectScope?: string[] | null }).projectScope;
const error = (res: Response, e: unknown) => void res.status(e instanceof WorkspaceConflict ? 409 : 400).json({ error: e instanceof z.ZodError ? e.issues.map(i => i.message).join("; ") : e instanceof Error ? e.message : String(e) });

function liveInChat(rt: ProjectRuntime, chat: string) {
  const seen = new Set<string>();
  for (const e of [...(liveWorkspace(rt.log).chats.get(chat)?.workers.values() ?? [])].reverse()) {
    if (!e.agentId || seen.has(e.agentId) || (!e.payload.orchestra && !e.payload.crew)) continue;
    seen.add(e.agentId);
    if (e.kind === "run_complete" || e.kind === "error" || e.kind === "status" && ["interrupted", "stopped"].includes(String(e.payload.state))) continue;
    const agent = rt.orchestra.liveAgent(e.agentId) ?? rt.crews.liveAgent(String(e.payload.askAgent ?? e.agentId));
    if (agent?.busy()) return agent;
  }
  return null;
}

export function mission(ctx: Context, scope?: string[] | null) {
  const now = Date.now();
  const chats = [];
  for (const rt of ctx.runtimes.values()) {
    if (scope && !scope.includes(rt.info.id)) continue;
    const activity = rt.activity() as { agents: Array<{ id: string; busy: boolean; since: number | null; chat: string | null; chatTitle: string | null; last: { line: string } | null }> };
    const rows = new Map<string, { chat: string; title: string; since: number; agents: string[]; lastLine: string; costUsd: number | null }>();
    for (const a of activity.agents.filter(a => a.busy)) {
      const chat = a.chat ?? "main", row = rows.get(chat) ?? { chat, title: a.chatTitle ?? chat, since: a.since ?? now, agents: [], lastLine: a.last?.line ?? "", costUsd: null };
      row.agents.push(a.id); row.since = Math.min(row.since, a.since ?? now); rows.set(chat, row);
    }
    const view = liveWorkspace(rt.log);
    const runs = rt.orchestra.list().filter(r => !["completed", "failed", "aborted", "moved"].includes(r.status));
    const crews = rt.crews.list().filter(c => c.busy);
    const candidates = new Set<string>();
    for (const run of runs) {
      if (run.chat) candidates.add(run.chat);
      for (const task of run.tasks) if (task.chat) candidates.add(task.chat);
      for (const task of run.tasks.filter(t => t.status === "running")) {
        const chat = task.chat;
        if (!chat) continue;
        const row = rows.get(chat) ?? { chat, title: task.title, since: task.startedAt ?? run.createdAt, agents: [], lastLine: "", costUsd: task.costUsd ?? null };
        if (!row.agents.includes(task.agent)) row.agents.push(task.agent);
        rows.set(chat, row);
      }
    }
    for (const crew of crews) {
      candidates.add(crew.state.channel);
      Object.values(crew.state.threads).forEach(chat => candidates.add(chat));
      for (const turn of crew.active) {
        const chat = crew.state.threads[turn.teammate];
        if (!chat) continue;
        const row = rows.get(chat) ?? { chat, title: crew.name + " · " + turn.teammate, since: turn.since, agents: [], lastLine: turn.step, costUsd: null };
        if (!row.agents.includes(turn.teammate)) row.agents.push(turn.teammate);
        rows.set(chat, row);
      }
    }
    for (const chat of candidates) {
      const live = liveInChat(rt, chat);
      if (!live) continue;
      const row = rows.get(chat) ?? { chat, title: chat, since: view.chats.get(chat)?.starts.get(live.id) ?? now, agents: [], lastLine: "", costUsd: null };
      if (!row.agents.length) row.agents.push(live.id);
      rows.set(chat, row);
    }
    for (const row of rows.values()) {
      const summary = view.chats.get(row.chat);
      const costs = summary?.costs.filter(c => c.at >= row.since) ?? [];
      if (costs.length) row.costUsd = costs.reduce((n, c) => n + c.usd, 0);
      const live = rt.liveNow(row.chat).map(l => l.text).filter(Boolean).at(-1);
      row.lastLine = String(live ?? (summary?.lastTextAt && summary.lastTextAt >= row.since ? summary.lastText : undefined) ?? row.lastLine).trim().split("\n").filter(Boolean).at(-1)?.slice(-300) ?? "";
      const run = runs.find(r => r.chat === row.chat || r.tasks.some(t => t.chat === row.chat));
      const crew = crews.find(c => c.state.channel === row.chat || Object.values(c.state.threads).includes(row.chat));
      chats.push({ project: rt.info.id, projectName: rt.info.name, ...row, stopScope: run ? "run" : crew ? "crew" : "chat", elapsedMs: Math.max(0, now - row.since) });
    }
  }
  return { chats, runningTurns: chats.reduce((n, c) => n + c.agents.length, 0), at: now };
}
export async function inbox(ctx: Context, scope?: string[] | null) {
  const items: InboxItem[] = [];
  const projects = listProjects();
  for (const p of projects) {
    if (scope && !scope.includes(p.id)) continue;
    const base = { project: p.id, projectName: p.name };
    const rt = ctx.runtimes.get(p.id), stored = rt ? null : dormantState(p.dir);
    if (rt) items.push(...liveWorkspace(rt.log).items(p.dir).map(i => ({ ...base, ...i, id: p.id + ":" + i.id })));
    for (const run of rt ? rt.orchestra.list() : stored!.runs) {
      if (run.status !== "waiting_human" && !(run.status === "aborted" && run.interrupted)) continue;
      items.push({ ...base, id: p.id + ":run:" + run.id, kind: "paused", chat: run.chat, title: run.question ?? run.goal, at: run.updatedAt ?? run.createdAt, runId: run.id,
        action: run.interrupted ? "resume" : run.planOnly && !run.planApprovedAt && run.tasks.length ? "approve-plan" : "reply" });
    }
    for (const crew of rt ? rt.crews.list().map(c => c.state) : stored!.crews) {
      const goal = crew.goal;
      if (!goal || !["paused", "waiting_human", "awaiting_approval", "interrupted"].includes(goal.status)) continue;
      items.push({ ...base, id: p.id + ":crew:" + crew.id, kind: "paused", chat: crew.channel, title: goal.question?.text ?? goal.pauseReason ?? goal.text, at: goal.startedAt,
        crewId: crew.id, action: goal.status === "awaiting_approval" ? "approve" : goal.status === "waiting_human" ? "say" : "resume" });
    }
    const route = rt ? rt.routes.state() : stored!.route;
    if (route?.status === "waiting_human" && !items.some(i => i.project === p.id && i.kind === "question" && i.chat === (route.chat ?? "main")))
      items.push({ ...base, id: p.id + ":route", kind: "paused", chat: route.chat ?? "main", title: route.pendingQuestion ?? "Route waiting for you", at: route.updatedAt, action: "message" });
    const q = rt ? rt.queue.snapshot() : stored!.queue;
    if (q.items.length && (q.paused || !rt)) items.push({ ...base, id: p.id + ":queue", kind: "paused", chat: q.items[0]?.chat ?? "main", title: "Prompt queue paused", at: q.items[0]!.at });
  }
  for (const a of ctx.approvals.values()) {
    if (scope && !scope.includes(a.projectId)) continue;
    items.push({ id: a.projectId + ":approval:" + a.id, kind: "approval", project: a.projectId,
      projectName: projects.find(p => p.id === a.projectId)?.name ?? a.projectId, chat: a.chat ?? "main",
      title: a.tool, agent: a.agent, at: a.createdAt, approvalId: a.id });
  }
  items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { items, count: items.length };
}
export function registerWorkspaceR4Routes(app: Express, ctx: Context, withRuntime: WithRuntime): void {
  app.get("/api/mission", (req, res) => { res.json(mission(ctx, scopeOf(req))); });
  app.get("/api/inbox", async (req, res) => { res.json(await inbox(ctx, scopeOf(req))); });
  app.get("/api/workspace", (req, res) => {
    if (scopeOf(req)) return void res.status(403).json({ error: "Workspace preferences require an owner device" });
    res.json(preferences());
  });
  app.put("/api/workspace", (req, res) => {
    if (scopeOf(req)) return void res.status(403).json({ error: "Workspace preferences require an owner device" });
    try { res.json(changePreferences(req.body)); } catch (e) { error(res, e); }
  });
  for (const action of ["stop", "steer"] as const) app.post(`/api/projects/:id/chats/:chat/workspace/${action}`, withRuntime(async (rt, req, res) => {
    const chat = String(req.params.chat);
    if (!rt.chats().some(c => c.id === chat)) return void res.status(404).json({ error: "No such chat" });
    const live = liveInChat(rt, chat);
    if (action === "stop") {
      const run = rt.orchestra.list().find(r => !["completed", "failed", "aborted", "moved"].includes(r.status) && (r.chat === chat || r.tasks.some(t => t.chat === chat)));
      if (run) { await rt.orchestra.abort(run.id); res.json({ interrupted: run.id, scope: "run" }); return; }
      const crew = rt.crews.list().find(c => c.busy && (c.state.channel === chat || Object.values(c.state.threads).includes(chat)));
      if (crew) { await rt.crews.stop(crew.id); res.json({ interrupted: crew.id, scope: "crew" }); return; }
      if (live) { await live.interrupt(); res.json({ interrupted: live.id }); }
      else res.json(await rt.interrupt({ chat }));
      return;
    }
    const text = z.string().trim().min(1).max(100_000).safeParse(req.body?.text);
    if (!text.success) return void res.status(400).json({ error: "Nonempty steering text required" });
    const run = rt.orchestra.list().find(r => !["completed", "failed", "aborted", "moved"].includes(r.status) && (r.chat === chat || r.tasks.some(t => t.chat === chat)));
    const crew = rt.crews.list().find(c => c.state.channel === chat || Object.values(c.state.threads).includes(chat));
    if (!live && !run && !crew) { res.json(await rt.steerMessage(text.data, undefined, { chat })); return; }
    // Orchestra workers receive task.chat; the orchestrator still uses its main session.
    const nativeChat = run?.tasks.some(t => t.chat === chat) || (crew && rt.continuity) ? chat : "main";
    if (live?.capabilities.steer && live.steer && await live.steer(nativeChat, text.data)) {
      rt.log.append({ kind: "message", chat, payload: { text: text.data, author: "user", steer: true } });
      res.json({ steered: true }); return;
    }
    if (run) { await rt.orchestra.reply(run.id, text.data); res.json({ steered: false, reason: "Direction sent to this run's orchestrator." }); return; }
    if (crew) {
      await rt.crews.say(crew.id, text.data, Object.entries(crew.state.threads).find(([, c]) => c === chat)?.[0]);
      res.json({ steered: false, reason: "Direction queued for this teammate." }); return;
    }
    res.status(409).json({ error: "This turn no longer accepts steering. Open its chat to continue." });
  }));
  app.get("/api/projects/:id/notes", withRuntime(async (rt, _req, res) => { res.json(notes(rt.info.dir)); }));
  app.put("/api/projects/:id/notes", withRuntime(async (rt, req, res) => {
    try { res.json(saveNotes(rt.info.dir, req.body)); } catch (e) { error(res, e); }
  }));
  app.post("/api/projects/:id/inbox/dismiss", withRuntime(async (rt, req, res) => {
    const b = z.strictObject({ eventId: z.number().int().positive() }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "eventId required" });
    if (!rt.log.list({ kinds: ["error", "needs_input"] }).some(e => e.id === b.data.eventId)) return void res.status(404).json({ error: "No such failed turn" });
    dismiss(rt.info.dir, b.data.eventId); res.json({ ok: true });
  }));
  app.get("/api/projects/:id/chats/:chat/files", withRuntime(async (rt, req, res) => {
    const chat = String(req.params.chat);
    if (!rt.chats().some(c => c.id === chat)) return void res.status(404).json({ error: "No such chat" });
    res.json({ files: chatFiles(rt.log.list({ chat })).filter(f => projectFile(rt.info.dir, f.path)?.inside) });
  }));
  app.get("/api/projects/:id/chats/:chat/files/open", withRuntime(async (rt, req, res) => {
    const rel = req.query.path, chat = String(req.params.chat);
    if (!safeRelative(rel) || !chatFiles(rt.log.list({ chat })).some(f => f.path === rel)) return void res.status(404).json({ error: "No such chat file" });
    try {
      const resolved = projectFile(rt.info.dir, rel);
      if (!resolved) return void res.status(404).json({ error: "File no longer exists" });
      const { file, inside } = resolved;
      if (!inside) return void res.status(403).json({ error: "File is outside the project" });
      // Active content is downloaded, so an agent-produced HTML/SVG cannot run on the daemon origin.
      res.download(file, path.basename(file), { dotfiles: "allow" });
    } catch { res.status(404).json({ error: "File no longer exists" }); }
  }));
}

/** The listing and download share existence, regular-file and symlink containment checks. */
function projectFile(dir: string, rel: string) {
  try {
    const base = fs.realpathSync(dir), target = path.resolve(base, rel);
    if (!fs.existsSync(target)) return null;
    const file = fs.realpathSync(target);
    return { file, inside: file.startsWith(base + path.sep) && fs.statSync(file).isFile() };
  } catch { return null; }
}
