/** #422 reuses global search, including owners' phones and the existing scope wall. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { searchSessions } from "../src/daemon/workspace-views.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, admin: string, a: string, b: string, chat: string;
const call = (token: string, path: string, body?: unknown) => fetch(base + path, {
  method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function pair(body: unknown) {
  const p = await (await call(admin, "/api/pair/new", body)).json();
  const token = p.token ?? new URLSearchParams(p.link.split("#")[1]).get("pair");
  return (await (await call("", "/api/pair/claim", { token, name: "r3-phone" })).json()).clientToken as string;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-search"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const cfg = readDaemonConfig()!; client = new DaemonClient(cfg); base = `http://${cfg.host}:${cfg.port}`; admin = cfg.adminToken;
  a = (await client.addProject(makeProjectDir({ name: "r3-first" }))).project.id;
  b = (await client.addProject(makeProjectDir({ name: "r3-second" }))).project.id;
  chat = (await client.createChat(b, "Release planning <safe>")).chat.id;
  await client.send(a, "r3-search-marker first");
  await client.send(b, "r3-search-marker second", undefined, { chat });
  await waitUntil(async () => (await client.searchAll("r3-search-marker")).hits.length >= 4);
});
afterAll(async () => { await daemon.close(); });

it("preserves chat titles when searching unopened project logs, also used by the CLI", async () => {
  const cold = await searchSessions("r3-search-marker", new Map(), null);
  expect(cold.hits.find(h => h.project === b)).toMatchObject({ chat, chatTitle: "Release planning <safe>" });
  expect(cold.hits.find(h => h.project === a)).toMatchObject({ chat: "main", chatTitle: "Main" });
  expect(cold.hits.map(h => h.eventId)).toEqual((await client.searchAll("r3-search-marker")).hits.map(h => h.eventId));
});
it("allows an unscoped paired phone and limits project tokens to their own chats", async () => {
  const phone = await pair({});
  const full = await call(phone, "/api/search?q=r3-search-marker"); expect(full.status).toBe(200);
  expect(new Set((await full.json()).hits.map((h: { project: string }) => h.project))).toEqual(new Set([a, b]));
  const scoped = await pair({ projects: [a] });
  const limited = await call(scoped, "/api/search?q=r3-search-marker"); expect(limited.status).toBe(200);
  expect(new Set((await limited.json()).hits.map((h: { project: string }) => h.project))).toEqual(new Set([a]));
});
it("refuses share-live guests and handles blank queries and truncation", async () => {
  const guest = await pair({ guest: { project: a, chat: "main", role: "reply", name: "Guest" } });
  expect((await call(guest, "/api/search?q=r3-search-marker")).status).toBe(403);
  expect(await (await call(admin, "/api/search?q=%20")).json()).toEqual({ hits: [], truncated: false });
  const limited = await searchSessions("r3-search-marker", new Map(), null, 1);
  expect(limited.hits).toHaveLength(1); expect(limited.truncated).toBe(true);
});
