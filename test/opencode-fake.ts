/**
 * A stand-in for `opencode serve`, speaking the slice of its HTTP + SSE API the
 * OpenCode adapter uses (shapes recorded from opencode 1.18.31). No model runs:
 * a prompt is admitted, the session is listed in /api/session/active for
 * `turnMs`, then an assistant message completes with `reply`.
 *
 * Knobs model the cases a live server won't give you on demand: a session it
 * has forgotten, a prompt it refuses, a turn that never stops, a failed turn,
 * a compaction and a tool call mid-turn. Everything it was asked is recorded.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export interface FakeOpenCodeOptions {
  reply?: string;
  turnMs?: number;
  /** Stay listed as active forever (quiescence never proven). */
  stuck?: boolean;
  /** POST /prompt answers this status instead of admitting. */
  refusePrompt?: number;
  /** The assistant message finishes with an error. */
  fail?: string;
  /** Emit a compaction (started, ended) during the turn. */
  compact?: boolean;
  /** Emit a tool call during the turn. */
  tool?: { tool: string; input: Json };
  /**
   * A two-step turn: a first assistant message that finishes on tool calls,
   * then this long a pause (the session still running) before the answer.
   */
  stepGapMs?: number;
  /** Mid-turn, ask these questions (opencode's question tool) and finish only once answered. */
  ask?: Json[];
  /** Mid-turn, ask this permission and finish only once replied to. */
  permission?: { permission: string; patterns: string[]; metadata?: Json };
}

