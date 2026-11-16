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

import { readProjectConfig } from "../src/core/registry.js";
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

  it("model or effort without an agent", async () => {
    const r = await project();
    expect(() => r.createChat("x", { model: "echo-fast" })).toThrow(/need an agentId/);
    expect(() => r.createChat("x", { effort: "high" })).toThrow(/need an agentId/);
  });

});

describe("a thread's model reaches the turn", () => {
  it("isolates models and effort, reuses instances, and restores defaults without changing the roster", async () => {
    const r = await project();
    const before = readProjectConfig(r.info.dir);
    const a = r.createChat("fast", { agentId: "execbot", model: "echo-fast", effort: "low" });
    const b = r.createChat("deep", { agentId: "execbot", model: "echo-deep", effort: "high" });
    const send = async (chat: string, count: number) => {
      await r.sendMessage("hello", undefined, { chat });
      await waitUntil(() => !r.anyBusy() && r.log.list({ kinds: ["run_complete"] }).length === count);
      return r.log.list({ kinds: ["run_complete"] }).at(-1)!;
    };
    expect((await send(a.id, 1)).payload).toMatchObject({ model: "echo-fast", effort: "low" });
    expect((await send(b.id, 2)).payload).toMatchObject({ model: "echo-deep", effort: "high" });
    const starts = r.log.list({ kinds: ["status"] }).filter(e => e.agentId === "execbot" && e.payload.state === "started").length;
    expect((await send(a.id, 3)).payload).toMatchObject({ model: "echo-fast", effort: "low" });
    expect(r.log.list({ kinds: ["status"] }).filter(e => e.agentId === "execbot" && e.payload.state === "started")).toHaveLength(starts);
    r.setChatAgent(a.id, "execbot");
    expect((await send(a.id, 4)).payload.model).toBe("echo-1");
    expect(r.chatBinding(b.id)).toEqual({ agentId: "execbot", model: "echo-deep", effort: "high" });
    expect(readProjectConfig(r.info.dir)).toEqual(before);
    const info = r.info;
    await r.close();
    rt = await ProjectRuntime.open(info);
    expect(rt.chatBinding(b.id)).toEqual({ agentId: "execbot", model: "echo-deep", effort: "high" });
    rt.setChatAgent(b.id, null);
    expect(rt.chats().find(c => c.id === b.id)).not.toHaveProperty("effort");
    expect(rt.chats().find(c => c.id === b.id)).not.toHaveProperty("model");
  });

  it("changing a chat selection mid-turn leaves that answer alone", async () => {
    const r = await project();
    const chat = r.createChat("switch", { agentId: "execbot", model: "old", effort: "low" });
    await r.sendMessage("sleep:300", undefined, { chat: chat.id });
    expect(r.setChatAgent(chat.id, "execbot", "new", "high")).toMatchObject({ model: "new", effort: "high" });
    await waitUntil(() => !r.anyBusy());
    expect(r.log.list({ kinds: ["run_complete"] }).at(-1)!.payload).toMatchObject({ model: "old", effort: "low" });
    await r.sendMessage("next", undefined, { chat: chat.id });
    await waitUntil(() => !r.anyBusy());
    expect(r.log.list({ kinds: ["run_complete"] }).at(-1)!.payload).toMatchObject({ model: "new", effort: "high" });
  });

  it("an explicit other agent does not inherit the chat's model or effort", async () => {
    const r = await project();
    await r.handoff("plannerbot");
    const chat = r.createChat("pinned", { agentId: "execbot", model: "special", effort: "high" });
    await r.sendMessage("hi", "plannerbot", { chat: chat.id });
    await waitUntil(() => !r.anyBusy());
    expect(r.log.list({ kinds: ["run_complete"] }).at(-1)!.payload.model).toBe("echo-1");
    expect(r.log.list({ kinds: ["run_complete"] }).at(-1)!.payload.effort).toBeUndefined();
  });

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
        body: JSON.stringify({ title: "with exec", agentId: "execbot", model: "echo-fast", effort: "low" }),
      });
      const chat = (made.body as unknown as { chat: { id: string; agentId: string } }).chat;
      expect(chat).toMatchObject({ agentId: "execbot", model: "echo-fast", effort: "low" });

      const sent = await api(`/api/projects/${pid}/messages`, {
        method: "POST", body: JSON.stringify({ text: "hello over HTTP", chat: chat.id }),
      });
      expect(sent.status).toBe(200);
      await waitUntil(async () => {
        const events = await api(`/api/projects/${pid}/events?chat=${chat.id}`);
        return (events.body as unknown as { events: Array<{ kind: string; agentId?: string; payload: Record<string, unknown> }> }).events
          .some(e => e.kind === "run_complete" && e.agentId === "execbot" && e.payload.model === "echo-fast" && e.payload.effort === "low");
      });

      const listed = await api(`/api/projects/${pid}/chats`);
      const rows = (listed.body as unknown as { chats: Array<{ id: string; agentId?: string }> }).chats;
      expect(rows.find((c) => c.id === chat.id)!.agentId).toBe("execbot");

      const rebound = await api(`/api/projects/${pid}/chats/${chat.id}/agent`, {
        method: "POST",
        body: JSON.stringify({ agentId: "plannerbot", model: "echo-deep", effort: "high" }),
      });
      expect(rebound.body.chat).toMatchObject({ agentId: "plannerbot", model: "echo-deep", effort: "high" });

      const unbound = await api(`/api/projects/${pid}/chats/${chat.id}/agent`, {
        method: "POST",
        body: JSON.stringify({ agentId: null }),
      });
      expect((unbound.body as unknown as { chat: { agentId?: string } }).chat.agentId).toBeUndefined();

      expect(unbound.body.chat).not.toHaveProperty("model");
      expect(unbound.body.chat).not.toHaveProperty("effort");
      for (const selection of [{ model: 1 }, { effort: ["high"] }, { model: "m".repeat(201) }]) {
        const invalid = await api(`/api/projects/${pid}/chats/${chat.id}/agent`, {
          method: "POST", body: JSON.stringify({ agentId: "execbot", ...selection }),
        });
        expect(invalid.status).toBe(400);
      }

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
