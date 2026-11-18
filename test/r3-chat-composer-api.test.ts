import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { chatTotals, fillTemplate, templateVariables } from "../src/core/chat-composer.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import type { LoomEvent } from "../src/types.js";

let daemon: LoomDaemon, client: DaemonClient, id: string, dir: string, token: string, message: LoomEvent;
const api = (route: string, method = "GET", body?: unknown, auth = token) => fetch(client.baseUrl + route, {
  method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const base = () => `/api/projects/${id}/chats/main`;
const cli = (args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => {
  execFile(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/cli/index.ts"), ...args],
    { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (error, out, err) => resolve({ code: error ? 1 : 0, out, err }));
});
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r3-composer-home")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir(); id = (await client.addProject(dir)).project.id;
  await client.send(id, "**Remember** this `code`", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.kind === "run_complete"));
  message = (await client.chatEvents(id, "main")).events.find(e => e.kind === "message" && e.payload.author === "user")!;
});
afterAll(async () => { await daemon?.close(); vi.unstubAllEnvs(); });

it("pins real messages idempotently, validates chat ownership, and survives a daemon restart", async () => {
  for (let i = 0; i < 2; i++) expect((await api(base() + "/pins", "POST", { eventId: message.id })).status).toBe(200);
  expect((await (await api(base() + "/pins")).json()).pins).toEqual([message]);
  const other = (await client.createChat(id, "Other")).chat;
  expect((await api(`/api/projects/${id}/chats/${other.id}/pins`, "POST", { eventId: message.id })).status).toBe(400);
  expect((await api(base() + "/pins", "POST", { eventId: "1" })).status).toBe(400);
  await daemon.close();
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  expect((await (await api(base() + "/pins")).json()).pins[0].id).toBe(message.id);
  expect((await api(base() + "/pins", "DELETE", { eventId: message.id })).status).toBe(200);
  expect((await (await api(base() + "/pins")).json()).pins).toEqual([]);
});

it("extends stars into project bookmarks and lists them through the CLI", async () => {
  await api(base() + "/star", "POST", { eventId: message.id });
  const bookmarks = (await client.bookmarks(id)).bookmarks;
  expect(bookmarks).toEqual([{ chat: "main", title: "Main", event: message }]);
  const result = await cli(["bookmarks", "--json"]);
  expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out)[0].event.id).toBe(message.id);
  expect((await api(base() + "/star", "POST", { eventId: 999999 })).status).toBe(400);
  await api(base() + "/star", "POST", { eventId: message.id, on: false });
  expect((await client.bookmarks(id)).bookmarks).toEqual([]);
});

it("synchronizes drafts with revision conflicts and keeps chats separate", async () => {
  expect(await (await api(base() + "/draft")).json()).toEqual({ draft: "", revision: 0 });
  expect(await (await api(base() + "/draft", "PUT", { draft: "desktop draft", revision: 0 })).json()).toEqual({ draft: "desktop draft", revision: 1 });
  expect((await api(base() + "/draft", "PUT", { draft: "stale phone", revision: 0 })).status).toBe(409);
  expect((await (await api(base() + "/draft")).json()).draft).toBe("desktop draft");
  const other = (await client.createChat(id, "Draft")).chat;
  expect((await (await api(`/api/projects/${id}/chats/${other.id}/draft`)).json()).draft).toBe("");
  expect((await api(base() + "/draft", "PUT", { draft: [], revision: 1 })).status).toBe(400);
  await api(base() + "/draft", "PUT", { draft: "", revision: 1 });
  expect((await (await api(base() + "/draft")).json()).revision).toBe(2);
});

it("quotes authoritative Markdown with a source link and sends it as echo context", async () => {
  const response = await api(`/api/projects/${id}/messages`, "POST", { text: "explain this", agentId: "execbot", replyTo: message.id });
  expect(response.status).toBe(200);
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.filter(e => e.kind === "run_complete").length === 2);
  const events = (await client.chatEvents(id, "main")).events;
  const sent = events.filter(e => e.payload.author === "user").at(-1)!;
  expect(sent.payload.text).toContain(`Reply to message #${message.id}`);
  expect(sent.payload.text).toContain("> **Remember** this `code`\n\nexplain this");
  expect(events.filter(e => e.kind === "message" && e.agentId).at(-1)!.payload.text).toContain("Remember");
  expect((await api(`/api/projects/${id}/messages`, "POST", { text: "x", replyTo: -1 })).status).toBe(400);
  const md = await (await api(base() + `/markdown?eventId=${message.id}`)).json();
  expect(md.markdown).toBe(message.payload.text); expect(md.quote).toContain(`/m/${message.id}`);
  expect((await (await api(base() + "/markdown")).json()).markdown).toContain("## You\n\n**Remember**");
});

