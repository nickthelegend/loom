import { afterAll, beforeAll, expect, it, vi } from "vitest";
import http from "node:http";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { deliverOnce } from "../src/core/message-receipts.js";
import { projectPushGroup, sendExpoPush } from "../src/daemon/push.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, id: string, other: string, owner: string, scoped: string;
const api = (route: string, method = "GET", body?: unknown, token = owner) => fetch(client.baseUrl + route, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function pair(projects?: string[]) {
  const created = await api("/api/pair/new", "POST", projects ? { projects } : {}, readDaemonConfig()!.adminToken);
  const { token } = await created.json();
  return (await (await api("/api/pair/claim", "POST", { token, name: "batch phone" })).json()).clientToken as string;
}
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r3-phone-home")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  id = (await client.addProject(makeProjectDir())).project.id;
  other = (await client.addProject(makeProjectDir())).project.id;
  owner = await pair(); scoped = await pair([id]);
});
afterAll(async () => { await daemon?.close(); vi.unstubAllEnvs(); });

it("delivers concurrent phone retries once, rejects changed content, and retains receipts after restart", async () => {
  const body = { text: "phone retry needle", agentId: "execbot", chat: "main", deliveryId: "phone-retry-421", handoff: true };
  const replies = await Promise.all([api(`/api/projects/${id}/messages`, "POST", body), api(`/api/projects/${id}/messages`, "POST", body)]);
  expect(replies.map(r => r.status)).toEqual([200, 200]);
  expect(await replies[0]!.json()).toEqual(await replies[1]!.json());
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.kind === "run_complete"));
  expect((await client.chatEvents(id, "main")).events.filter(e => e.kind === "message" && e.payload.author === "user")).toHaveLength(1);
  expect((await api(`/api/projects/${id}/messages`, "POST", { ...body, text: "changed" })).status).toBe(409);
  await api(`/api/projects/${id}/handoff`, "POST", { to: "plannerbot" });
  expect((await api(`/api/projects/${id}/messages`, "POST", body)).status).toBe(200);
  expect((await (await api(`/api/projects/${id}`)).json()).project.holder).toBe("plannerbot");
  await api(`/api/projects/${id}/handoff`, "POST", { to: "execbot" });
  await daemon.close(); daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!);
  expect((await api(`/api/projects/${id}/messages`, "POST", body)).status).toBe(200);
  expect((await client.chatEvents(id, "main")).events.filter(e => e.payload.author === "user")).toHaveLength(1);
});

it("searches the selected phone chat and preserves project-scoped access", async () => {
  const chat = (await client.createChat(id, "Side")).chat;
  expect((await api(`/api/projects/${id}/messages`, "POST", { text: "side needle", chat: chat.id, agentId: "execbot", deliveryId: "scoped-send-421" }, scoped)).status).toBe(200);
  const search = async (chatId: string) => (await (await api(`/api/projects/${id}/chats/search?chat=${chatId}&q=needle`, "GET", undefined, scoped)).json()).hits;
  expect((await search("main")).every((h: { chat: string }) => h.chat === "main")).toBe(true);
  expect((await search(chat.id)).some((h: { snippet: string }) => h.snippet.includes("side needle"))).toBe(true);
  expect((await api(`/api/projects/${other}/chats/search?q=needle`, "GET", undefined, scoped)).status).toBe(403);
  expect((await api(`/api/projects/${other}/messages`, "POST", { text: "no", deliveryId: "scoped-denied" }, scoped)).status).toBe(403);
  const { token } = await (await api("/api/pair/new", "POST", { guest: { project: id, chat: "main", role: "reply" } }, readDaemonConfig()!.adminToken)).json();
  const guest = await (await api("/api/pair/claim", "POST", { token, name: "Guest" })).json();
  expect((await api(`/api/projects/${id}/chats/search?q=needle`, "GET", undefined, guest.clientToken)).status).toBe(403);
  expect((await api(`/api/projects/${id}/messages`, "POST", { text: "no", deliveryId: "guest-denied-421" }, guest.clientToken)).status).toBe(400);
});

it("never blindly replays an uncertain delivery and isolates device receipts", async () => {
  const dir = makeProjectDir(); let sends = 0;
  await expect(deliverOnce(dir, "phone", "delivery", { text: "x" }, async () => { sends++; throw new Error("crash"); })).rejects.toThrow("crash");
  await expect(deliverOnce(dir, "phone", "delivery", { text: "x" }, async () => { sends++; })).rejects.toThrow("uncertain");
  await deliverOnce(dir, "other phone", "delivery", { text: "x" }, async () => { sends++; return { ok: true }; });
  expect(sends).toBe(2);
});

it("sends project grouping keys to Expo while preserving every notification's routing and actions", async () => {
  const received: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => { let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => { received.push(...JSON.parse(body)); res.end("{}"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("LOOM_NO_PUSH", ""); vi.stubEnv("LOOM_EXPO_PUSH_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  try {
    for (const projectId of ["a", "a", "b"]) await sendExpoPush(["ExponentPushToken[test]"], { title: "Loom", body: "event", categoryId: "loom-approval", data: { projectId, daemon: "computer", chat: "side", approvalId: "approval" } });
    expect(received[0]!.threadId).toBe(received[1]!.threadId);
    expect(received[0]!.threadId).not.toBe(received[2]!.threadId);
    expect(received[0]!.data.projectGroup).toBe(received[0]!.threadId);
    expect(received[0]!.data.chat).toBe("side"); expect(received[0]!.categoryId).toBe("loom-approval");
    expect(projectPushGroup({ projectId: "a", daemon: "other" })).not.toBe(received[0]!.threadId);
    await sendExpoPush(["token"], { title: "Update", body: "new version" }); expect(received[3]!.threadId).toBeUndefined();
    const registration = await api("/api/push/register", "POST", { token: "ExponentPushToken[group421]", platform: "android", groupByProject: true });
    expect(registration.status).toBe(200);
    await client.send(id, "Grouped Android background push", "execbot");
    await waitUntil(() => received.some(r => r.to === "ExponentPushToken[group421]"));
    const android = received.find(r => r.to === "ExponentPushToken[group421]")!;
    expect(android.title).toBeUndefined(); expect(android.body).toBeUndefined();
    expect(android.priority).toBe("high"); expect(android.data.loomTitle).toContain("done");
    expect(android.data.loomBody).toContain("Grouped Android background push");
    expect(android.data.projectGroup).toBe(android.threadId);
    expect(android.data.projectId).toBe(id);
    await api("/api/push/register", "POST", { token: "ExponentPushToken[group421]", platform: "android" });
    expect(readDaemonConfig()!.clients.find(c => c.pushToken === "ExponentPushToken[group421]")!.pushGroupByProject).toBe(false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
