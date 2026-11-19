import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, readProjectConfig, readProjectState, writeProjectState } from "../src/core/registry.js";
import { agentEnvironment, sessionSettings } from "../src/core/agents-r4/store.js";
import { setProvider } from "../src/core/providers.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, id: string, dir: string, token: string;
const api = (route: string, method = "GET", body?: unknown, auth = token) => fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const project = (route = "") => `/api/projects/${id}${route}`;
const json = async (route: string, method = "GET", body?: unknown, auth = token) => { const r = await api(route, method, body, auth); const b = await r.json(); expect(r.status, JSON.stringify(b)).toBe(200); return b; };
const cli = (args: string[]) => new Promise<{ code: number; out: string; err: string }>(resolve => execFile(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (error, out, err) => resolve({ code: error ? 1 : 0, out, err })));
beforeAll(async () => {
  vi.stubEnv("LOOM_AGENTS_ARCHIVE_SWEEP_MS", "100");
  vi.stubEnv("LOOM_HOME", tmpDir("r4-home")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  dir = makeProjectDir(); id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); vi.unstubAllEnvs(); });

it("saves profiles and creates fresh agents with the bundled choices through API and CLI", async () => {
  await json("/api/profiles/reviewer", "PUT", { kind: "echo", model: "echo-2", effort: "high", mode: "ask", instructions: "Explain each decision." });
  const added = await json(project("/agents"), "POST", { profile: "reviewer" });
  const cfg = readProjectConfig(dir)!.agents.find(a => a.id === added.id)!;
  expect(cfg.options).toMatchObject({ model: "echo-2", effort: "high", permissions: "ask" }); expect(cfg.instructions).toBe("Explain each decision.");
  const result = await cli(["agents:add", "--profile", "reviewer", "--as", "profile-cli"]);
  expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out).id).toBe("profile-cli");
  const list = await cli(["profiles", "list"]); expect(list.code, list.err).toBe(0); expect(JSON.parse(list.out)[0].name).toBe("reviewer");
  const ordinary = await cli(["agents:add", "echo", "--as", "ordinary"]); expect(ordinary.code, ordinary.err).toBe(0); expect(ordinary.out).toContain("+ ordinary");
  expect((await api(project("/agents"), "POST", { profile: "missing" })).status).toBe(404);
  expect((await api("/api/profiles/bad", "PUT", { kind: "echo", mode: "root" })).status).toBe(400);
});

it("extends existing archive flags with filtered lists, search, labels and idle archiving", async () => {
  const c = (await client.createChat(id, "Archive me")).chat;
  await client.send(id, "unique archive phrase", "execbot", { chat: c.id });
  await waitUntil(async () => (await client.chatEvents(id, c.id)).events.some(e => e.kind === "run_complete"));
  await json(project(`/chats/${c.id}/labels`), "PUT", { labels: ["bug", { name: "urgent", color: "#ff0000" }, "bug"] });
  expect((await json(project("/chats?label=bug"))).chats.map((x: any) => x.id)).toEqual([c.id]);
  const archived = await cli(["chat:archive", c.id]); expect(archived.code, archived.err).toBe(0);
  expect((await json(project("/chats?archived=0"))).chats.some((x: any) => x.id === c.id)).toBe(false);
  expect((await json(project("/chats?archived=1"))).chats[0].labels).toHaveLength(2);
  expect((await json(project("/chats/search?q=unique"))).hits).toEqual([]);
  expect((await json(project("/chats/search?q=unique&archived=1"))).hits.length).toBeGreaterThan(0);
  expect((await json(project(`/chats/search?q=unique&chat=${c.id}`))).hits.length).toBeGreaterThan(0);
  expect((await json(project("/chats/search?q=unique&archived=1&label=missing"))).hits).toEqual([]);
  expect((await cli(["chat:archive", c.id, "--restore"])).code).toBe(0);
  expect((await cli(["chat:label", c.id, "review", "docs"])).code).toBe(0);
  const old = (await client.createChat(id, "Old idle chat")).chat;
  const state = readProjectState(dir); state.chats!.find(x => x.id === old.id)!.createdAt = 1; writeProjectState(dir, state);
  await json(project("/session-settings"), "PUT", { autoArchiveDays: 30 });
  await waitUntil(() => readProjectState(dir).chats!.find(x => x.id === old.id)!.archived === true);
  await json(project(`/chats/${old.id}`), "PATCH", { archived: false });
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(readProjectState(dir).chats!.find(x => x.id === old.id)!.archived).not.toBe(true);
  expect((await api(project(`/chats/${c.id}/labels`), "PUT", { labels: [{ name: "x", color: '" onclick="bad' }] })).status).toBe(400);
});

