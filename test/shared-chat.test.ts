/**
 * Share live (approach credit: Nuphos's shared sessions): a link lets a teammate into one chat —
 * view, reply or approve — and its token reaches that chat and nothing else.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "acp-fake-agent.mjs");
let daemon: LoomDaemon;
let base: string;
let admin: string;
let pid: string;
let other: string;
let shared: string;
let privateChat: string;

const call = (token: string, method: string, p: string, body?: unknown) =>
  fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

async function invite(role: string, name = "Ada", hours?: number) {
  const made = await (await call(admin, "POST", "/api/pair/new", { guest: { project: pid, chat: shared, role, name, ...(hours ? { hours } : {}) } })).json() as { link: string; guest: { role: string } };
  expect(made.link).toContain("&guest=1");
  const token = new URLSearchParams(made.link.split("#")[1]).get("pair")!;
  const claim = await (await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "browser" }) })).json() as { clientToken: string; clientId: string };
  return claim;
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-shared");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  base = `http://${cfg.host}:${cfg.port}`;
  admin = cfg.adminToken;
  const client = new DaemonClient(cfg);
  pid = (await client.addProject(makeProjectDir({ name: "shared", agents: [
    { id: "bot", kind: "echo", role: "worker" },
    { id: "asker", kind: "acp", role: "worker", options: { command: [process.execPath, fake], permissions: "ask" } },
  ] } as never))).project.id;
  other = (await client.addProject(makeProjectDir({ name: "elsewhere" }))).project.id;
  shared = (await (await call(admin, "POST", `/api/projects/${pid}/chats`, { title: "Pairing on the parser" })).json() as { chat: { id: string } }).chat.id;
  privateChat = (await (await call(admin, "POST", `/api/projects/${pid}/chats`, { title: "Mine only" })).json() as { chat: { id: string } }).chat.id;
  await call(admin, "POST", `/api/projects/${pid}/messages`, { text: "a private note", chat: privateChat, agentId: "bot" });
}, 60_000);
afterAll(async () => { await daemon.close(); });

describe("Share live", () => {
  it("a reply guest reads and writes its chat, under its own name — and reaches nothing else", async () => {
    const g = await invite("reply");
    const me = await (await call(g.clientToken, "GET", "/api/guest")).json() as { chat: { title: string }; role: string; name: string };
    expect(me).toMatchObject({ chat: { title: "Pairing on the parser" }, role: "reply", name: "Ada" });
    // the agent is busy, so Ada's message waits in the queue — and keeps her name when it goes (CI caught this)
    await call(admin, "POST", `/api/projects/${pid}/messages`, { text: "sleep:1500 busy elsewhere", chat: privateChat, agentId: "bot" });
    const sent = await (await call(g.clientToken, "POST", `/api/projects/${pid}/messages`, { text: "hello from Ada", agentId: "bot", chat: privateChat })).json() as { queued?: number };
    expect(sent.queued).toBeGreaterThan(0);
    // it landed in the shared chat, not the one it asked for, under Ada's name
    await waitUntil(async () => {
      const { events } = await (await call(admin, "GET", `/api/projects/${pid}/events?chat=${shared}&limit=100`)).json() as { events: Array<{ kind: string; agentId?: string; payload: { text?: string; by?: string } }> };
      return events.some((e) => e.kind === "message" && e.payload.by === "Ada" && e.payload.text === "hello from Ada") &&
        events.some((e) => e.kind === "message" && e.agentId === "bot" && String(e.payload.text).includes("hello from Ada"));
    }, 30_000);
    // reading another chat gives its own chat instead
    const read = await (await call(g.clientToken, "GET", `/api/projects/${pid}/events?chat=${privateChat}&limit=200`)).json() as { events: Array<{ payload: { text?: string } }> };
    expect(JSON.stringify(read.events)).not.toContain("a private note");
    expect(JSON.stringify(read.events)).toContain("hello from Ada");
    for (const [m, p] of [["GET", "/api/projects"], ["GET", `/api/projects/${pid}`], ["GET", `/api/projects/${pid}/files`], ["GET", `/api/projects/${pid}/chats`],
      ["POST", `/api/projects/${pid}/terminals`], ["GET", `/api/projects/${other}/events`], ["POST", "/api/pair/new"], ["GET", "/api/team"]] as const) {
      expect((await call(g.clientToken, m, p, m === "POST" ? {} : undefined)).status, `${m} ${p}`).toBe(403);
    }
  }, 60_000);

  it("its live socket carries its chat only, and never another project", async () => {
    const g = await invite("view");
    const frames: Array<{ type: string; event?: { chat?: string; payload?: { text?: string } } }> = [];
    const ws = new WebSocket(base.replace("http", "ws") + `/ws?project=${pid}`, [`loom.bearer.${g.clientToken}`]);
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    await call(admin, "POST", `/api/projects/${pid}/messages`, { text: "for the private chat", chat: privateChat, agentId: "bot" });
    await call(admin, "POST", `/api/projects/${pid}/messages`, { text: "for the shared chat", chat: shared, agentId: "bot" });
    await waitUntil(() => frames.some((f) => f.event?.payload?.text === "for the shared chat"), 20_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(frames.some((f) => JSON.stringify(f).includes("for the private chat"))).toBe(false);
    expect(frames.filter((f) => f.event).every((f) => f.event!.chat === shared)).toBe(true);
    ws.close();
    const wrong = new WebSocket(base.replace("http", "ws") + `/ws?project=${other}`, [`loom.bearer.${g.clientToken}`]);
    const code = await new Promise<number>((r) => wrong.once("close", (c) => r(c)));
    expect(code).toBe(4403);
    // and a viewer can't send
    expect((await call(g.clientToken, "POST", `/api/projects/${pid}/messages`, { text: "x" })).status).toBe(403);
  }, 60_000);

  it("an approve guest answers its chat's approvals, and the thread says who", async () => {
    const g = await invite("approve", "Grace");
    await call(admin, "POST", `/api/projects/${pid}/handoff`, { to: "asker" }); // the baton is the owner's to move
    const sent = await call(g.clientToken, "POST", `/api/projects/${pid}/messages`, { text: "run: ls", agentId: "asker" });
    expect(sent.status, await sent.clone().text()).toBe(200);
    let id = "";
    await waitUntil(async () => {
      const { approvals } = await (await call(g.clientToken, "GET", `/api/projects/${pid}/approvals`)).json() as { approvals: Array<{ id: string; chat?: string }> };
      id = approvals[0]?.id ?? "";
      return Boolean(id);
    }, 20_000);
    expect((await call(g.clientToken, "POST", `/api/projects/${pid}/approvals/${id}`, { decision: "allow" })).status).toBe(200);
    await waitUntil(async () => {
      const { events } = await (await call(admin, "GET", `/api/projects/${pid}/events?chat=${shared}&limit=200`)).json() as { events: Array<{ kind: string; payload: { phase?: string; by?: string; text?: string } }> };
      return events.some((e) => e.kind === "approval" && e.payload.phase === "decided" && e.payload.by === "Grace") &&
        events.some((e) => e.kind === "message" && String(e.payload.text).startsWith("permission: yes-once"));
    }, 20_000);
  }, 60_000);

  it("a guest link ends when it expires or is revoked", async () => {
    const g = await invite("reply", "Brief", 1);
    expect((await call(g.clientToken, "GET", "/api/guest")).status).toBe(200);
    // the owner sees it among paired clients, and revokes it
    const list = await (await call(admin, "GET", "/api/pair/clients")).json() as { clients: Array<{ id: string; guest?: { role: string } }> };
    expect(list.clients.find((c) => c.id === g.clientId)?.guest?.role).toBe("reply");
    expect((await call(admin, "DELETE", `/api/pair/clients/${g.clientId}`)).status).toBe(200);
    expect((await call(g.clientToken, "GET", "/api/guest")).status).toBe(401);
    // an expired one: wind its clock back
    const old = await invite("reply", "Old");
    const { readDaemonConfig: read, writeDaemonConfig: write } = await import("../src/core/registry.js");
    const cfg = read()!;
    cfg.clients.find((c) => c.id === old.clientId)!.guest!.expiresAt = Date.now() - 1;
    write(cfg);
    (daemon as unknown as { auth: { reload(): void } }).auth.reload();
    expect((await call(old.clientToken, "GET", "/api/guest")).status).toBe(401);
  }, 60_000);

  it("the owner's phone can invite a teammate into a chat; it still can't pair a device, and nor can a guest or a scoped token", async () => {
    const pairAs = async (body: Record<string, unknown>) => {
      const p = await (await call(admin, "POST", "/api/pair/new", body)).json() as { token: string };
      return (await (await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.token }) })).json() as { clientToken: string }).clientToken;
    };
    const phone = await pairAs({});
    const scoped = await pairAs({ projects: [pid] });
    const guest = (await invite("approve", "Lin")).clientToken;
    const guestLink = { guest: { project: pid, chat: shared, role: "reply", name: "Sam" } };
    const fromPhone = await call(phone, "POST", "/api/pair/new", guestLink);
    expect(fromPhone.status).toBe(200);
    expect(((await fromPhone.json()) as { link: string }).link).toContain("&guest=1");
    expect((await call(phone, "POST", "/api/pair/new", {})).status).toBe(403);
    expect((await call(scoped, "POST", "/api/pair/new", guestLink)).status).toBe(403);
    expect((await call(guest, "POST", "/api/pair/new", guestLink)).status).toBe(403);
  }, 30_000);
});
