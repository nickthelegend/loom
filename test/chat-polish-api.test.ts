import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, readProjectConfig, writeProjectConfig } from "../src/core/registry.js";
import { setProvider } from "../src/core/providers.js";
import { startTriageChat } from "../src/cli/triage.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon: LoomDaemon, client: DaemonClient, dir: string, id: string, token: string, bin: string;
const api = (route: string, method = "GET", body?: unknown, auth = token) => fetch(`${client.baseUrl}${route}`, {
  method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args],
    { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (error, out, err) => resolve({ code: error ? Number(error.code) || 1 : 0, out, err })));
}
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("polish-home"));
  vi.stubEnv("LOOM_NO_NOTIFY", "1");
  for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) vi.stubEnv(key, "");
  bin = tmpDir("editor-bin");
  const launcher = `require('node:fs').writeFileSync(${JSON.stringify(path.join(bin, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`;
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "launcher.cjs"), launcher);
    fs.writeFileSync(path.join(bin, "code.cmd"), `@"${process.execPath}" "%dp0%launcher.cjs" %*\r\n`);
  } else fs.writeFileSync(path.join(bin, "code"), `#!${process.execPath}\n${launcher}`, { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir();
  id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); vi.unstubAllEnvs(); });

it("titles the first finished echo turn once and emits a rename status", async () => {
  const { chat } = await client.createChat(id, "");
  await client.send(id, "please fix login redirect bug", "execbot", { chat: chat.id });
  await waitUntil(async () => (await client.chats(id)).chats.find(c => c.id === chat.id)?.title === "Fix Login Redirect Bug");
  let events = (await client.chatEvents(id, chat.id, { limit: 200 })).events;
  expect(events.some(e => e.kind === "status" && e.payload.state === "chat_renamed" && e.payload.title === "Fix Login Redirect Bug")).toBe(true);
  await waitUntil(async () => !(await client.project(id)).project.agents.some(a => a.busy));
  await client.send(id, "Add dark mode settings", "execbot", { chat: chat.id });
  await waitUntil(async () => (await client.chatEvents(id, chat.id, { limit: 200 })).events.filter(e => e.kind === "run_complete").length === 2);
  events = (await client.chatEvents(id, chat.id, { limit: 200 })).events;
  expect(events.filter(e => e.payload.state === "chat_renamed")).toHaveLength(1);
  expect((await client.chats(id)).chats.find(c => c.id === chat.id)?.title).toBe("Fix Login Redirect Bug");
});

it("preserves explicit default-looking names and supports manual/automatic CLI titles", async () => {
  const { chat } = await client.createChat(id, "Chat 99");
  await client.send(id, "fix new bug", "execbot", { chat: chat.id });
  await waitUntil(async () => (await client.chatEvents(id, chat.id, { limit: 200 })).events.some(e => e.kind === "run_complete"));
  expect((await client.titleChat(id, chat.id, { auto: true })).chat.title).toBe("Chat 99");
  const result = await cli(["chat:title", chat.id, "My Chosen Name"]);
  expect(result.code, result.err).toBe(0);
  expect(result.out.trim()).toBe("My Chosen Name");
  expect((await cli(["chat:title", chat.id, "--auto"])).out.trim()).toBe("My Chosen Name");
  expect((await cli(["chat:title", chat.id])).out.trim()).toBe("My Chosen Name");
  expect((await api(`/api/projects/${id}/chats/${chat.id}/rename`, "POST", { title: 42 })).status).toBe(400);
});