it("clones options and instructions into independent sessions without private environment values", async () => {
  const src = readProjectConfig(dir)!.agents.find(a => a.id === "profile-cli")!;
  await json(project(`/agents/${src.id}/env`), "PUT", { key: "R4_TEST", value: "private-env-value" });
  const result = await cli(["agents:clone", src.id, "--count", "2", "--model", "echo-3"]);
  expect(result.code, result.err).toBe(0);
  const { agents } = JSON.parse(result.out);
  expect(agents).toHaveLength(2); expect(agents[0].id).not.toBe(agents[1].id);
  for (const a of agents) { expect(a.options).toMatchObject({ model: "echo-3", effort: "high", permissions: "ask" }); expect(a.instructions).toBe(src.instructions); expect(agentEnvironment(id, a.id)).toEqual({}); expect(readProjectState(dir).agents[a.id]?.sessionId).toBeUndefined(); }
});

it("keeps environment values daemon-only, redacts echoed values, and preserves names after restart", async () => {
  await json(project("/agents/plannerbot/enabled"), "PUT", { enabled: false });
  expect(await json(project("/agents/plannerbot/env"), "PUT", { key: "WHILE_DISABLED", value: "saved-for-next-start" })).toEqual({ names: ["WHILE_DISABLED"] });
  await json(project("/agents/plannerbot/enabled"), "PUT", { enabled: true });
  const secret = "a-private-value-458", set = await cli(["agents:env", "execbot", "set", `R4_SECRET=${secret}`]);
  expect(set.code, set.err).toBe(0); expect(set.out).not.toContain(secret); expect(JSON.parse(set.out).names).toContain("R4_SECRET");
  expect(agentEnvironment(id, "execbot").R4_SECRET).toBe(secret);
  expect(JSON.stringify(await json(project()))).not.toContain(secret);
  expect(fs.readFileSync(path.join(dir, ".loom", "config.json"), "utf8")).not.toContain(secret);
  await client.send(id, `Repeat ${secret}`, "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.kind === "run_complete"));
  expect(JSON.stringify((await client.chatEvents(id, "main")).events)).not.toContain(secret);
  expect(JSON.stringify(await json(project("/agents/execbot/options")))).not.toContain(secret);
  const files = fs.readdirSync(path.join(process.env.LOOM_HOME!, "agent-environment"));
  expect(files.length).toBeGreaterThan(0);
  // Windows does not expose POSIX owner-only mode bits.
  if (process.platform !== "win32") expect(fs.statSync(path.join(process.env.LOOM_HOME!, "agent-environment", files[0]!)).mode & 0o777).toBe(0o600);
  await daemon.close(); daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  expect((await json(project("/agents/execbot/env"))).names).toContain("R4_SECRET");
  expect((await cli(["agents:env", "execbot", "unset", "R4_SECRET"])).code).toBe(0);
  expect((await json(project("/agents/execbot/env"))).names).toEqual([]);
});

it("interrupts time-limited turns, exposes needs-you, and continues through normal sending", async () => {
  await json(project("/agents/execbot/limits"), "PUT", { maxTurnMinutes: 0.002 });
  const before = (await client.chatEvents(id, "main")).events.at(-1)?.id ?? 0;
  await client.send(id, "sleep:2000", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.id > before && e.kind === "needs_input" && e.payload.reason === "turn_time_limit"));
  const p = (await client.project(id)).project; expect(p.needsInput).toBe(true); expect(p.agents.find(a => a.id === "execbot")!.busy).toBe(false);
  await client.send(id, "Continue", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.id > before && e.kind === "run_complete"));
  await json(project("/agents/execbot/limits"), "PUT", { maxTurnMinutes: 0 });
});

