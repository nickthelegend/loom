import { readDaemonConfig } from "../../core/registry.js";
import { sendExpoPush } from "../push.js";
import type WebSocket from "ws";
import type { ChatPresenceTracker } from "../presence.js";
import { randomBytes, createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { RouteContext, WithRuntime } from "./context.js";
import { createShare, openShare, revokeShare, type Share } from "../../core/shares.js";
import { acceptsPasscode, addAnnotation, configureLink, linkDetails, linkStats, moderateAnnotation, projectAnnotations, recordOpen } from "../../core/teams-r4/links.js";
import { buildHandoff, buildStandup, sinceTime, teammateLogin, type Activity } from "../../core/teams-r4/activity.js";
import { localRecipeOptions, publishShared, readShared, sharedLibrary, type LibraryKind } from "../../core/teams-r4/library.js";
import { snapshotChanges } from "../../core/teams-r4/changes.js";
import { sharePage } from "../../core/teams-r4/page.js";
import { fillTemplate } from "../../core/chat-composer.js";
import { listPrompts } from "../../core/prompts.js";
import { listOrchestraRecipes } from "../../core/orchestra-options.js";
import { threadReplay } from "../../core/replay.js";
import { orchestraSharePage, withShareCountdown } from "../../core/share-page.js";
import { shareHours } from "../../core/team-sharing.js";
import { status as gitStatus } from "../../core/git.js";
import { notify } from "../../core/notify.js";
import { readBridges } from "../chat-bridge.js";
import { isLoopbackHost, lanIp, tailscaleIp } from "../system.js";
import { repoOf } from "../team.js";
import type { ProjectRuntime } from "../runtime.js";

type TeamContext = Pick<RouteContext, "team" | "auth" | "runtime" | "broadcastProjects">;
const fail = (res: Response, error: unknown) => { res.status(400).json({ error: (error as Error).message }); };
const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** Public link handlers precede the bearer wall; every operation rechecks expiry and revocation. */
export function registerTeamsR4Public(app: Express, ctx: TeamContext, presence?: ChatPresenceTracker<WebSocket>): void {
  if (presence) presence.ownerSocket = socket => {
    const token = socket.protocol.startsWith("loom.bearer.") ? socket.protocol.slice(12) : undefined;
    return Boolean(token && ctx.auth.isAuthorized(token) && !ctx.auth.guestOf(token) && !ctx.auth.allowedProjects(token));
  };
  const grants = new Map<string, { id: string; until: number }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const validGrant = (req: Request, share: Share) => {
    if (!linkDetails(share.id).passcode) return true;
    const cookie = String(req.headers.cookie ?? "").split(";").map(s => s.trim()).find(s => s.startsWith(`loom_share_${share.id}=`))?.split("=")[1];
    const grant = cookie ? grants.get(digest(cookie)) : undefined;
    return Boolean(grant && grant.id === share.id && grant.until > Date.now());
  };
  const get = (req: Request, res: Response) => {
    res.set({ "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" });
    const share = openShare(String(req.params.token));
    if (!share) {
      if (req.method === "GET") res.status(404).type("text/plain").send("This link has expired or was revoked.");
      else res.status(404).json({ error: "This link has expired or was revoked." });
    }
    return share;
  };
  const sameOrigin = (req: Request, res: Response) => {
    if (req.headers.origin && req.headers.origin !== origin(req)) { res.status(403).json({ error: "cross-origin share writes are refused" }); return false; }
    if (!req.is("application/json")) { res.status(415).json({ error: "send application/json" }); return false; }
    return true;
  };
  app.post("/share/:token/unlock", (req, res) => {
    const s = get(req, res); if (!s || !sameOrigin(req, res)) return;
    const key = `${req.socket.remoteAddress}:${s.id}`, now = Date.now();
    for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
    if (!attempts.has(key) && attempts.size >= 1000) return void res.status(429).json({ error: "try again later" });
    const a = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (a.count >= 10) return void res.status(429).json({ error: "too many attempts; try in a minute" });
    a.count++; attempts.set(key, a);
    if (!acceptsPasscode(s.id, req.body?.passcode)) return void res.status(403).json({ error: "incorrect passcode" });
    for (const [k, v] of grants) if (v.until <= now) grants.delete(k);
    if (grants.size >= 10000) return void res.status(429).json({ error: "too many open sessions" });
    const token = randomBytes(24).toString("base64url");
    grants.set(digest(token), { id: s.id, until: s.expiresAt });
    res.cookie(`loom_share_${s.id}`, token, { httpOnly: true, sameSite: "strict", secure: req.secure, path: `/share/${String(req.params.token)}`, maxAge: s.expiresAt - now });
    res.json({ ok: true });
  });
  app.get("/share/:token", async (req, res) => {
    const s = get(req, res); if (!s) return;
    try {
      if (!validGrant(req, s)) {
        const page = sharePage(null, linkDetails(s.id), [], s.expiresAt, true);
        res.set("content-security-policy", page.csp).type("html").send(page.html); return;
      }
      const rt = await ctx.runtime(s.projectId);
      const events = rt.log.list({ chat: s.chat, limit: 20_000 });
      const run = s.runId ? rt.orchestra.get(s.runId) : null;
      if (s.runId && !run) return void res.status(404).type("text/plain").send("This run is no longer available.");
      const d = linkDetails(s.id);
      const page = run ? withShareCountdown(orchestraSharePage(run, rt.info.name), s.expiresAt)
        : sharePage(d.changes ? null : threadReplay(events, { project: rt.info.name, chat: s.title }), d, d.changes ? [] : events, s.expiresAt);
      if (recordOpen(s.id)) {
        notify({ title: "Share opened", body: s.title });
        const tokens = (readDaemonConfig()?.clients ?? []).filter(c => !c.guest && !c.projects?.length).flatMap(c => c.pushToken ? [c.pushToken] : []);
        void sendExpoPush(tokens, { title: "Share opened", body: s.title, data: { projectId: s.projectId, chat: s.chat, kind: "share-opened" } }).catch(() => {});
        ctx.broadcastProjects({ type: "share-opened", projectId: s.projectId, chat: s.chat, title: s.title, shareId: s.id });
      }
      res.set("content-security-policy", page.csp).type("html").send(page.html);
    } catch { res.status(404).type("text/plain").send("This thread isn't available any more."); }
  });
  app.post("/share/:token/annotations", async (req, res) => {
    const s = get(req, res); if (!s || !sameOrigin(req, res)) return;
    if (!validGrant(req, s)) return void res.status(403).json({ error: "passcode required" });
    try {
      if (s.runId) throw new Error("comments belong to chat shares");
      const rt = await ctx.runtime(s.projectId), b = req.body ?? {};
      if (!b.verdict && linkDetails(s.id).changes) throw new Error("this link shares changes, not chat messages");
      if (!b.verdict && !rt.log.list({ chat: s.chat, limit: 20_000 }).some(e => e.id === b.messageId && e.kind === "message" && !e.payload.reasoning)) throw new Error("choose a message in this shared chat");
      if (!linkDetails(s.id).projectId) configureLink(s.id, { projectId: s.projectId, chat: s.chat, expiresAt: s.expiresAt });
      const annotation = addAnnotation(s.id, b);
      ctx.broadcastProjects({ type: "share-annotation", projectId: s.projectId, chat: s.chat, shareId: s.id });
      res.json({ annotation });
    } catch (e) { fail(res, e); }
  });
}

async function postStandup(platform: unknown, markdown: string, projectId: string) {
  if (platform !== "slack" && platform !== "discord") throw new Error("post must be slack or discord");
  const cfg = readBridges()[platform];
  const channel = platform === "discord" ? cfg?.orchestraChannel || cfg?.channels[0] : cfg?.channels[0];
  if (!cfg?.enabled || !cfg.botToken || !channel || (cfg.project && cfg.project !== projectId)) throw new Error(`configure an enabled ${platform} bridge and channel for this project first`);
  const text = `Loom standup\n${markdown}`;
  if (text.length > (platform === "discord" ? 2000 : 35000)) throw new Error("standup is too long to post; choose a shorter --since window");
  const response = await fetch(platform === "slack" ? "https://slack.com/api/chat.postMessage" : `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`, {
    method: "POST", headers: { authorization: `${platform === "slack" ? "Bearer" : "Bot"} ${cfg.botToken}`, "content-type": "application/json" },
    body: JSON.stringify(platform === "slack" ? { channel, text, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false } : { content: text, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15000),
  });
  const out = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || out.ok === false) throw new Error(`${platform} rejected standup: ${out.error ?? response.status}`);
}

export function registerTeamsR4Routes(app: Express, ctx: Pick<RouteContext, "team" | "host" | "port" | "exposedIps">, withRuntime: WithRuntime): void {
  const route = (fn: (rt: ProjectRuntime, req: Request, res: Response) => Promise<void>) => withRuntime(async (rt, req, res) => { try { await fn(rt, req, res); } catch (e) { fail(res, e); } });
  const base = "/api/projects/:id/teams-r4";
  app.get(base + "/library/:kind", route(async (rt, req, res) => {
    const kind = String(req.params.kind) as LibraryKind;
    if (kind !== "templates" && kind !== "recipes") throw new Error("choose templates or recipes");
    // Personal libraries are machine-wide. Scoped clients still see their repo's Team entries.
    const scoped = (req as Request & { projectScope?: string[] }).projectScope;
    res.json({ ...sharedLibrary(rt.info.dir, kind), personal: scoped ? [] : kind === "templates" ? listPrompts().saved.map(p => ({ name: p.title, text: p.text })) : listOrchestraRecipes() });
  }));
  app.post(base + "/library/:kind/:name/publish", route(async (rt, req, res) => {
    const kind = String(req.params.kind) as LibraryKind;
    if (kind !== "templates" && kind !== "recipes") throw new Error("choose templates or recipes");
    const value = kind === "templates" ? req.body?.text : req.body?.options;
    if ((req as Request & { projectScope?: string[] }).projectScope && value === undefined) throw new Error("provide the entry's data to publish from a scoped device");
    res.json(publishShared(rt.info.dir, kind, String(req.params.name), value));
  }));
  app.post(base + "/library/templates/:name/render", route(async (rt, req, res) => {
    res.json({ text: fillTemplate(readShared(rt.info.dir, "templates", String(req.params.name)).text, req.body?.values ?? {}) });
  }));
  app.post(base + "/library/recipes/:name/run", route(async (rt, req, res) => {
    res.json({ run: await rt.orchestra.start(localRecipeOptions(readShared(rt.info.dir, "recipes", String(req.params.name)), rt.config.agents)) });
  }));
  app.post(base + "/shares", route(async (rt, req, res) => {
    const b = req.body ?? {}, chat = String(b.chat || "main"), info = rt.chats().find(c => c.id === chat || c.title.toLowerCase() === chat.toLowerCase());
    if (!info) throw new Error("no such chat");
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 4000)) throw new Error("note must have at most 4000 characters");
    const run = b.run ? rt.orchestra.get(String(b.run)) : undefined;
    if (b.run && !run) throw new Error("no such run");
    const to = b.pass || b.review ? teammateLogin(b.pass || b.review) : undefined;
    if (to && !(await ctx.team.teammates(rt)).some(t => t.github.toLowerCase() === to)) throw new Error(`@${to} isn't available on this project's team; connect and share the repo first`);
    const changes = b.changes || b.review ? await snapshotChanges(rt.info.dir) : undefined;
    const handoff = b.pass ? buildHandoff(rt.log.list({ chat: info.id, limit: 2000 }), (await gitStatus(rt.info.dir)).branch, to!, b.note ?? "") : undefined;
    const { share, token } = createShare({ projectId: rt.info.id, chat: run?.chat ?? info.id, ...(run ? { runId: run.id } : {}), title: `${rt.info.name} · ${run?.goal ?? info.title}`, hours: shareHours(b) });
    // Share-live uses these same listeners. Its credentialed cloud relay cannot serve
    // an anonymous /share URL, so never substitute a relay endpoint for this page.
    let base = origin(req);
    if (isLoopbackHost(req.headers.host)) {
      const exposed = ctx.exposedIps();
      const reach = (ip: string | null): ip is string => Boolean(ip && (ctx.host === "0.0.0.0" || ctx.host === "::" || ctx.host === ip || exposed.includes(ip)));
      const tailnet = await tailscaleIp().catch(() => null);
      const host = [tailnet, lanIp(), ...exposed, ctx.host].find(ip => ip && ip !== "0.0.0.0" && ip !== "::" && !isLoopbackHost(ip) && reach(ip));
      if (host) base = `http://${host.includes(":") ? `[${host}]` : host}:${ctx.port}`;
    }
    const url = `${base}/share/${token}`;
    const warning = to && isLoopbackHost(new URL(base).host) ? "This link is local to the sender's computer. The teammate needs Share-live or a reachable address to open the shared work." : undefined;
    try {
      configureLink(share.id, { expiresAt: share.expiresAt, projectId: rt.info.id, chat: info.id, passcode: b.passcode, notifyFirstOpen: b.notifyFirstOpen, changes, handoff, ...(b.review ? { reviewer: to } : {}) });
      if (to) await ctx.team.mention(rt, info.id, `@${to} ${b.pass ? "Chat hand-off" : "Review requested"}: ${url}\n${warning ? warning + "\n" : ""}${handoff ? `Branch: ${handoff.branch}\n${handoff.note || handoff.summary}` : b.note || share.title}`.slice(0, 500));
    } catch (e) { revokeShare(share.id); throw e; }
    res.json({ id: share.id, url, ...(warning ? { warning } : {}), title: share.title, expiresAt: share.expiresAt, ...linkStats(share.id), ...(handoff ? { handoff } : {}) });
  }));
  app.get(base + "/annotations/:chat", route(async (rt, req, res) => { res.json({ annotations: projectAnnotations(rt.info.id, String(req.params.chat)) }); }));
  for (const method of ["delete", "put"] as const) app[method](base + "/annotations/:share/:annotation", route(async (rt, req, res) => {
    if (linkDetails(String(req.params.share)).projectId !== rt.info.id) throw new Error("no such share in this project");
    if (method === "put" && req.body?.reply === undefined) throw new Error("reply is required");
    moderateAnnotation(String(req.params.share), String(req.params.annotation), method === "put" ? req.body.reply : undefined);
    res.json({ ok: true });
  }));
  const standup = route(async (rt, req, res) => {
    const b = req.method === "GET" ? req.query : req.body ?? {}, since = sinceTime(b.since ?? "1d");
    const post: unknown = req.method === "POST" ? req.body?.post : undefined;
    if (post) {
      const access = req as Request & { isAdmin?: boolean; projectScope?: string[] | null; guest?: unknown };
      const owner = access.isAdmin || (!access.projectScope && !access.guest);
      const bound = (post === "slack" || post === "discord") && readBridges()[post]?.project === rt.info.id;
      if (!owner && !bound) return void res.status(403).json({ error: "only this machine's owner or a bridge bound to this project can post a standup" });
    }
    const status = ctx.team.status(), repo = await repoOf(rt.info.dir);
    const feed = ((status.teams ?? []) as Array<{ feed: Activity[] }>).flatMap(t => t.feed).filter(e => repo && e.repo === repo);
    const waiting = ((status.teams ?? []) as Array<{ presence: Array<{ repo: string; state: string; github: string; intent?: { goal?: string; task?: string } }> }>).flatMap(t => t.presence).filter(p => repo && p.repo === repo && p.state === "waiting_human").map(p => ({ person: p.github, title: p.intent?.task || p.intent?.goal || "Waiting for input" }));
    for (const run of rt.orchestra.list().filter(r => r.status === "waiting_human")) waiting.push({ person: String(status.github || "You"), title: run.question || run.goal });
    const report = buildStandup(feed, rt.log.list({ sinceTs: since, activeLineages: true }), since, String(status.github || "You"), waiting);
    if (post) await postStandup(post, report.markdown, rt.info.id);
    res.json({ ...report, ...(post ? { posted: post } : {}) });
  });
  app.get(base + "/standup", standup);
  app.post(base + "/standup", standup);
}
