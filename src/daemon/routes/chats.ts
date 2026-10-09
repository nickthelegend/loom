import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { findChats, readChat, type ImportSource } from "../../core/chat-import.js";
import { readProjectState, writeProjectState } from "../../core/registry.js";
import { resolveProvider } from "../../core/providers.js";
import { LoomAskTimeoutError } from "../runtime.js";
import type { WithRuntime } from './context.js';
/** Register chats routes in the order established by LoomDaemon.routes(). */
export function registerChatsRoutes(app: Express, withRuntime: WithRuntime): void {

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

  app.post(
    "/api/projects/:id/chats",
    withRuntime(async (rt, req, res) => {
      const { title, agentId, model } = (req.body ?? {}) as {
        title?: string;
        agentId?: string;
        model?: string;
      };
      try {
        res.json({
          chat: rt.createChat(String(title ?? ""), {
            ...(agentId ? { agentId: String(agentId) } : {}),
            ...(model ? { model: String(model) } : {}),
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
   * following the baton like the main one.
   */
  app.post(
    "/api/projects/:id/chats/:chatId/agent",
    withRuntime(async (rt, req, res) => {
      const { agentId, model } = (req.body ?? {}) as { agentId?: string | null; model?: string };
      try {
        const chat = rt.setChatAgent(
          String(req.params.chatId),
          agentId ? String(agentId) : null,
          model ? String(model) : undefined,
        );
        if (!chat) return void res.status(404).json({ error: "no such thread" });
        res.json({ chat });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  app.post(
    "/api/projects/:id/chats/:chatId/rename",
    withRuntime(async (rt, req, res) => {
      const { title } = (req.body ?? {}) as { title?: string };
      if (!title?.trim()) return void res.status(400).json({ error: "missing title" });
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
      const body = (req.body ?? {}) as { pinned?: unknown; archived?: unknown; folder?: unknown };
      const flags: { pinned?: boolean; archived?: boolean; folder?: string | null } = {};
      if (body.pinned !== undefined) flags.pinned = body.pinned === true;
      if (body.archived !== undefined) flags.archived = body.archived === true;
      if (body.folder !== undefined) {
        if (body.folder !== null && typeof body.folder !== "string") return void res.status(400).json({ error: "folder is a name, or null to take it out" });
        flags.folder = body.folder as string | null;
      }
      if (!Object.keys(flags).length) return void res.status(400).json({ error: "nothing to change: send pinned, archived or folder" });
      if (String(req.params.chatId) === "main") {
        return void res.status(400).json({ error: "Main is always first and always there, so it can't be pinned, archived or filed" });
      }
      const chat = rt.setChatFlags(String(req.params.chatId), flags);
      if (!chat) return void res.status(404).json({ error: "no such thread" });
      res.json({ chat });
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