it("sleeps idle agents without dropping the baton or bindings and wakes for the next turn", async () => {
  const state = readProjectState(dir); state.agents.execbot = { ...state.agents.execbot, sessionId: "saved-echo-session" }; writeProjectState(dir, state);
  const result = await cli(["agents:limit", "execbot", "--sleep-minutes", "0.001"]); expect(result.code, result.err).toBe(0);
  await waitUntil(async () => (await json(project())).project.agents.find((a: any) => a.id === "execbot").asleep === true);
  const before = (await client.chatEvents(id, "main")).events.at(-1)?.id ?? 0;
  expect((await client.project(id)).project.holder).toBe("execbot");
  expect(readProjectState(dir).agents.execbot?.sessionId).toBe("saved-echo-session");
  const roster = await cli(["agents"]); expect(roster.code, roster.err).toBe(0); expect(roster.out).toContain("Asleep");
  await client.send(id, "wake up", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.id > before && e.kind === "run_complete"));
  await json(project("/agents/execbot/limits"), "PUT", { idleSleepMinutes: 0 });
  expect(readProjectState(dir).agents.execbot?.sessionId).toBe("saved-echo-session");
});

it("summarizes only unread activity offline and remembers CLI progress", async () => {
  const c = (await client.createChat(id, "Catch up")).chat;
  await client.send(id, "Catchup evidence", "execbot", { chat: c.id });
  await waitUntil(async () => (await client.chatEvents(id, c.id)).events.some(e => e.kind === "run_complete"));
  const result = await cli(["catchup", c.id, "--json"]); expect(result.code, result.err).toBe(0);
  const r = JSON.parse(result.out); expect(r.mode).toBe("offline"); expect(r.summary).toContain("Catchup evidence");
  const again = await cli(["catchup", c.id, "--json"]); expect(JSON.parse(again.out).count).toBe(0);
  expect((await api(project(`/chats/${c.id}/catchup`), "POST", { since: -1 })).status).toBe(400);
});

it("uses a helper only on explicit opt-in and falls back offline if it fails", async () => {
  let calls = 0, refuse = false, prompt = "";
  const helper = http.createServer((req, res) => {
    let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
      calls++; prompt = JSON.parse(body).messages[0].content;
      res.writeHead(refuse ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "A concise helper summary" } }] }));
    });
  });
  await new Promise<void>(resolve => helper.listen(0, "127.0.0.1", resolve));
  try {
    setProvider("r4-helper", { baseUrl: `http://127.0.0.1:${(helper.address() as { port: number }).port}`, key: "test" });
    const c = (await client.createChat(id, "Helper catchup")).chat;
    await client.send(id, "Unread helper evidence", "execbot", { chat: c.id });
    await waitUntil(async () => (await client.chatEvents(id, c.id)).events.some(e => e.kind === "run_complete"));
    const route = project(`/chats/${c.id}/catchup`);
    expect((await json(route, "POST", { since: 0, markRead: false })).mode).toBe("offline"); expect(calls).toBe(0);
    expect(await json(route, "POST", { since: 0, markRead: false, model: "r4-helper/test" })).toMatchObject({ mode: "model", summary: "A concise helper summary" });
    expect(calls).toBe(1); expect(prompt).toContain("Unread helper evidence");
    refuse = true;
    expect(await json(route, "POST", { since: 0, markRead: false, model: "r4-helper/test" })).toMatchObject({ mode: "offline", fallback: true });
  } finally { await new Promise<void>(resolve => helper.close(() => resolve())); }
});

