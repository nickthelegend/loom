import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readDaemonConfig, readProjectState, writeProjectState } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent, RouteStepSpec } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

// Exercise the real queue and rules fallback without launching an external router CLI.
vi.mock("../src/core/claude-cli.js", () => ({
  claudeText: async () => { throw new Error("router unavailable in tests"); },
}));

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-route-chat");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const config = readDaemonConfig()!;
  token = config.adminToken;
  client = new DaemonClient(config);
});
afterAll(async () => { await daemon.close(); });

async function post<T>(id: string, endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/api/projects/${id}${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<T>;
}

async function freshProject() {
  const dir = makeProjectDir({ agents: [
    { id: "plannerbot", kind: "echo", role: "planner" },
    { id: "execbot", kind: "echo", role: "executor" },
    { id: "reviewbot", kind: "echo", role: "reviewer" },
  ] });
  const id = (await client.addProject(dir)).project.id;
  const { chat } = await post<{ chat: { id: string } }>(id, "/chats", { title: "Route thread" });
  return { dir, id, chat: chat.id };
}

const routeEvents = (events: LoomEvent[]) => events.filter((e) => e.kind.startsWith("route_") ||
  ["message", "run_complete", "needs_input", "error", "handoff"].includes(e.kind));

async function completed(id: string) {
  await waitUntil(async () => (await client.routeState(id)).route?.status === "completed");
  // A reviewer's final handoff is asynchronous; include it in the assertions.
  await waitUntil(async () => (await client.project(id)).project.holder === "execbot");
}

async function expectChat(id: string, chat: string, hops: string[]) {
  const events = routeEvents((await client.chatEvents(id, chat)).events);
  expect(events.filter((e) => e.kind === "run_complete").map((e) => e.agentId)).toEqual(hops);
  expect(events.filter((e) => e.kind === "message" && e.payload.author === "loom")).toHaveLength(hops.length);
  expect(events.filter((e) => e.kind === "route_started")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "route_completed")).toHaveLength(1);
  expect(events.every((e) => (e.chat ?? "main") === chat)).toBe(true);
}

describe("routes stay in their chat", () => {
  it("dispatches queued auto prompts into their own threads, across every hop", async () => {
    const { id, chat, dir } = await freshProject();
    const other = (await post<{ chat: { id: string } }>(id, "/chats", { title: "Another route" })).chat.id;
    await client.queuePause(id, true);
    await client.queueAdd(id, { text: "build the first widget", target: "auto", chat });
    await client.queueAdd(id, { text: "build the second widget", target: "auto", chat: other });
    expect((await client.queue(id)).queue.map((item) => item.chat)).toEqual([chat, other]);
    await client.queuePause(id, false);
    await waitUntil(async () => (await client.events(id)).events.filter((e) => e.kind === "route_completed").length === 2);
    await completed(id);
    expect((await client.queue(id)).queue).toEqual([]);
    for (const thread of [chat, other]) await expectChat(id, thread, ["plannerbot", "execbot", "reviewbot"]);
    expect(routeEvents((await client.chatEvents(id, "main")).events)).toEqual([]);
    expect(readProjectState(dir).route?.chat).toBe(other);
  });

  it.each((["auto", ["plannerbot", "execbot", "reviewbot"]] as Array<string | RouteStepSpec[]>).map((spec) => ({ spec })))(
    "keeps a directly started $spec route in its chat", async ({ spec }) => {
      const { id, chat } = await freshProject();
      const { route } = await client.startRoute(id, "build a widget", spec, { chat, router: "rules" });
      expect(route.chat).toBe(chat);
      await completed(id);
      await expectChat(id, chat, ["plannerbot", "execbot", "reviewbot"]);
      expect(routeEvents((await client.chatEvents(id, "main")).events)).toEqual([]);
    },
  );

  it("defaults to main when a route has no chat", async () => {
    const { id, chat } = await freshProject();
    await client.startRoute(id, "build a widget", "auto", { router: "rules" });
    await completed(id);
    await expectChat(id, "main", ["plannerbot", "execbot", "reviewbot"]);
    expect(routeEvents((await client.chatEvents(id, chat)).events)).toEqual([]);
  });

  it("resumes only from an answer in the route's chat", async () => {
    const { id, chat } = await freshProject();
    await client.startRoute(id, "build a widget", [
      { step: "plannerbot", instruction: "ask: which database?" }, "execbot",
    ], { chat });
    await waitUntil(async () => (await client.routeState(id)).route?.status === "waiting_human");
    await client.send(id, "unrelated answer in main", "plannerbot");
    await waitUntil(async () => (await client.chatEvents(id, "main")).events.some((e) => e.kind === "run_complete"));
    expect((await client.routeState(id)).route?.status).toBe("waiting_human");
    await post(id, "/messages", { text: "use sqlite", agentId: "plannerbot", chat });
    await completed(id);
    const events = (await client.chatEvents(id, chat)).events;
    for (const kind of ["needs_input", "route_paused", "route_resumed", "route_completed"]) {
      expect(events.filter((e) => e.kind === kind)).toHaveLength(1);
    }
    expect(events.filter((e) => e.kind === "run_complete").map((e) => e.agentId)).toEqual(["plannerbot", "plannerbot", "execbot"]);
    expect((await client.chatEvents(id, "main")).events.filter((e) => e.kind.startsWith("route_"))).toEqual([]);
  });

  it("keeps loop failures and skipped steps in the originating chat", async () => {
    const { id, chat } = await freshProject();
    await client.startRoute(id, "build a widget", [
      "plannerbot", { step: "execbot", instruction: "fail:try again", onFail: "plannerbot" },
    ], { chat });
    await waitUntil(async () => (await client.routeState(id)).route?.status === "failed");
    let events = (await client.chatEvents(id, chat)).events;
    expect(events.filter((e) => e.kind === "route_step" && e.payload.loopedFrom)).toHaveLength(3);
    expect(events.filter((e) => e.kind === "route_failed")).toHaveLength(1);
    await client.startRoute(id, "nothing to change", ["plannerbot", "execbot?lines>200"], { chat });
    await waitUntil(async () => (await client.routeState(id)).route?.status === "completed");
    events = (await client.chatEvents(id, chat)).events;
    expect(events.filter((e) => e.kind === "route_step" && e.payload.skipped)).toHaveLength(1);
    expect(routeEvents((await client.chatEvents(id, "main")).events)).toEqual([]);
  });

  it("reports an abort in the route's chat", async () => {
    const { id, chat } = await freshProject();
    await client.startRoute(id, "sleep:5000", ["plannerbot", "execbot"], { chat });
    await client.abortRoute(id);
    const events = (await client.chatEvents(id, chat)).events;
    expect(events.find((e) => e.kind === "route_failed")?.payload.aborted).toBe(true);
    expect(routeEvents((await client.chatEvents(id, "main")).events)).toEqual([]);
  });

  it.each([undefined, "saved-thread"])("reports a stale persisted route in %s", async (chat) => {
    const dir = makeProjectDir();
    const state = readProjectState(dir);
    state.route = { id: "stale", task: "unfinished", steps: ["plannerbot"], stepRoles: ["planner"],
      current: 0, status: "running", mode: "static", startedAt: 1, updatedAt: 1, ...(chat ? { chat } : {}) };
    writeProjectState(dir, state);
    const id = (await client.addProject(dir)).project.id;
    expect((await client.routeState(id)).route?.status).toBe("failed");
    const failures = (await client.chatEvents(id, chat ?? "main")).events.filter((e) => e.kind === "route_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload.reason).toBe("daemon restarted mid-route");
  });
});
