/**
 * A thread that remembers who answers in it.
 *
 * Until now a chat was a label on events: whoever held the baton answered
 * everywhere, so two threads could not be talking to two agents. The rule this
 * adds, and the one these tests hold: a pinned thread answers with its own
 * agent **without touching the baton**, because the baton is the write lock
 * for work on the repository and a conversation doesn't need it.
 */

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

async function project() {
  process.env.LOOM_HOME = tmpDir("home-chat-agents");
  process.env.LOOM_NO_NOTIFY = "1";
  const dir = makeProjectDir({
    name: "threads",
    agents: [
      { id: "plannerbot", kind: "echo", role: "planner" },
      { id: "execbot", kind: "echo", role: "executor" },
      { id: "watcher", kind: "kiro", role: "general" },
    ],
  });
  rt = await ProjectRuntime.open({ id: `threads-${Date.now()}`, name: "threads", dir });
  return rt!;
}

/** Messages an agent produced, in one chat. */
const saidIn = (r: ProjectRuntime, chat: string) =>
  r.log
    .list({ kinds: ["message"], limit: 200 })
    .filter((e) => e.chat === chat && e.agentId)
    .map((e) => `${e.agentId}: ${String(e.payload.text)}`);

describe("binding a thread to an agent", () => {
  it("answers with the thread's agent, not the baton holder", async () => {
    const r = await project();
    await r.handoff("plannerbot"); // the baton is over here
    const chat = r.createChat("with exec", { agentId: "execbot" });

    const sent = await r.sendMessage("hello there", undefined, { chat: chat.id });
    expect(sent.agentId).toBe("execbot");

    await waitUntil(async () => saidIn(r, chat.id).length > 0);
    expect(saidIn(r, chat.id)[0]).toMatch(/^execbot:/);
    // …and the baton never moved, because a conversation isn't a write lock.
    expect((await r.status()).holder).toBe("plannerbot");
  });

  it("an explicit target still wins — you asked for that one", async () => {
    const r = await project();
    const chat = r.createChat("with exec", { agentId: "execbot" });
    await r.handoff("plannerbot");
    const sent = await r.sendMessage("hi", "plannerbot", { chat: chat.id });
    expect(sent.agentId).toBe("plannerbot");
  });

  it("two threads, two agents, at the same time", async () => {
    const r = await project();
    const a = r.createChat("planning", { agentId: "plannerbot" });
    const b = r.createChat("doing", { agentId: "execbot" });

    await r.sendMessage("think about it", undefined, { chat: a.id });
    await r.sendMessage("do it", undefined, { chat: b.id });

    await waitUntil(async () => saidIn(r, a.id).length > 0 && saidIn(r, b.id).length > 0);
    expect(saidIn(r, a.id).join()).toMatch(/plannerbot/);
    expect(saidIn(r, a.id).join()).not.toMatch(/execbot/);
    expect(saidIn(r, b.id).join()).toMatch(/execbot/);
    expect(saidIn(r, b.id).join()).not.toMatch(/plannerbot/);
  });

  it("the main thread still follows the baton", async () => {
    const r = await project();
    await r.handoff("execbot");
    const sent = await r.sendMessage("main thread", undefined, {});
    expect(sent.agentId).toBe("execbot");
    expect(() => r.setChatAgent("main", "plannerbot")).toThrow(/follows the baton/);
  });

  it("can be unbound, and goes back to following the baton", async () => {
    const r = await project();
    const chat = r.createChat("pinned", { agentId: "execbot" });
    expect(r.setChatAgent(chat.id, null)!.agentId).toBeUndefined();
    await r.handoff("plannerbot");
    expect((await r.sendMessage("now what", undefined, { chat: chat.id })).agentId).toBe("plannerbot");
  });

  it("survives the agent leaving the roster", async () => {
    const r = await project();
    const chat = r.createChat("doomed", { agentId: "execbot" });
    await r.removeAgent("execbot");
    // The conversation is still readable and still typeable — it falls back to
    // the baton rather than becoming a thread nobody can use.
    const sent = await r.sendMessage("still here?", undefined, { chat: chat.id });
    expect(sent.agentId).toBe("plannerbot");
  });
});