it("accepts owner devices, confines scoped project tokens, and rejects share-live guests", async () => {
  async function pair(body: unknown) { const { token } = await json("/api/pair/new", "POST", body); return (await json("/api/pair/claim", "POST", { token, name: "r4" })).clientToken; }
  const phone = await pair({}), scoped = await pair({ projects: [id] }), guest = await pair({ guest: { project: id, chat: "main", role: "reply" } });
  for (const who of [token, phone]) {
    expect((await api(project("/agents"), "POST", { profile: "reviewer" }, who)).status).toBe(200);
    expect((await api("/api/profiles", "GET", undefined, who)).status).toBe(200);
    const suggestions = await api(project("/agents/models?kind=echo"), "GET", undefined, who);
    expect((await suggestions.json()).profiles).toContainEqual({ name: "reviewer", model: "echo-2" });
    expect((await api(project("/agents/execbot/env"), "PUT", { key: "PHONE", value: "private" }, who)).status).toBe(200);
  }
  for (const route of ["/session-settings", "/agents/execbot/env", "/chats?all=1"]) expect((await api(project(route), "GET", undefined, scoped)).status).toBe(200);
  expect((await api(project("/agents/execbot/limits"), "PUT", { retries: { count: 2, waitSeconds: 1 } }, scoped)).status).toBe(200);
  expect((await api(project("/agents/execbot/env"), "PUT", { key: "X", value: "x" }, scoped)).status).toBe(403);
  expect((await api("/api/profiles", "GET", undefined, scoped)).status).toBe(403);
  const suggestions = await api(project("/agents/models?kind=echo"), "GET", undefined, scoped);
  expect(suggestions.status).toBe(200);
  expect(await suggestions.json()).not.toHaveProperty("profiles");
  for (const profile of ["reviewer", "missing-profile"]) {
    const denied = await api(project("/agents"), "POST", { profile }, scoped);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "profiles require the owner or an unscoped device" });
    expect((await api(project("/agents"), "POST", { profile }, guest)).status).toBe(403);
  }
  expect((await api(project("/agents"), "POST", { kind: "echo", id: "scoped-added" }, scoped)).status).toBe(200);
  for (const route of [project("/session-settings"), project("/agents/execbot/env"), "/api/profiles"]) expect((await api(route, "GET", undefined, guest)).status).toBe(403);
  const other = (await client.addProject(makeProjectDir())).project.id;
  expect((await api(`/api/projects/${other}/agents/execbot/env`, "GET", undefined, scoped)).status).toBe(403);
  expect(sessionSettings(dir).agents.execbot!.retries).toEqual({ count: 2, waitSeconds: 1 });
});

it.each([null, "--flag", ["--flag"], 3, true])("rejects non-object agent options %j before merging profiles", async options => {
  const before = readProjectConfig(dir)!.agents.length;
  for (const body of [{ kind: "echo", options }, { profile: "reviewer", options }]) {
    const response = await api(project("/agents"), "POST", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "options must be an object" });
  }
  expect(readProjectConfig(dir)!.agents.length).toBe(before);
});

it("stores short environment values privately without corrupting later messages", async () => {
  await json(project("/agents/execbot/env"), "PUT", { key: "FLAG", value: "1" });
  await json(project("/agents/execbot/env"), "PUT", { key: "SECRET", value: "12345678901234567890" });
  const before = (await client.chatEvents(id, "main")).events.at(-1)?.id ?? 0;
  await client.send(id, "message 1 with 12345678901234567890", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.id > before && e.kind === "run_complete"));
  const stored = (await client.chatEvents(id, "main")).events.filter(e => e.id > before);
  expect(stored.find(e => e.kind === "message" && !e.agentId)?.payload.text).toBe("message 1 with [redacted]");
  expect(JSON.stringify(stored)).not.toContain("12345678901234567890");
});

it("registers profile CLI options publicly and preserves ordinary add help and errors", async () => {
  const help = await cli(["agents:add", "--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("<kind> [options] | --profile <name> [options]");
  expect(help.out).toContain("--profile <name>");
  expect((await cli(["agents:add"])).code).toBe(1);
  expect(fs.readFileSync(path.resolve("src/cli/r4-agents.ts"), "utf8")).not.toContain("_actionHandler");
});