it("does not overwrite a user rename while a model title is in flight", async () => {
  let finish: (() => void) | undefined;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "local" }] }));
    for await (const _ of req) { /* consume the request */ }
    finish = () => res.end(JSON.stringify({ choices: [{ message: { content: "Generated Model Title" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const cfg = readProjectConfig(dir)!;
  try {
    setProvider("ollama", { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    writeProjectConfig(dir, { ...cfg, chatTitles: "model" });
    await waitUntil(async () => (await client.events(id, undefined, 100)).events.some(e => e.payload.state === "config_reloaded"));
    const { chat } = await client.createChat(id, "");
    await client.send(id, "fix another bug", "execbot", { chat: chat.id });
    await waitUntil(() => !!finish);
    await client.titleChat(id, chat.id, { title: "Chat 123" });
    finish!();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await client.chats(id)).chats.find(c => c.id === chat.id)).toMatchObject({ title: "Chat 123", titleSource: "user" });
  } finally {
    finish?.();
    writeProjectConfig(dir, cfg);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("lists editors, launches literal argv, persists the last choice, and supports CLI file:line", async () => {
  expect((await client.editors()).editors).toContainEqual({ id: "code", label: "VS Code" });
  expect((await client.editors()).lastEditor).toBeNull();
  const file = "space;$(echo injected).ts";
  const opened = await client.openInEditor(id, "code", { path: file, line: 9 });
  expect(opened).toEqual({ editor: "code", path: path.join(fs.realpathSync(dir), file), line: 9 });
  const capture = path.join(bin, "argv.json");
  await waitUntil(() => fs.existsSync(capture));
  expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual(["--goto", `${opened.path}:9`]);
  expect((await new DaemonClient(readDaemonConfig()!).editors()).lastEditor).toBe("code");
  fs.unlinkSync(capture);
  const result = await cli(["open", "--in", "last", "file.ts:7"]);
  expect(result.code, result.err).toBe(0);
  await waitUntil(() => fs.existsSync(capture));
  expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual(["--goto", `${path.join(fs.realpathSync(dir), "file.ts")}:7`]);
});

it("rejects escapes and invalid input and blocks scoped devices while admitting own devices", async () => {
  const outside = tmpDir("outside-editor");
  fs.symlinkSync(outside, path.join(dir, "outside"), "dir");
  for (const body of [{ editor: "code", path: "../bad" }, { editor: "code", path: "outside/file" }, { editor: "code", line: 0 }, { editor: "code", path: [] }, { editor: "no-editor" }]) {
    expect((await api(`/api/projects/${id}/open-in`, "POST", body)).status).toBe(400);
  }
  const pair = async (projects?: string[]) => {
    const mint = await api("/api/pair/new", "POST", projects ? { projects } : {});
    const { token: pairToken } = await mint.json() as { token: string };
    const claim = await api("/api/pair/claim", "POST", { token: pairToken, name: "polish-test" });
    return (await claim.json() as { clientToken: string }).clientToken;
  };
  const scoped = await pair([id]);
  expect((await api("/api/editors", "GET", undefined, scoped)).status).toBe(403);
  expect((await api(`/api/projects/${id}/open-in`, "POST", { editor: "code" }, scoped)).status).toBe(403);
  const own = await pair();
  expect((await api("/api/editors", "GET", undefined, own)).status).toBe(200);
  expect((await api(`/api/projects/${id}/open-in`, "POST", { editor: "code" }, own)).status).toBe(200);
  const mint = await api("/api/pair/new", "POST", { guest: { project: id, chat: "main", role: "reply" } });
  const guestPair = await mint.json() as { token: string };
  const claim = await api("/api/pair/claim", "POST", { token: guestPair.token, name: "guest" });
  const guest = (await claim.json() as { clientToken: string }).clientToken;
  expect((await api("/api/editors", "GET", undefined, guest)).status).toBe(403);
  expect((await api(`/api/projects/${id}/open-in`, "POST", { editor: "code" }, guest)).status).toBe(403);
  expect((await api("/api/editors", "GET", undefined, "invalid")).status).toBe(401);
});

it("opens an echo diagnostic chat in the chosen project with redacted evidence", async () => {
  const chosenDir = makeProjectDir({ name: "diagnostics", agents: [] });
  const chosen = (await client.addProject(chosenDir)).project;
  const project = (await client.project(chosen.id)).project;
  const chat = await startTriageChat(client, project, "echo", "Error: token=private-token at alice@example.com");
  expect(chat.agentId).toBe("echo");
  await waitUntil(async () => (await client.chatEvents(chosen.id, chat.id, { limit: 100 })).events.some(e => e.kind === "run_complete"));
  const events = (await client.chatEvents(chosen.id, chat.id, { limit: 100 })).events;
  const prompt = events.find(e => e.payload.author === "user")!.payload.text as string;
  expect(prompt).toContain("Diagnose this Loom failure");
  expect(prompt).not.toContain("private-token");
  expect(prompt).not.toContain("alice@example.com");
  expect((await client.chats(id)).chats.some(c => c.id === chat.id)).toBe(false);
  const help = await cli(["triage", "--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("--issue");
});