export interface FakeOpenCode {
  url: string;
  opts: FakeOpenCodeOptions;
  sessions: Map<string, { model: Json; messages: Json[] }>;
  prompts: Array<{ session: string; text: string }>;
  modelSwitches: Array<{ session: string; model: Json }>;
  created: string[];
  /** Replies to questions and permissions, as posted. */
  replies: Array<{ path: string; body: Json }>;
  forget(session: string): void;
  close(): Promise<void>;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(16)}${(seq++).toString(16).padStart(6, "0")}`;

export async function fakeOpenCode(opts: FakeOpenCodeOptions = {}): Promise<FakeOpenCode> {
  const sessions = new Map<string, { model: Json; messages: Json[] }>();
  const active = new Set<string>();
  const sse = new Set<http.ServerResponse>();
  const prompts: FakeOpenCode["prompts"] = [];
  const modelSwitches: FakeOpenCode["modelSwitches"] = [];
  const created: string[] = [];
  const replies: FakeOpenCode["replies"] = [];
  const waiting = new Map<string, () => void>(); // question/permission id → finish the turn
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const push = (type: string, properties: Json) => {
    const line = `data: ${JSON.stringify({ id: nextId("evt"), type, properties })}\n\n`;
    for (const res of sse) res.write(line);
  };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = (req: http.IncomingMessage) => new Promise<Json>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(raw ? (JSON.parse(raw) as Json) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    if (p === "/api/health") return send(res, 200, { healthy: true });
    if (p === "/api/model") return send(res, 200, { data: [{ providerID: "opencode", id: "big-pickle" }, { providerID: "opencode", id: "other-free" }] });
    if (p === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }
    // answers to opencode's own asks: the session-scoped routes current builds serve
    const qa = /^\/api\/session\/[^/]+\/(question|permission)\/([^/]+)\/(reply|reject)$/.exec(p);
    if (qa && req.method === "POST") {
      replies.push({ path: p, body: await body(req) });
      const go = waiting.get(qa[2]!);
      if (!go) return send(res, 404, { message: "no such request" });
      waiting.delete(qa[2]!);
      send(res, 200, { data: true });
      push(qa[1] === "question" ? (qa[3] === "reply" ? "question.replied" : "question.rejected") : "permission.replied", { sessionID: "", requestID: qa[2] });
      go();
      return;
    }
    if (p === "/api/session/active") return send(res, 200, { data: Object.fromEntries([...active].map((s) => [s, { type: "running" }])) });
    if (p === "/api/session" && req.method === "POST") {
      const b = await body(req);
      const id = nextId("ses");
      sessions.set(id, { model: (b.model as Json) ?? { providerID: "opencode", id: "big-pickle" }, messages: [] });
      created.push(id);
      return send(res, 200, { data: { id, model: sessions.get(id)!.model } });
    }
    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return send(res, 404, { message: "no route" });
    const sid = decodeURIComponent(m[1]!), rest = m[2] ?? "";
    const s = sessions.get(sid);
    if (!s) return send(res, 404, { _tag: "SessionNotFoundError", sessionID: sid, message: `Session not found: ${sid}` });
    if (rest === "" && req.method === "GET") return send(res, 200, { data: { id: sid, model: s.model } });
    if (rest === "model" && req.method === "POST") {
      const b = await body(req);
      s.model = b.model as Json;
      modelSwitches.push({ session: sid, model: s.model });
      return send(res, 200, { data: { id: sid, model: s.model } });
    }
    if (rest === "message") return send(res, 200, { data: s.messages });
    const mm = /^message\/(.+)$/.exec(rest);
    if (mm) {
      const msg = s.messages.find((x) => x.id === mm[1]);
      return msg ? send(res, 200, { data: msg }) : send(res, 404, { message: "no message" });
    }
    if (rest === "interrupt") {
      active.delete(sid);
      return send(res, 200, { data: true });
    }
    if (rest === "prompt" && req.method === "POST") {
      const b = await body(req);
      const text = String(((b.prompt ?? {}) as Json).text ?? "");
      if (opts.refusePrompt) return send(res, opts.refusePrompt, { message: "refused" });
      prompts.push({ session: sid, text });
      const userId = nextId("msg");
      s.messages.push({ id: userId, type: "user", text, time: { created: Date.now() } });
      active.add(sid);
      send(res, 200, { data: { admittedSeq: s.messages.length, id: userId, sessionID: sid, delivery: "steer" } });
      const asstId = nextId("msg");
      later(20, () => {
        push("session.next.step.started", { sessionID: sid, assistantMessageID: asstId, model: s.model });
        if (opts.tool) {
          push("session.next.tool.called", { sessionID: sid, assistantMessageID: asstId, callID: "call_1", tool: opts.tool.tool, input: opts.tool.input });
          push("session.next.tool.success", { sessionID: sid, assistantMessageID: asstId, callID: "call_1", result: {}, structured: {},
            content: [{ type: "text", text: "total 8\nhello.html" }], provider: { executed: true } });
        }
        if (opts.compact) {
          push("session.next.compaction.started", { sessionID: sid, messageID: asstId, reason: "auto" });
          push("session.next.compaction.ended", { sessionID: sid, messageID: asstId, reason: "auto", text: "", recent: "" });
          push("session.compacted", { sessionID: sid });
        }
        push("session.next.text.delta", { sessionID: sid, assistantMessageID: asstId, textID: "t0", delta: opts.reply ?? "done" });
      });
      if (opts.stuck) return;
      if (opts.ask || opts.permission) {
        const id = opts.ask ? nextId("que") : nextId("per");
        later(30, () => {
          if (opts.ask) push("question.asked", { id, sessionID: sid, questions: opts.ask });
          else push("permission.asked", { id, sessionID: sid, ...opts.permission, always: [], metadata: opts.permission!.metadata ?? {} });
        });
        waiting.set(id, () => later(20, () => {
          s.messages.push({ id: asstId, type: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: "stop",
            content: [{ type: "text", text: opts.reply ?? "done" }], tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, model: s.model });
          push("session.next.step.ended", { sessionID: sid, assistantMessageID: asstId, finish: "stop" });
          active.delete(sid);
        }));
        return;
      }
      const gap = opts.stepGapMs ?? 0;
      if (gap) {
        later(opts.turnMs ?? 60, () => {
          s.messages.push({ id: nextId("msg"), type: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: "tool-calls",
            content: [{ type: "tool", tool: "read" }], tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, model: s.model });
        });
      }
      later((opts.turnMs ?? 60) + gap, () => {
        s.messages.push({
          id: asstId, type: "assistant", time: { created: Date.now(), completed: Date.now() },
          finish: opts.fail ? "error" : "stop",
          ...(opts.fail ? { error: { message: opts.fail } } : {}),
          content: opts.fail ? [] : [{ type: "text", text: opts.reply ?? "done" }],
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          model: s.model,
        });
        push("session.next.step.ended", { sessionID: sid, assistantMessageID: asstId, finish: opts.fail ? "error" : "stop" });
        active.delete(sid);
      });
      return;
    }
    send(res, 404, { message: `no route ${req.method} ${p}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    opts,
    sessions,
    prompts,
    modelSwitches,
    created,
    replies,
    forget: (session) => { sessions.delete(session); active.delete(session); },
    close: async () => {
      for (const t of timers) clearTimeout(t);
      for (const res of sse) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
