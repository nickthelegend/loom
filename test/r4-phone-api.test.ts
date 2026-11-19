import http from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { defaultQuiet } from "../src/core/phone-r4/preferences.js";
import * as boardModule from "../src/daemon/board.js";
import { sendExpoPush } from "../src/daemon/push.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, client: DaemonClient, base: string, admin: string, owner: string, scoped: string, guest: string, other: string, project: string, foreign: string, ownerId: string;
let deliveries: Array<{ to: string; categoryId?: string; data: Record<string, unknown> }> = [];
let sink: http.Server;
const oldHome = process.env.LOOM_HOME, oldPush = process.env.LOOM_EXPO_PUSH_URL, oldNoPush = process.env.LOOM_NO_PUSH;
async function request(path: string, method = "GET", body?: unknown, token = owner) {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any };
}
async function pair(projects?: string[], guestScope?: object) {
  const { data } = await request("/api/pair/new", "POST", { ...(projects ? { projects } : {}), ...(guestScope ? { guest: guestScope } : {}) }, admin);
  const claimed = await request("/api/pair/claim", "POST", { token: data.token, name: "phone" }, admin);
  return claimed.data as { clientToken: string; clientId: string };
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-phone-api"); process.env.LOOM_NO_NOTIFY = "1"; delete process.env.LOOM_NO_PUSH;
  sink = http.createServer((req, res) => { let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => { deliveries.push(...JSON.parse(body)); res.end('{"data":[]}'); }); });
  await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
  process.env.LOOM_EXPO_PUSH_URL = `http://127.0.0.1:${(sink.address() as { port: number }).port}`;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  admin = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  project = (await client.addProject(makeProjectDir({ name: "phone" }))).project.id;
  foreign = (await client.addProject(makeProjectDir({ name: "other" }))).project.id;
  const o = await pair(); owner = o.clientToken; ownerId = o.clientId;
  other = (await pair()).clientToken; scoped = (await pair([project])).clientToken;
  guest = (await pair(undefined, { project, chat: "main", role: "reply", name: "Guest", hours: 1 })).clientToken;
  expect((await request("/api/push/register", "POST", { token: "ExponentPushToken[owner]" })).data.clientId).toBe(ownerId);
  await request("/api/push/register", "POST", { token: "ExponentPushToken[other]" }, other);
}, 30000);
afterAll(async () => {
  await daemon?.close(); await new Promise<void>(resolve => sink?.close(() => resolve()));
  if (oldHome === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = oldHome;
  if (oldPush === undefined) delete process.env.LOOM_EXPO_PUSH_URL; else process.env.LOOM_EXPO_PUSH_URL = oldPush;
  if (oldNoPush === undefined) delete process.env.LOOM_NO_PUSH; else process.env.LOOM_NO_PUSH = oldNoPush;
});
it("quiet hours persist for the owner across admin and paired phones; guests cannot read or write", async () => {
  const q = { ...defaultQuiet, enabled: true, timeZone: "Asia/Kolkata", snoozeUntil: Date.now() + 3600000 };
  expect((await request("/api/push/quiet", "PUT", q)).data.quiet).toEqual(q);
  expect((await request("/api/push/quiet")).data.quiet).toEqual(q);
  expect((await request("/api/push/quiet", "GET", undefined, other)).data.quiet).toEqual(q);
  expect((await request("/api/push/quiet", "GET", undefined, admin)).data.quiet).toEqual(q);
  expect((await request("/api/push/quiet", "GET", undefined, scoped)).data.quiet).toEqual(defaultQuiet);
  expect((await request("/api/push/quiet", "PUT", { ...q, start: "27:99" })).status).toBe(400);
  for (const method of ["GET", "PUT"]) expect((await request("/api/push/quiet", method, method === "PUT" ? q : undefined, guest)).status).toBe(403);
});
it("filters actual Expo deliveries for quiet hours, approval bypass and chat mute", async () => {
  deliveries = [];
  const message = (category: string, kind = "run_complete") => ({ title: "phone", body: "test", data: { projectId: project, chat: "main", category, kind } });
  await sendExpoPush(["ExponentPushToken[owner]", "ExponentPushToken[other]"], message("done"));
  expect(deliveries).toHaveLength(0);
  deliveries = [];
  await sendExpoPush(["ExponentPushToken[owner]"], message("approvals", "approval"));
  expect(deliveries[0]!.data.clientId).toBe(ownerId);
  const path = `/api/projects/${project}/chats/main/notification-level`;
  expect((await request(path, "PUT", { level: "none" })).status).toBe(200);
  deliveries = [];
  await sendExpoPush(["ExponentPushToken[owner]"], message("approvals", "approval")); expect(deliveries).toHaveLength(1);
  deliveries = [];
  await request("/api/push/quiet", "PUT", defaultQuiet); await request(path, "PUT", { level: "needs-you" });
  await sendExpoPush(["ExponentPushToken[owner]"], message("done")); expect(deliveries).toHaveLength(0);
  await sendExpoPush(["ExponentPushToken[owner]"], message("questions", "needs_input")); expect(deliveries).toHaveLength(1); expect(deliveries[0]!.categoryId).toBe("loom-reply");
});
it("permits scoped chat preferences for their project and refuses cross-project and guests", async () => {
  expect((await request(`/api/projects/${project}/chats/main/notification-level`, "PUT", { level: "none" }, scoped)).status).toBe(200);
  expect((await request(`/api/projects/${foreign}/chats/main/notification-level`, "PUT", { level: "none" }, scoped)).status).toBe(403);
  expect((await request(`/api/projects/${project}/chats/main/notification-level`, "GET", undefined, guest)).status).toBe(403);
  expect((await request(`/api/projects/${project}/chats/missing/notification-level`, "PUT", { level: "none" })).status).toBe(404);
});
it("Now returns running turns and unanswered questions in the correct chat without scope leaks", async () => {
  const chat = (await request(`/api/projects/${project}/chats`, "POST", { title: "right chat" })).data.chat.id;
  await request(`/api/projects/${project}/messages`, "POST", { text: "sleep:600 ask: ready?", agentId: "plannerbot", chat, handoff: true });
  await waitUntil(async () => (await request("/api/phone/now")).data.rows.some((r: any) => r.kind === "running" && r.chat === chat));
  await waitUntil(async () => (await request("/api/phone/now")).data.rows.some((r: any) => r.kind === "needs-you" && r.chat === chat));
  await request(`/api/projects/${foreign}/messages`, "POST", { text: "ask: private?", agentId: "plannerbot", handoff: true });
  await waitUntil(async () => (await request("/api/phone/now")).data.rows.some((r: any) => r.projectId === foreign));
  const result = await request("/api/phone/now", "GET", undefined, scoped);
  expect(result.data.rows.every((r: any) => r.projectId === project)).toBe(true);
  expect((await request("/api/phone/now", "GET", undefined, guest)).status).toBe(403);
  const reply = { deliveryId: "notification-test-receipt", text: "Continue", chat, agentId: "plannerbot", handoff: true };
  expect((await request(`/api/projects/${project}/messages`, "POST", reply)).status).toBe(200);
  expect((await request(`/api/projects/${project}/messages`, "POST", reply)).status).toBe(200);
  await waitUntil(async () => !(await request("/api/phone/now")).data.rows.some((r: any) => r.kind === "running"));
  const events = (await request(`/api/projects/${project}/events?chat=${chat}`)).data.events;
  expect(events.filter((e: any) => e.kind === "message" && !e.agentId && e.payload.text === "Continue")).toHaveLength(1);
});
it("owner phone creates and edits existing trigger API, with real next-runs preview", async () => {
  const path = `/api/projects/${project}/triggers`;
  const body = { phoneEditor: true, name: "Phone", prompt: "Run the tests", kind: "schedule", every: "2h", agent: "plannerbot" };
  const made = await request(path, "POST", body); expect(made.status).toBe(200);
  const id = made.data.trigger.id;
  const changed = await request(`${path}/${id}`, "PATCH", { phoneEditor: true, prompt: "Explain that", cron: "0 9 * * 1-5" }); expect(changed.status).toBe(200); expect(changed.data.trigger.prompt).toBe("Explain that"); expect(changed.data.trigger.everyMin).toBeUndefined();
  const preview = await request(`/api/projects/${project}/phone/trigger-preview`, "POST", { every: "2h" }); expect(preview.data.runs).toHaveLength(5); expect(preview.data.runs[1] - preview.data.runs[0]).toBe(7200000);
  expect((await request(`/api/projects/${project}/phone/trigger-preview`, "POST", { cron: "bad" })).status).toBe(400);
  for (const token of [scoped, guest]) { expect((await request(path, "POST", body, token)).status).toBe(403); expect((await request(`${path}/${id}`, "PATCH", { phoneEditor: true, prompt: "no" }, token)).status).toBe(403); }
  expect((await request(path, "POST", { ...body, agent: "not-present" })).status).toBe(400);
  const webhook = await request(path, "POST", { phoneEditor: true, kind: "webhook", prompt: "Explain {{body}}" }); expect(webhook.data.secret).toBeTruthy(); expect(webhook.data.path).toContain(webhook.data.trigger.id);
  const list = await request(path); expect(list.data.triggers.find((t: any) => t.id === webhook.data.trigger.id).secret).toBeUndefined();
  // The extension must not elevate unrelated owner-device routes.
  expect((await request("/api/push/test", "POST", {})).status).toBe(403);
});
it("brief validates its date window and retains scoped project access", async () => {
  const end = Date.now(), start = end - 86400000;
  const result = await request(`/api/projects/${project}/phone/brief?start=${start}&end=${end}`, "GET", undefined, scoped);
  expect(result.status).toBe(200); expect(result.data.finishedTurns).toBeGreaterThan(0); expect(result.data.spend).toBeGreaterThan(0); expect(Array.isArray(result.data.prs)).toBe(true);
  expect((await request(`/api/projects/${project}/phone/brief?start=NaN&end=1`)).status).toBe(400);
  expect((await request(`/api/projects/${foreign}/phone/brief?start=${start}&end=${end}`, "GET", undefined, scoped)).status).toBe(403);
});

it("owner web controls can select a phone while scoped devices cannot change another device", async () => {
  expect((await request(`/api/push/quiet?device=${ownerId}`, "PUT", { ...defaultQuiet, start: "20:00" }, admin)).status).toBe(200);
  expect((await request("/api/push/quiet")).data.quiet.start).toBe("20:00");
  expect((await request(`/api/push/quiet?device=${ownerId}`, "PUT", defaultQuiet, scoped)).status).toBe(403);
  expect((await request(`/api/push/quiet?device=missing`, "GET", undefined, admin)).status).toBe(404);
});

it("Now includes live pending approvals and removes them when the phone answers", async () => {
  const abort = new AbortController();
  const pending = (daemon as unknown as { askHuman(input: { project: string; agent: string; tool: string; input: unknown; signal: AbortSignal }): Promise<{ behavior: string }> }).askHuman({ project, agent: "execbot", tool: "Edit", input: { file_path: "test.txt" }, signal: abort.signal });
  try {
    let id = "";
    await waitUntil(async () => { const row = (await request("/api/phone/now")).data.rows.find((r: any) => r.projectId === project && r.kind === "approval"); id = row?.id ?? ""; return Boolean(id); });
    const row = (await request("/api/phone/now")).data.rows.find((r: any) => r.id === id); expect(row.chat).toBe("main");
    expect((await request(`/api/projects/${project}/approvals/${id}`, "POST", { decision: "deny" })).status).toBe(200);
    expect((await pending).behavior).toBe("deny");
    expect((await request("/api/phone/now")).data.rows.some((r: any) => r.id === id)).toBe(false);
  } finally { abort.abort(); await pending; }
});

// These exercise the real route/runtime; agents are the echo fixtures above.
const runtime = () => (daemon as any).runtime(project);
it("admin preferences without a device reach all owner phones and the push policy", async () => {
  await request("/api/push/quiet", "PUT", defaultQuiet, admin);
  const path = `/api/projects/${project}/chats/main/notification-level`;
  await request(path, "PUT", { level: "none" }, admin);
  expect((await request(path)).data.level).toBe("none");
  expect((await request(path, "GET", undefined, other)).data.level).toBe("none");
  deliveries = [];
  await sendExpoPush(["ExponentPushToken[owner]", "ExponentPushToken[other]"], { title: "test", body: "test", data: { category: "done", projectId: project } });
  expect(deliveries).toHaveLength(0);
  await request(path, "PUT", { level: "all" });
});
it("newest eligible pairing owns duplicate push tokens, even when it mutes the chat", async () => {
  const token = "ExponentPushToken[duplicate]", old = await pair();
  await request("/api/push/register", "POST", { token }, old.clientToken);
  await new Promise(r => setTimeout(r, 5));
  const fresh = await pair([project]);
  await request("/api/push/register", "POST", { token }, fresh.clientToken);
  const path = `/api/projects/${project}/chats/main/notification-level`;
  await request(path, "PUT", { level: "none" }, fresh.clientToken);
  deliveries = [];
  const message = { title: "test", body: "test", data: { category: "done", projectId: project, kind: "run_complete" } };
  await sendExpoPush([token], message); expect(deliveries).toHaveLength(0);
  await request(path, "PUT", { level: "all" }, fresh.clientToken);
  await sendExpoPush([token], message); expect(deliveries).toHaveLength(1); expect(deliveries[0]!.data.clientId).toBe(fresh.clientId);
});
it("Now bounds history to a week and shares a scan for five seconds", async () => {
  const rt = await runtime(), scan = vi.spyOn(rt.log, "list"), now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6000);
  try {
    await request("/api/phone/now"); await request("/api/phone/now", "GET", undefined, other);
    const history = () => scan.mock.calls.filter(([q]: any) => q.kinds?.includes("needs_input"));
    expect(history()).toHaveLength(1);
    expect(history()[0]![0]).toMatchObject({ sinceTs: now + 6000 - 7 * 86400000, activeLineages: true });
    clock.mockReturnValue(now + 11001); await request("/api/phone/now"); expect(history()).toHaveLength(2);
  } finally { clock.mockRestore(); scan.mockRestore(); }
});
it("brief shares in-flight work and reuses the result for ten minutes per date range", async () => {
  const build = vi.spyOn(boardModule, "buildBoard").mockResolvedValue({ cards: [] } as any);
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const path = `/api/projects/${project}/phone/brief?start=1000&end=2000`;
  try {
    const [a, b] = await Promise.all([request(path), request(path)]);
    expect(a.data).toEqual(b.data); expect(build).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 599999); await request(path); expect(build).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 600000); await request(path); expect(build).toHaveBeenCalledTimes(2);
    await request(`/api/projects/${project}/phone/brief?start=2000&end=3000`); expect(build).toHaveBeenCalledTimes(3);
  } finally { build.mockRestore(); clock.mockRestore(); }
});
it("held approvals show a deadline, push when quiet ends, and timed-out approvals remain visible", async () => {
  await request("/api/push/quiet", "PUT", { ...defaultQuiet, allowApprovals: false, snoozeUntil: Date.now() + 60000 });
  deliveries = [];
  const pending = (daemon as any).askHuman({ project, agent: "execbot", tool: "Edit", input: { file_path: "held.txt" } });
  let approval: any;
  try {
    await waitUntil(async () => { approval = (await request("/api/phone/now")).data.rows.find((r: any) => r.kind === "approval" && !r.id.startsWith("missed:")); return !!approval; });
    expect(approval.held).toBe(true); expect(approval.expiresAt).toBeGreaterThan(Date.now()); expect(approval.title).toContain("answer by");
    expect(deliveries.filter(d => d.data.approvalId === approval.id)).toHaveLength(0);
    await request("/api/push/quiet", "PUT", defaultQuiet);
    await waitUntil(() => deliveries.some(d => d.data.approvalId === approval.id));
    (daemon as any).approvals.get(approval.id).settle({ behavior: "deny", message: "No answer within 10 minutes — denied." });
    await pending;
    await waitUntil(async () => (await request("/api/phone/now")).data.rows.some((r: any) => r.id === "missed:" + approval.id && r.chat === "main" && r.title.includes("timed out while quiet")));
  } finally { if (approval) (daemon as any).approvals.get(approval.id)?.settle({ behavior: "deny" }); await pending; await request("/api/push/quiet", "PUT", defaultQuiet); }
});