describe("what a thread refuses to be bound to", () => {
  it("an agent that isn't in the project", async () => {
    const r = await project();
    expect(() => r.createChat("x", { agentId: "ghost" })).toThrow(/no agent "ghost"/);
  });

  it("a bridge, which can't take turns at all", async () => {
    const r = await project();
    expect(() => r.createChat("x", { agentId: "watcher" })).toThrow(/bridge/);
  });

  it("a model, when the agent can't change model per turn", async () => {
    const r = await project();
    // echo bakes nothing per turn; binding a model here would be a setting
    // that silently did nothing, so it's refused where it can be fixed.
    expect(() => r.createChat("x", { agentId: "execbot", model: "gpt-9" })).toThrow(
      /can't change model per thread/,
    );
  });
});

describe("a thread's model reaches the turn", () => {
  it("is handed to an adapter that can honour it", async () => {
    process.env.LOOM_HOME = tmpDir("home-chat-model");
    process.env.LOOM_NO_NOTIFY = "1";
    const dir = makeProjectDir({
      name: "modelled",
      agents: [{ id: "cheap", kind: "model", role: "general", options: { provider: "nowhere" } }],
    });
    rt = await ProjectRuntime.open({ id: `m-${Date.now()}`, name: "modelled", dir });
    const chat = rt.createChat("on the cheap one", { agentId: "cheap", model: "some/model:free" });
    expect(chat.model).toBe("some/model:free");

    // The provider isn't configured, so the turn fails — but it fails having
    // been asked, which is what proves the binding reached the adapter.
    await rt.sendMessage("hello", undefined, { chat: chat.id });
    await waitUntil(async () => rt!.log.list({ kinds: ["error"], limit: 10 }).length > 0);
    const err = String(rt.log.list({ kinds: ["error"], limit: 10 })[0]!.payload.message);
    expect(err).toMatch(/isn't configured/);
  });
});

// ---------------------------------------------------------------------------
// The same thing over HTTP, because the routes are where a field name goes
// wrong quietly.
// ---------------------------------------------------------------------------

describe("over the wire", () => {
  it("creates a bound thread, rebinds it, and refuses what the runtime refuses", async () => {
    process.env.LOOM_HOME = tmpDir("home-chat-http");
    process.env.LOOM_NO_NOTIFY = "1";
    const { LoomDaemon } = await import("../src/daemon/server.js");
    const { readDaemonConfig } = await import("../src/core/registry.js");
    const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const { host, port } = await daemon.listen();
    const base = `http://${host}:${port}`;
    const token = readDaemonConfig()!.adminToken;
    const api = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      return { status: res.status, body: (await res.json()) as Record<string, never> };
    };

    try {
      const dir = makeProjectDir({
        name: "wire",
        agents: [
          { id: "plannerbot", kind: "echo", role: "planner" },
          { id: "execbot", kind: "echo", role: "executor" },
        ],
      });
      const added = await api("/api/projects", { method: "POST", body: JSON.stringify({ dir }) });
      const pid = (added.body as unknown as { project: { id: string } }).project.id;

      const made = await api(`/api/projects/${pid}/chats`, {
        method: "POST",
        body: JSON.stringify({ title: "with exec", agentId: "execbot" }),
      });
      const chat = (made.body as unknown as { chat: { id: string; agentId: string } }).chat;
      expect(chat.agentId).toBe("execbot");

      const listed = await api(`/api/projects/${pid}/chats`);
      const rows = (listed.body as unknown as { chats: Array<{ id: string; agentId?: string }> }).chats;
      expect(rows.find((c) => c.id === chat.id)!.agentId).toBe("execbot");

      const rebound = await api(`/api/projects/${pid}/chats/${chat.id}/agent`, {
        method: "POST",
        body: JSON.stringify({ agentId: "plannerbot" }),
      });
      expect((rebound.body as unknown as { chat: { agentId: string } }).chat.agentId).toBe("plannerbot");

      const unbound = await api(`/api/projects/${pid}/chats/${chat.id}/agent`, {
        method: "POST",
        body: JSON.stringify({ agentId: null }),
      });
      expect((unbound.body as unknown as { chat: { agentId?: string } }).chat.agentId).toBeUndefined();

      const bad = await api(`/api/projects/${pid}/chats`, {
        method: "POST",
        body: JSON.stringify({ agentId: "ghost" }),
      });
      expect(bad.status).toBe(400);
      expect(String((bad.body as unknown as { error: string }).error)).toMatch(/no agent/);

      const noSuchThread = await api(`/api/projects/${pid}/chats/nope/agent`, {
        method: "POST",
        body: JSON.stringify({ agentId: "execbot" }),
      });
      expect(noSuchThread.status).toBe(404);
    } finally {
      await daemon.close();
    }
  }, 60_000);
});
