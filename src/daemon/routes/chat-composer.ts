import type { Express, Request } from "express";
import type { WithRuntime } from "./context.js";
import { chatComposer, updateChatComposer, chatMarkdown, chatTotals, quoteMessage } from "../../core/chat-composer.js";

/** Personal chat state is shared with the owner's devices, never with guests. */
export function registerChatComposerRoutes(app: Express, withRuntime: WithRuntime): void {
  const own: WithRuntime = handler => withRuntime(async (rt, req, res) => {
    const who = req as Request & { guest?: unknown; projectScope?: string[] | null };
    // Project-scoped devices already reach only their own projects (the scope wall); guests never.
    if (who.guest) return void res.status(403).json({ error: "chat settings are private to the owner and their devices" });
    if (req.params.chat && !rt.chats().some(c => c.id === req.params.chat)) return void res.status(404).json({ error: "no such chat" });
    await handler(rt, req, res);
  });
  const base = "/api/projects/:id/chats/:chat";
  app.get(base + "/pins", own(async (rt, req, res) => {
    const chat = String(req.params.chat), ids = chatComposer(rt.info.dir, chat).pins;
    res.json({ pins: rt.log.list({ chat, kinds: ["message"] }).filter(e => ids.includes(e.id)) });
  }));
  for (const method of ["post", "delete"] as const) app[method](base + "/pins", own(async (rt, req, res) => {
    const chat = String(req.params.chat), id = req.body?.eventId;
    if (!Number.isSafeInteger(id) || !rt.log.list({ chat, kinds: ["message"] }).some(e => e.id === id))
      return void res.status(400).json({ error: "no such message in this chat" });
    const pins = chatComposer(rt.info.dir, chat).pins.filter(n => n !== id);
    if (method === "post") pins.push(id);
    if (pins.length > 100) return void res.status(400).json({ error: "at most 100 pins per chat" });
    updateChatComposer(rt.info.dir, chat, { pins });
    res.json({ pins });
  }));
  app.get(base + "/draft", own(async (rt, req, res) => {
    const { draft, revision } = chatComposer(rt.info.dir, String(req.params.chat));
    res.json({ draft, revision });
  }));
  app.put(base + "/draft", own(async (rt, req, res) => {
    const chat = String(req.params.chat), { draft, revision } = req.body ?? {};
    if (typeof draft !== "string" || draft.length > 100_000 || !Number.isSafeInteger(revision) || revision < 0)
      return void res.status(400).json({ error: "send {draft: text, revision: nonnegative integer}" });
    const current = chatComposer(rt.info.dir, chat);
    if (revision !== current.revision) return void res.status(409).json({ error: "draft changed on another device; reopen the chat to load it", draft: current.draft, revision: current.revision });
    const next = updateChatComposer(rt.info.dir, chat, { draft, revision: revision + 1 });
    res.json({ draft: next.draft, revision: next.revision });
  }));
  app.get(base + "/presentation", own(async (rt, req, res) => {
    const chat = String(req.params.chat);
    res.json({ expanded: chatComposer(rt.info.dir, chat).expanded, ...chatTotals(rt.log.list({ chat, allBranches: true })) });
  }));
  app.put(base + "/presentation", own(async (rt, req, res) => {
    const chat = String(req.params.chat), { eventId, expanded } = req.body ?? {};
    if (!Number.isSafeInteger(eventId) || typeof expanded !== "boolean" || !rt.log.list({ chat }).some(e => e.id === eventId && ["tool_call", "file_edit"].includes(e.kind)))
      return void res.status(400).json({ error: "send a tool eventId and expanded boolean" });
    const next = { ...chatComposer(rt.info.dir, chat).expanded, [eventId]: expanded };
    updateChatComposer(rt.info.dir, chat, { expanded: next });
    res.json({ expanded: next });
  }));
  app.get(base + "/markdown", own(async (rt, req, res) => {
    const chat = String(req.params.chat), all = rt.log.list({ chat });
    if (req.query.eventId !== undefined) {
      const e = all.find(e => e.id === Number(req.query.eventId) && e.kind === "message");
      if (!e) return void res.status(404).json({ error: "no such message" });
      return void res.json({ markdown: String(e.payload.text ?? ""), quote: quoteMessage(e, rt.info.id, chat) });
    }
    res.json({ markdown: chatMarkdown(all, rt.chats().find(c => c.id === chat)!.title) });
  }));
  app.get("/api/projects/:id/bookmarks", own(async (rt, _req, res) => {
    const bookmarks = rt.chats().flatMap(c => rt.log.list({ chat: c.id, kinds: ["message"] })
      .filter(e => c.starred?.includes(e.id)).map(e => ({ chat: c.id, title: c.title, event: e })));
    res.json({ bookmarks });
  }));
}