it("uses the saved prompt library for named templates and literal variables, including CLI", async () => {
  expect((await api("/api/templates", "POST", { name: "review", text: "Review {{ file }} for {{issue}} and {{file}}" })).status).toBe(200);
  expect((await client.templates()).templates.find(t => t.title === "review")!.variables).toEqual(["file", "issue"]);
  expect((await api("/api/templates/review/render", "POST", { values: { file: "a" } })).status).toBe(400);
  expect((await client.renderTemplate("review", { file: "$&", issue: "<script>" })).text).toBe("Review $& for <script> and $&");
  const result = await cli(["templates", "use", "review", "--var", "file=x.ts", "--var", "issue=bugs"]);
  expect(result.code, result.err).toBe(0); expect(result.out.trim()).toBe("Review x.ts for bugs and x.ts");
  await client.saveTemplate("review", "New {{value}}");
  expect((await client.templates()).templates.filter(t => t.title === "review")).toHaveLength(1);
  await client.deleteTemplate("review");
  expect((await api("/api/templates/review/render", "POST", { values: {} })).status).toBe(404);
  expect(templateVariables("{{x}} {{x}} {{ other-name }}")).toEqual(["x", "other-name"]);
  expect(() => fillTemplate("{{toString}}", {})).toThrow("missing variable");
});

it("totals all completed turns once and persists individual tool output folds", async () => {
  await client.send(id, "run: echo test output", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.filter(e => e.kind === "run_complete").length === 3);
  const events = (await client.chatEvents(id, "main", { limit: 1000 })).events;
  const tool = events.find(e => e.kind === "tool_call")!;
  expect(tool).toBeTruthy();
  expect((await api(base() + "/presentation", "PUT", { eventId: tool.id, expanded: true })).status).toBe(200);
  const p = await (await api(base() + "/presentation")).json();
  expect(p.expanded[tool.id]).toBe(true); expect(p.turns).toBe(3); expect(p.costUsd).toBeCloseTo(0.003); expect(p.tokens).toBeGreaterThan(0);
  expect(p).toMatchObject(chatTotals(events));
  await api(base() + "/presentation", "PUT", { eventId: tool.id, expanded: false });
  expect((await (await api(base() + "/presentation")).json()).expanded[tool.id]).toBe(false);
  expect((await api(base() + "/presentation", "PUT", { eventId: message.id, expanded: true })).status).toBe(400);
});

it("guests never reach chat state; scoped devices reach their own project's chats; the machine-wide template library is the owner's", async () => {
  async function pair(body: unknown) {
    const { token } = await (await api("/api/pair/new", "POST", body)).json();
    return (await (await api("/api/pair/claim", "POST", { token, name: "r3" })).json()).clientToken as string;
  }
  const scoped = await pair({ projects: [id] }), own = await pair({});
  const guest = await pair({ guest: { project: id, chat: "main", role: "reply" } });
  for (const route of [base() + "/pins", base() + "/draft", base() + "/presentation", `/api/projects/${id}/bookmarks`, "/api/templates"]) expect((await api(route, "GET", undefined, guest)).status).toBe(403);
  expect((await api(base() + "/pins", "POST", { eventId: message.id }, guest)).status).toBe(403);
  // a device scoped to this project sees this project's pins and drafts, but not the machine-wide library
  for (const route of [base() + "/pins", base() + "/draft", `/api/projects/${id}/bookmarks`]) expect((await api(route, "GET", undefined, scoped)).status).toBe(200);
  expect((await api("/api/templates", "GET", undefined, scoped)).status).toBe(403);
  expect((await api("/api/templates", "POST", { name: "x", text: "y" }, scoped)).status).toBe(403);
  // the owner's own unscoped device writes templates, like the admin
  expect((await api(base() + "/draft", "GET", undefined, own)).status).toBe(200);
  expect((await api("/api/templates", "POST", { name: "phone template", text: "Hi {{name}}" }, own)).status).toBe(200);
  expect((await api("/api/templates/phone%20template/render", "POST", { values: { name: "Phone" } }, own)).status).toBe(200);
  expect((await api("/api/templates/phone%20template/render", "POST", { values: { name: "Guest" } }, scoped)).status).toBe(403);
});

it("keeps drafts, bookmarks and tool folds across restarts and removes state with a deleted chat", async () => {
  const current = await (await api(base() + "/draft")).json();
  await api(base() + "/draft", "PUT", { draft: "restart me", revision: current.revision });
  await api(base() + "/star", "POST", { eventId: message.id });
  const before = await (await api(base() + "/presentation")).json();
  await daemon.close(); daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  expect((await (await api(base() + "/draft")).json()).draft).toBe("restart me");
  expect((await client.bookmarks(id)).bookmarks[0]!.event.id).toBe(message.id);
  expect(await (await api(base() + "/presentation")).json()).toEqual(before);
  const { chat } = await client.createChat(id, "Delete draft");
  const route = `/api/projects/${id}/chats/${chat.id}`;
  await api(route + "/draft", "PUT", { draft: "temporary", revision: 0 });
  expect((await api(route, "DELETE")).status).toBe(200);
  expect((await api(route + "/draft")).status).toBe(404);
  const { readProjectState } = await import("../src/core/registry.js");
  expect(readProjectState(dir).chatComposer?.[chat.id]).toBeUndefined();
});
