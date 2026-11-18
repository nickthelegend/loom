import { registerChatComposerRoutes } from "./chat-composer.js";
import { ChatMoveError } from "../../core/chat-move.js";
import { HubError } from "../../core/team-hub.js";
import type { TeamLink } from "../team.js";
import { ChatBranchError } from "../../core/chat-branches.js";
import type { Express, Request } from 'express';
import { SideChatError } from "../../core/side-chats.js";
import { trackedPrs, type PrFeedbackMode } from "../../core/pr-feedback.js";
import fs from "node:fs";
import path from "node:path";
import { findChats, readChat, type ImportSource } from "../../core/chat-import.js";
import { readProjectState, writeProjectState } from "../../core/registry.js";
import { resolveProvider } from "../../core/providers.js";
import { LoomAskTimeoutError } from "../runtime.js";
import type { WithRuntime } from './context.js';
import { threadReplay } from "../../core/replay.js";
import { shareHours } from "../../core/team-sharing.js";
import { createShare, listShares, revokeShare } from "../../core/shares.js";
import { MAIN_CHAT } from "../../types.js";
/** Register chats routes in the order established by LoomDaemon.routes(). */
export function registerChatsRoutes(app: Express, withRuntime: WithRuntime, team: TeamLink): void {

  registerChatComposerRoutes(app, withRuntime);

  /** Owner only. POST {to: runnerDeviceId, wait?: boolean} waits by default, then returns
   * {chat: ChatInfo, jobId}. chat.movedTo is also on GET /chats. wait:false returns 409
   * "busy" during a turn; sends to a moved chat return 409 "moved to <name>".
   * Job completion is visible in GET /api/projects/:id/team/runners: result {projectId, chatId} on the target.
   * Bring it back by moving the target chat to a runner on the original device.
   */
  app.post("/api/projects/:id/chats/:chat/move", withRuntime(async (rt, req, res) => {
    // the owner, or their own phone (an unscoped paired device) — never a guest or a scoped token
    const who = req as Request & { isAdmin?: boolean; guest?: unknown; projectScope?: string[] | null };
    if (!who.isAdmin && (who.guest || who.projectScope))
      return void res.status(403).json({ error: "only this machine's owner or their own devices can move a chat" });
    const { to, wait } = req.body ?? {};
    if (typeof to !== "string" || !to.trim() || (wait !== undefined && typeof wait !== "boolean"))
      return void res.status(400).json({ error: "send {to: runnerDeviceId, wait?: boolean}" });
    try { res.json(await team.moveChat(rt, String(req.params.chat), to, wait !== false)); }
    catch (error) {
      res.status(error instanceof ChatMoveError || error instanceof HubError ? error.status : 400)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  }));

  const branchRoute: WithRuntime = handler => withRuntime(async (rt, req, res) => {
    try { await handler(rt, req, res); }
    catch (error) {
      if (!(error instanceof ChatBranchError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });

  /** {branches: ChatBranch[], active: string, siblingsByEventId: {[messageId]: branchId[]}}.
   * Choices are ordered original first, then forks by creation. For nested active branches,
   * walk parents to the first choice in this array; its index + 1 gives n/m.
   * Event ids are durable across branches. Root is "0", including legacy events without branch.
   */
  app.get("/api/projects/:id/chats/:chat/branches", branchRoute(async (rt, req, res) => {
    res.json(rt.branches(String(req.params.chat)));
  }));
  /** {fromEventId, mode: "edit" | "retry", text?} -> {branch: ChatBranch}.
   * Edit targets a visible user message; retry targets its agent reply and repeats the prompt.
   * Creates and activates the fork and submits a turn without rewinding files. Busy/queued work: 409.
   */
  app.post("/api/projects/:id/chats/:chat/branches", branchRoute(async (rt, req, res) => {
    const { fromEventId, mode, text } = req.body ?? {};
    res.json({ branch: await rt.createBranch(String(req.params.chat), fromEventId, mode, text) });
  }));
  /** Read-only diff preview before offering file rewind. Includes untracked files.
   * {checkpoint, changed: string[], diff: string}; missing/pruned checkpoints cannot be restored.
   */
  app.get("/api/projects/:id/chats/:chat/branches/:branch/rewind", branchRoute(async (rt, req, res) => {
    res.json(await rt.branchRewindPreview(String(req.params.chat), String(req.params.branch)));
  }));
  /** {rewindFiles?: boolean} -> {active, rewind?: {restored, undo, changed, diff}}.
   * Default only changes history. Explicit true restores the fork checkpoint after the client
   * shows GET .../rewind; returning to root uses the fork being left. Never moves Git HEAD.
   */
  app.post("/api/projects/:id/chats/:chat/branches/:branch/activate", branchRoute(async (rt, req, res) => {
    if (req.body?.rewindFiles !== undefined && typeof req.body.rewindFiles !== "boolean")
      return void res.status(400).json({ error: "rewindFiles must be a boolean" });
    res.json(await rt.activateBranch(String(req.params.chat), String(req.params.branch), req.body?.rewindFiles === true));
  }));

  // Side chats are private to owners and unscoped devices, including their HTTP snapshots.
  const privateSide: WithRuntime = handler => withRuntime(async (rt, req, res) => {
    if ((req as Request & { projectScope?: string[] | null }).projectScope) {
      return void res.status(403).json({ error: "side chats are private to the owner and unscoped devices" });
    }
    try { await handler(rt, req, res); }
    catch (error) {
      if (!(error instanceof SideChatError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });

  /**
   * POST {text, sideId?} returns {sideId} immediately. With no id, open or continue this
   * chat's drawer; with an id, continue exactly that side (404 if closed, 409 if busy).
   * GET returns {messages: [{role: "user" | "agent", text, at}], busy, error?}.
   * WS side frames carry projectId, chat, sideId and delta | message | done (error?).
   * DELETE cancels and forgets the side; it never changes the parent. Bring back is a
   * client-only quote into the main composer, submitted through /messages when desired.
   */
  app.post("/api/projects/:id/chats/:chatId/side", privateSide(async (rt, req, res) => {
    const { text, sideId } = req.body ?? {};
    if (typeof text !== "string" || (sideId !== undefined && (typeof sideId !== "string" || !sideId))) {
      return void res.status(400).json({ error: "send {text, sideId?}" });
    }
    res.json(rt.sides.send(String(req.params.chatId), text, sideId));
  }));
  app.get("/api/projects/:id/chats/:chatId/side/:sideId", privateSide(async (rt, req, res) => {
    res.json(rt.sides.get(String(req.params.chatId), String(req.params.sideId)));
  }));
  app.delete("/api/projects/:id/chats/:chatId/side/:sideId", privateSide(async (rt, req, res) => {
    await rt.sides.delete(String(req.params.chatId), String(req.params.sideId));
    res.json({ deleted: true });
  }));

  // See TrackedPr for the response shape. Completed rows remain visible as history.
  app.get("/api/projects/:id/prs", withRuntime(async (rt, _req, res) => {
    res.json({ prs: trackedPrs(rt.info.dir) });
  }));
  // Owner only: attaching a PR authorizes future unattended turns in this chat.
  app.post("/api/projects/:id/chats/:chat/prs", withRuntime(async (rt, req, res) => {
    if (!(req as typeof req & { isAdmin?: boolean }).isAdmin) return void res.status(403).json({ error: "only this machine's owner can attach a PR" });
    const chat = String(req.params.chat);
    if (!rt.chats().some(c => c.id === chat)) return void res.status(404).json({ error: "no such chat" });
    try { res.json({ pr: await rt.prFeedback.attach(req.body?.pr, chat) }); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  }));

  // A read-only link to a chat, for a teammate (#199): /share/<token>, expiring, revocable.
  app.post(
    "/api/projects/:id/chats/:chat/share",
    withRuntime(async (rt, req, res) => {
      const chat = String(req.params.chat || MAIN_CHAT);
      const info = chat === MAIN_CHAT ? { title: "Main" } : rt.chats().find((c) => c.id === chat);
      if (!info) return void res.status(404).json({ error: "no such chat" });
      let hours: number;
      try { hours = shareHours(req.body ?? {}); } catch (e) { return void res.status(400).json({ error: (e as Error).message }); }
      const { share, token } = createShare({ projectId: rt.info.id, chat, title: `${rt.info.name} · ${info.title || "Chat"}`, ...(Number(hours) > 0 ? { hours: Number(hours) } : {}) });
      const host = String(req.headers.host ?? "127.0.0.1");
      res.json({ id: share.id, url: `http://${host}/share/${token}`, expiresAt: share.expiresAt, title: share.title });
    }),
  );
  app.get("/api/projects/:id/shares", withRuntime(async (rt, _req, res) => {
    res.json({ shares: listShares().filter(s => s.projectId === rt.info.id).map(({ hash: _h, ...s }) => s) });
  }));
  app.delete("/api/projects/:id/shares/:shareId", withRuntime(async (rt, req, res) => {
    const id = String(req.params.shareId);
    if (!listShares().some(s => s.id === id && s.projectId === rt.info.id)) return void res.status(404).json({ error: "no such share" });
    res.json({ revoked: revokeShare(id) });
  }));
  app.get("/api/shares", (_req, res) => {
    res.json({ shares: listShares().map(({ hash: _h, ...s }) => s) });
  });
  app.delete("/api/shares/:shareId", (req, res) => {
    res.json({ revoked: revokeShare(String(req.params.shareId)) });
  });

  // A chat as one self-contained HTML page — prompts, replies, what ran, what changed, and what
  // Loom checked (core/replay.ts). ?download=1 asks the browser to save it.
  app.get(
    "/api/projects/:id/chats/:chat/replay",
    withRuntime(async (rt, req, res) => {
      const chat = String(req.params.chat || MAIN_CHAT);
      const info = chat === MAIN_CHAT ? { title: "Main" } : rt.chats().find((c) => c.id === chat);
      if (!info) return void res.status(404).json({ error: "no such chat" });
      const events = rt.log.list({ chat, limit: 20_000 });
      const html = threadReplay(events, { project: rt.info.name, chat: info.title || "Chat" });
      const file = `${rt.info.name}-${info.title || chat}`.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80) || "replay";
      if (req.query.format === "json") return void res.json({ filename: `${file}.html`, content: html });
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.setHeader("x-content-type-options", "nosniff");
      if (req.query.download) res.setHeader("content-disposition", `attachment; filename="${file}.replay.html"`);
      res.send(html);
    }),
  );

  /**
   * Drive a GUI agent: type into Antigravity's or Kiro's own chat and read
   * back what appeared.
   *
   * Separate from /messages because it is a different act. /messages hands a
   * turn to something that can hold the baton; this types into an app you're
   * signed into and waits for its panel to settle. The bridge never takes the
   * lock, so an adapter mid-turn is untouched.
   *
   * It waits up to 15 seconds for the app to answer. A GUI agent can disappear
   * without closing its socket, so the deadline keeps the caller from waiting
   * forever and gives it a useful recovery message instead.
   */
  app.post(
    "/api/projects/:id/bridge/:agentId/ask",
    withRuntime(async (rt, req, res) => {
      const { text, chat } = (req.body ?? {}) as { text?: string; chat?: string };
      const agentId = String(req.params.agentId);
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      try {
        const result = await rt.askBridge(agentId, text, chat ? { chat } : {});
        res.json(result);
      } catch (err) {
        // 409, not 500: "log into Antigravity" is a state you can fix, not a
        // bug in the daemon, and the message is the whole value of the reply.
        res.status(err instanceof LoomAskTimeoutError ? 504 : 409).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  app.post(
    "/api/projects/:id/handoff",
    withRuntime(async (rt, req, res) => {
      const { to } = (req.body ?? {}) as { to?: string };
      if (!to) return void res.status(400).json({ error: "missing to" });
      const result = await rt.handoff(to);
      res.json({ ...result, to });
    }),
  );

  // Chats — several conversations inside one project. They share the brain,
  // the baton and the working tree; only the talking is separate.
  app.get(
    "/api/projects/:id/chats",
    withRuntime(async (rt, _req, res) => {
      res.json({ chats: rt.chats() });
    }),
  );

  // ---- chats from your agents' own history (core/chat-import.ts) ----------
  const SOURCES: ImportSource[] = ["claude-code", "codex", "opencode"];
  const LABEL: Record<ImportSource, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

  /** Session ids Loom's own agents use here: those chats are already in the thread. */
  const loomSessions = (dir: string): Set<string> => {
    const ids = new Set<string>();
    for (const a of Object.values(readProjectState(dir).agents ?? {})) if (typeof a.sessionId === "string") ids.add(a.sessionId);
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, ".loom", "providers", "sessions.json"), "utf8")) as { bindings?: Array<{ resumeCursor?: unknown }> };
      for (const x of b.bindings ?? []) if (typeof x.resumeCursor === "string") ids.add(x.resumeCursor);
    } catch { /* none yet */ }
    return ids;
  };

  app.get(
    "/api/projects/:id/imports",
    withRuntime(async (rt, _req, res) => {
      const done = readProjectState(rt.info.dir).imports ?? {};
      const chats = await findChats(rt.info.dir, { loomIds: loomSessions(rt.info.dir) });
      res.json({ chats: chats.map((c) => ({ ...c, label: LABEL[c.source], ...(done[`${c.source}:${c.id}`] ? { chat: done[`${c.source}:${c.id}`] } : {}) })) });
    }),
  );

  // Bring one in: a new chat holding your words, the agent's replies and a line
  // per tool call, at their original times. Importing again opens the same chat.
  app.post(
    "/api/projects/:id/imports",
    withRuntime(async (rt, req, res) => {
      const { source, id } = (req.body ?? {}) as { source?: string; id?: string };
      if (!SOURCES.includes(source as ImportSource) || typeof id !== "string" || !id) {
        return void res.status(400).json({ error: "send { source: claude-code | codex | opencode, id }" });
      }
      const key = `${source}:${id}`;
      const existing = readProjectState(rt.info.dir).imports?.[key];
      if (existing && rt.chats().some((c) => c.id === existing)) return void res.json({ chat: rt.chats().find((c) => c.id === existing), already: true });
      let got;
      try {
        got = await readChat(rt.info.dir, source as ImportSource, id);
      } catch (err) {
        return void res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      }
      const chat = rt.createChat(`${LABEL[got.source]} · ${got.title}`.slice(0, 80));
      // the agent's replies wear its name — the roster's agent of that kind, if there is one
      const agentId = (await rt.status()).agents.find((a) => a.kind === got.source)?.id ?? got.source;
      const imported = { source: got.source, sessionId: got.id };
      const first = got.items[0]?.ts || Date.now();
      rt.log.append({ kind: "message", chat: chat.id, ts: first - 1, payload: {
        author: "loom",
        text: `Imported from ${LABEL[got.source]}: ${got.items.length} messages and tool calls${got.dropped ? ` (the ${got.dropped} oldest left out)` : ""}. Read-only history — what you send from here starts fresh with the agent you pick.`,
        imported,
      } });
      for (const it of got.items) {
        if (it.kind === "user") rt.log.append({ kind: "message", chat: chat.id, ts: it.ts, payload: { text: it.text, author: "user", imported } });
        else if (it.kind === "assistant") rt.log.append({ kind: "message", agentId, chat: chat.id, ts: it.ts, payload: { text: it.text, imported, ...(it.model ? { model: it.model } : {}) } });
        else rt.log.append({ kind: "tool_call", agentId, chat: chat.id, ts: it.ts, payload: { tool: it.tool, summary: it.summary, ok: true, imported } });
      }
      const st = readProjectState(rt.info.dir);
      writeProjectState(rt.info.dir, { ...st, imports: { ...(st.imports ?? {}), [key]: chat.id } });
      res.json({ chat, items: got.items.length, dropped: got.dropped });
    }),
  );

  /** Body: { title?: string, agentId?: string, model?: string, effort?: string }.
   * Model/effort require agentId; omitted choices inherit its defaults. Returns { chat: ChatInfo }.
   */
  app.post(
    "/api/projects/:id/chats",
    withRuntime(async (rt, req, res) => {
      const { title, agentId, model, effort } = (req.body ?? {}) as {
        title?: string;
        agentId?: string;
        model?: string;
        effort?: string;
      };
      try {
        res.json({
          chat: rt.createChat(String(title ?? ""), {
            ...(agentId ? { agentId: String(agentId) } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
          }),
        });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /**
   * One prompt, several models, a thread each. With free quota this costs
   * what asking one model costs.
   */
  app.post(
    "/api/projects/:id/ask",
    withRuntime(async (rt, req, res) => {
      const { text, models, title, briefing } = (req.body ?? {}) as {
        text?: string;
        models?: Array<string | { model: string; provider?: string }>;
        title?: string;
        briefing?: boolean;
      };
      if (!text?.trim()) return void res.status(400).json({ error: "missing text" });
      const picks = (models ?? []).map((m) =>
        typeof m === "string"
          ? // "provider/vendor/model" — the provider is the first segment
          // only when it names one we know; otherwise the whole string is
          // the model, because model ids contain slashes too.
          (() => {
            const [head, ...rest] = m.split("/");
            return head && rest.length && resolveProvider(head)
              ? { model: rest.join("/"), provider: head }
              : { model: m };
          })()
          : { model: String(m.model), ...(m.provider ? { provider: String(m.provider) } : {}) },
      );
      try {
        const asked = await rt.askModels(text, picks, {
          ...(title ? { title } : {}),
          ...(briefing === false ? { briefing: false } : {}),
        });
        res.json({ asked });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /**
   * Who answers in a thread. Null unbinds it, and the thread goes back to
   * following the baton like the main one. Body: { agentId: string | null,
   * model?: string, effort?: string }. This replaces the whole selection:
   * omitted/empty model and effort inherit agent defaults. Returns { chat: ChatInfo }.
   * Changes affect future turns; an in-flight turn keeps its captured selection.
   */
  app.post(
    "/api/projects/:id/chats/:chatId/agent",
    withRuntime(async (rt, req, res) => {
      const { agentId, model, effort } = (req.body ?? {}) as { agentId?: string | null; model?: string; effort?: string };
      try {
        const chat = rt.setChatAgent(
          String(req.params.chatId),
          agentId ? String(agentId) : null,
          model,
          effort,
        );
        if (!chat) return void res.status(404).json({ error: "no such thread" });
        res.json({ chat });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  /** POST {auto: true} generates from the first user message only while the title is
   * default; POST {title: string} sets a user name. Returns {chat: ChatInfo}.
   * Both emit a WS event: kind "status", chat: id, payload {state: "chat_renamed", title, titleSource}.
   * Automatic requests never replace user names; an unchanged chat is returned.
   */
  app.post(
    "/api/projects/:id/chats/:chatId/rename",
    withRuntime(async (rt, req, res) => {
      const { title, auto } = req.body ?? {};
      if (auto === true && title === undefined) {
        const id = String(req.params.chatId);
        const chat = await rt.autoTitleChat(id) ?? rt.chats().find(c => c.id === id);
        if (!chat) return void res.status(404).json({ error: "no such chat" });
        return void res.json({ chat });
      }
      if (auto !== undefined || typeof title !== "string" || !title.trim()) return void res.status(400).json({ error: "missing title" });
      const chat = rt.renameChat(String(req.params.chatId), title);
      if (!chat) return void res.status(400).json({ error: "cannot rename that chat" });
      res.json({ chat });
    }),
  );

  // Pin a thread to the top of the sidebar, archive it out of the way, or
  // file it in a folder ("" or null takes it out).
  app.patch(
    "/api/projects/:id/chats/:chatId",
    withRuntime(async (rt, req, res) => {
      const body = (req.body ?? {}) as { pinned?: unknown; archived?: unknown; folder?: unknown; prFeedback?: unknown };
      if (body.prFeedback !== undefined && (typeof body.prFeedback !== "string" || !["off", "ci", "ci+reviews"].includes(body.prFeedback))) {
        return void res.status(400).json({ error: "prFeedback must be off, ci, or ci+reviews" });
      }
      const flags: { pinned?: boolean; archived?: boolean; folder?: string | null } = {};
      if (body.pinned !== undefined) flags.pinned = body.pinned === true;
      if (body.archived !== undefined) flags.archived = body.archived === true;
      if (body.folder !== undefined) {
        if (body.folder !== null && typeof body.folder !== "string") return void res.status(400).json({ error: "folder is a name, or null to take it out" });
        flags.folder = body.folder as string | null;
      }
      if (!Object.keys(flags).length && body.prFeedback === undefined) return void res.status(400).json({ error: "nothing to change: send pinned, archived, folder or prFeedback" });
      if (String(req.params.chatId) === "main" && Object.keys(flags).length) {
        return void res.status(400).json({ error: "Main is always first and always there, so it can't be pinned, archived or filed" });
      }
      const id = String(req.params.chatId);
      let chat = Object.keys(flags).length ? rt.setChatFlags(id, flags) : rt.chats().find(c => c.id === id);
      if (chat && body.prFeedback !== undefined) chat = rt.setPrFeedback(id, body.prFeedback as PrFeedbackMode);
      if (!chat) return void res.status(404).json({ error: "no such thread" });
      res.json({ chat });
    }),
  );

  // A conversation's standing instructions (main included): { instructions } — "" clears them.
  app.get(
    "/api/projects/:id/chats/:chatId/instructions",
    withRuntime(async (rt, req, res) => {
      const chat = String(req.params.chatId);
      const text = rt.chatInstructions(chat) ? (await import("../../core/registry.js")).readProjectState(rt.info.dir).chatInstructions?.[chat] ?? "" : "";
      res.json({ chat, instructions: text });
    }),
  );
  app.put(
    "/api/projects/:id/chats/:chatId/instructions",
    withRuntime(async (rt, req, res) => {
      const text = (req.body ?? {}).instructions;
      if (typeof text !== "string") return void res.status(400).json({ error: "instructions is text (\"\" clears them)" });
      const out = rt.setChatInstructions(String(req.params.chatId), text);
      if (!out) return void res.status(404).json({ error: "no such thread" });
      res.json(out);
    }),
  );

  // Rate a reply: { eventId, agentId, value: 1 | -1 | 0 }.
  app.post(
    "/api/projects/:id/chats/:chatId/rate",
    withRuntime(async (rt, req, res) => {
      const { eventId, agentId, value } = (req.body ?? {}) as { eventId?: unknown; agentId?: unknown; value?: unknown };
      const ratings = rt.rateMessage(String(req.params.chatId), Number(eventId), String(agentId ?? ""), Number(value));
      if (!ratings) return void res.status(400).json({ error: "no such thread, message or agent" });
      res.json({ ratings });
    }),
  );

  // Star a message worth coming back to.
  app.post(
    "/api/projects/:id/chats/:chatId/star",
    withRuntime(async (rt, req, res) => {
      const { eventId, on } = (req.body ?? {}) as { eventId?: unknown; on?: unknown };
      const who = req as Request & { guest?: unknown; projectScope?: string[] | null };
      if (who.guest || who.projectScope) return void res.status(403).json({ error: "bookmarks are private to the owner and their devices" });
      if (!rt.chats().some(c => c.id === req.params.chatId) || !rt.log.list({ chat: String(req.params.chatId), kinds: ["message"] }).some(e => e.id === eventId))
        return void res.status(400).json({ error: "no such message in this chat" });
      const starred = rt.starMessage(String(req.params.chatId), Number(eventId), on !== false);
      if (!starred) return void res.status(400).json({ error: "no such thread or message" });
      res.json({ starred });
    }),
  );

  app.delete(
    "/api/projects/:id/chats/:chatId",
    withRuntime(async (rt, req, res) => {
      if (!rt.deleteChat(String(req.params.chatId))) {
        return void res.status(400).json({ error: "cannot delete that chat" });
      }
      res.json({ deleted: true });
    }),
  );
}
