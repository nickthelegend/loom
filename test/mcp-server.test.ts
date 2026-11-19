import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { registerAgentKind } from "../src/adapters/index.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");
const cli = ["--import", "tsx", path.join(root, "src/cli/index.ts")];
const home = tmpDir("mcp-home");
let daemon: LoomDaemon, client: DaemonClient, project: string, other: string, admin: string, scoped: string;
let child: ChildProcessWithoutNullStreams;
let sequence = 0;
const responses = new Map<number | null, any>();
const captures: Array<Pick<SendInput, "text" | "mcp">> = [];
class McpEcho extends EchoAdapter {
  override readonly capabilities = { ...this.capabilities, mcp: true };
  override async send(input: SendInput) {
    captures.push({ text: input.text, mcp: input.mcp });
    return super.send(input);
  }
}
const headers = (token?: string) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) });
const http = (body: unknown, token: string | undefined = admin, extra: Record<string, string> = {}) => fetch(`${client.baseUrl}/mcp`, {
  method: "POST", headers: { ...headers(token), ...extra }, body: JSON.stringify(body),
});
async function call(name: string, args: Record<string, unknown> = {}, token = admin): Promise<any> {
  const res = await http({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: `loom_${name}`, arguments: args } }, token);
  expect(res.status).toBe(200);
  return res.json();
}
async function stdio(method: string, params?: unknown): Promise<any> {
  const id = ++sequence;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  await waitUntil(() => responses.has(id));
  return responses.get(id);
}
async function pair(projects: string[]) {
  const minted = await fetch(`${client.baseUrl}/api/pair/new`, { method: "POST", headers: headers(admin), body: JSON.stringify({ projects }) }).then(r => r.json()) as any;
  return (await fetch(`${client.baseUrl}/api/pair/claim`, { method: "POST", headers: headers(), body: JSON.stringify({ token: minted.token }) }).then(r => r.json()) as any).clientToken as string;
}

beforeAll(async () => {
  process.env.LOOM_HOME = home;
  process.env.LOOM_NO_NOTIFY = "1";
  registerAgentKind("echo", (cfg, cwd) => new McpEcho(cfg.id, "echo", cwd, cfg.options));
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  admin = readDaemonConfig()!.adminToken;
  const dir = makeProjectDir({ name: "mcp-project" });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd: dir });
  project = (await client.addProject(dir)).project.id;
  other = (await client.addProject(makeProjectDir({ name: "hidden-project" }))).project.id;
  scoped = await pair([project]);
  child = spawn(process.execPath, [...cli, "mcp-server"], { cwd: root, env: { ...process.env, HOME: home, LOOM_HOME: home }, stdio: "pipe" });
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line); responses.set(response.id, response);
  });
});
afterAll(async () => {
  child?.kill();
  await daemon?.close();
  registerAgentKind("echo", (cfg, cwd) => new EchoAdapter(cfg.id, "echo", cwd));
});

describe("MCP transports", () => {
  it("handshakes over stdio, ignores notifications and lists all schemas and annotations", async () => {
    const init = await stdio("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    expect((await stdio("ping")).result).toEqual({});
    const list = (await stdio("tools/list")).result.tools;
    expect(list.map((t: any) => t.name)).toEqual(["loom_scoreboard", "loom_fleets", "loom_try", "loom_memory_list", "loom_status", "loom_projects", "loom_agents", "loom_add_agents", "loom_chats", "loom_read_chat", "loom_send", "loom_steer", "loom_orchestra_start", "loom_orchestra_status", "loom_compare", "loom_brain_search", "loom_remember", "loom_report", "loom_board", "loom_queue", "loom_approvals", "loom_orchestra_retry", "loom_review", "loom_costs", "loom_triggers", "loom_consult"]);
    expect(list.every((t: any) => t.inputSchema.type === "object" && t.inputSchema.additionalProperties === false)).toBe(true);
    expect(list.find((t: any) => t.name === "loom_send").annotations.destructiveHint).toBe(true);
    expect(list.find((t: any) => t.name === "loom_remember").annotations.destructiveHint).toBe(false);
  });

  it("sends to an echo agent over stdio and returns its actual reply", async () => {
    const reply = await stdio("tools/call", { name: "loom_send", arguments: { project, agent: "plannerbot", text: "hello from MCP", wait: true } });
    expect(reply.result.structuredContent).toMatchObject({ status: "ok", timedOut: false, agent: "plannerbot" });
    expect(reply.result.structuredContent.reply).toContain("hello from MCP");
    expect(JSON.parse(reply.result.content[0].text)).toEqual(reply.result.structuredContent);
    expect(captures.at(-1)?.mcp).toBeUndefined();
  });

  it("returns protocol errors without crashing and does not execute notification tools", async () => {
    child.stdin.write("not json\n");
    await waitUntil(() => responses.has(null));
    expect(responses.get(null).error.code).toBe(-32700);
    expect((await stdio("missing")).error.code).toBe(-32601);
    expect((await stdio("tools/call", { name: "loom_send", arguments: { project, text: 42 } })).error.code).toBe(-32602);
    expect((await http([]).then(r => r.json()) as any).error.code).toBe(-32600);
    const malformed = await fetch(`${client.baseUrl}/mcp`, { method: "POST", headers: headers(admin), body: "not json" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error.code).toBe(-32700);
    const notice = await http({ jsonrpc: "2.0", method: "tools/call", params: { name: "loom_board", arguments: { project, action: "add", title: "never written" } } });
    expect(notice.status).toBe(202);
    expect(await notice.text()).toBe("");
    expect((await client.listTasks(project)).tasks).toHaveLength(0);
  });

  it("requires auth and refuses guests, bad origins and unsupported protocol versions", async () => {
    const request = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await http(request, "")).status).toBe(401);
    expect((await http(request, "wrong")).status).toBe(401);
    expect((await http(request, admin, { origin: "https://evil.example" })).status).toBe(403);
    expect((await http(request, admin, { "mcp-protocol-version": "9999" })).status).toBe(400);
    expect((await http(request, admin, { accept: "text/plain" })).status).toBe(406);
    expect((await fetch(`${client.baseUrl}/mcp`, { headers: headers(admin) })).status).toBe(405);
    const mint = await fetch(`${client.baseUrl}/api/pair/new`, { method: "POST", headers: headers(admin), body: JSON.stringify({ guest: { project, chat: "main", role: "view", name: "guest" } }) });
    // The public pairing flow is shared with the browser's guest link.
    const data = await mint.json() as any;
    expect(mint.status).toBe(200);
    const token = data.token;
    expect(token).toBeTruthy();
    const claim = await fetch(`${client.baseUrl}/api/pair/claim`, { method: "POST", headers: headers(), body: JSON.stringify({ token }) }).then(r => r.json()) as any;
    expect((await http(request, claim.clientToken)).status).toBe(403);
  });

  it("filters project lists and refuses cross-project reads and writes by id or name", async () => {
    expect((await call("projects", {}, scoped)).result.structuredContent.projects.map((p: any) => p.id)).toEqual([project]);
    for (const target of [other, "hidden-project"]) {
      expect((await call("status", { project: target }, scoped)).result.isError).toBe(true);
      expect((await call("remember", { project: target, text: "forbidden", kind: "decision" }, scoped)).result.isError).toBe(true);
    }
    expect((await call("status", { project: "mcp-project" }, scoped)).result.structuredContent.project.id).toBe(project);
  });
});

describe("MCP tools", () => {
  it("lists models, adds echo instances, records memories and manages board tasks", async () => {
    const agents = await call("agents", { project });
    expect(agents.result.structuredContent.agents[0].models).toBeInstanceOf(Array);
    expect((await call("add_agents", { project, kind: "echo", count: 2 })).result.structuredContent.agents).toHaveLength(2);
    expect((await call("remember", { project, text: "MCP uses scoped credentials", kind: "constraint" })).result.structuredContent.created).toBe(true);
    expect((await call("brain_search", { project, query: "scoped credentials" })).result.structuredContent.hits.length).toBeGreaterThan(0);
    expect((await call("board", { project, action: "add", title: "MCP test task" })).result.structuredContent.task.title).toBe("MCP test task");
    expect((await call("board", { project, action: "list" })).result.structuredContent.tasks).toHaveLength(1);
    expect((await call("board", { project, action: "add" })).result.isError).toBe(true);
  });

  it("sends to a separate chat and reads the last N messages, not N log events", async () => {
    const { chat } = await client.createChat(project, "MCP chat", { agentId: "execbot" });
    expect((await call("chats", { project })).result.structuredContent.chats.some((c: any) => c.id === chat.id)).toBe(true);
    const sent = await call("send", { project, chat: chat.id, text: "separate conversation", model: "test-model", effort: "high", wait: true });
    expect(sent.result.structuredContent.reply).toContain("separate conversation");
    expect((await client.chatEvents(project, chat.id)).events.find(e => e.kind === "run_complete")?.payload).toMatchObject({ model: "test-model", effort: "high" });
    expect((await client.chats(project)).chats.find(c => c.id === chat.id)?.model).toBeUndefined();
    const read = await call("read_chat", { project, chat: chat.id, limit: 2 });
    expect(read.result.structuredContent.messages).toHaveLength(2);
    expect(read.result.structuredContent.messages.every((m: any) => m.chat === chat.id && m.kind === "message")).toBe(true);
  });

  it("bounds waits and steers the running turn", async () => {
    // long enough that the steer lands mid-turn even on a slow runner; the bounded wait still times out at once
    const sent = await call("send", { project, agent: "plannerbot", text: "sleep:5000", wait: true, timeoutMs: 1 });
    expect(sent.result.structuredContent.timedOut).toBe(true);
    expect((await call("steer", { project, agent: "plannerbot", text: "new information" })).result.structuredContent.steered).toBe(true);
    await waitUntil(async () => !(await client.project(project)).project.agents.find(a => a.id === "plannerbot")?.busy);
  });

  it("waits for the queued request rather than returning the preceding turn's reply", async () => {
    await call("send", { project, agent: "plannerbot", text: "sleep:300 preceding turn" });
    const queued = await call("send", { project, agent: "plannerbot", text: "the queued request", wait: true });
    expect(queued.result.structuredContent).toMatchObject({ status: "ok", timedOut: false });
    expect(queued.result.structuredContent.reply).toContain("the queued request");
    expect(queued.result.structuredContent.reply).not.toContain("preceding turn");
  });

  it("attaches project tools only when enabled and revokes them after the turn", async () => {
    const settings = `${client.baseUrl}/api/projects/${project}/config`;
    expect((await fetch(settings, { headers: headers(admin) }).then(r => r.json()) as any).loomTools).toBe(false);
    expect((await fetch(settings, { method: "PATCH", headers: headers(admin), body: JSON.stringify({ loomTools: "yes" }) })).status).toBe(400);
    await fetch(settings, { method: "PATCH", headers: headers(admin), body: JSON.stringify({ loomTools: true }) });
    await call("send", { project, agent: "plannerbot", text: "sleep:4000 project tools" });
    await waitUntil(() => captures.some(c => c.text === "sleep:4000 project tools"));
    const mcp = captures.find(c => c.text === "sleep:4000 project tools")!.mcp!;
    expect(fs.existsSync(mcp.configPath)).toBe(true);
    const entry = mcp.servers.find(s => s.key === "loom")!.entry as any;
    const token = entry.env.LOOM_MCP_TOKEN;
    expect((await call("projects", {}, token)).result.structuredContent.projects.map((p: any) => p.id)).toEqual([project]);
    expect((await call("remember", { project, kind: "convention", text: "native tools work" }, token)).result.structuredContent.created).toBe(true);
    expect((await call("status", { project: other }, token)).result.isError).toBe(true);
    expect((await fetch(`${client.baseUrl}/api/clients`, { headers: headers(token) })).status).toBe(403);
    // an agent holds this credential: it reads and uses the tools, it never widens its own access
    const P = `${client.baseUrl}/api/projects/${project}`;
    expect((await fetch(`${P}/config`, { method: "PATCH", headers: headers(token), body: JSON.stringify({ loomTools: false }) })).status).toBe(403);
    expect((await fetch(P, { method: "DELETE", headers: headers(token) })).status).toBe(403);
    expect((await fetch(`${P}/agents`, { method: "POST", headers: headers(token), body: JSON.stringify({ kind: "echo", options: { permissionMode: "bypass" } }) })).status).toBe(403);
    expect((await fetch(`${P}/triggers`, { method: "POST", headers: headers(token), body: JSON.stringify({ name: "x", kind: "schedule", everyMin: 5, prompt: "hi" }) })).status).toBe(403);
    expect((await fetch(`${P}/chats`, { headers: headers(token) })).status).toBe(200);
    expect(fs.readFileSync(path.join(home, "daemon.json"), "utf8")).not.toContain(token);
    const scopedOutput = await new Promise<string>((resolve, reject) => {
      const proc = execFile(entry.command, entry.args, { cwd: tmpDir("mcp-cwd"), env: { ...process.env, ...entry.env, HOME: home } },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      proc.stdin!.end(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "loom_projects", arguments: {} } }) + "\n");
    });
    expect(JSON.parse(scopedOutput).result.structuredContent.projects.map((p: any) => p.id)).toEqual([project]);
    await waitUntil(() => !fs.existsSync(mcp.configPath));
    expect((await http({ jsonrpc: "2.0", id: 1, method: "ping" }, token)).status).toBe(401);
    await fetch(settings, { method: "PATCH", headers: headers(admin), body: JSON.stringify({ loomTools: false }) });
  });

  it("attaches worker tools with project/run/task scope and records native progress", async () => {
    const compared = await call("compare", { project, prompt: "sleep:1000 worker tools", entrants: ["plannerbot", "execbot"] });
    const run = compared.result.structuredContent.run;
    await waitUntil(() => captures.filter(c => c.text === "sleep:1000 worker tools").length === 2);
    const mcp = captures.find(c => c.text === "sleep:1000 worker tools")!.mcp!;
    const token = (mcp.servers.find(s => s.key === "loom")!.entry as any).env.LOOM_MCP_TOKEN;
    const current = (await client.orchestraRun(project, run.id)).run;
    const task = current.tasks[0]!;
    expect((await call("report", { project, run: run.id, task: task.id, kind: "checkpoint", text: "testing tools" }, token)).result.structuredContent.report.text).toBe("testing tools");
    expect((await call("report", { project, run: run.id, task: current.tasks[1]!.id, kind: "done" }, token)).result.isError).toBe(true);
    expect((await call("report", { project, run: run.id, task: task.id, kind: "done" }, scoped)).result.isError).toBe(true);
    expect((await call("orchestra_status", { project, run: run.id })).result.structuredContent.run.tasks[0].reports).toHaveLength(1);
    await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.status === "completed");
    expect((await http({ jsonrpc: "2.0", id: 1, method: "ping" }, token)).status).toBe(401);
  });

  it("waits for comparisons and starts an Orchestra from fleet specs", async () => {
    const comparison = await call("compare", { project, prompt: "compare MCP", entrants: ["plannerbot", "execbot"], wait: true });
    expect(comparison.result.structuredContent).toMatchObject({ timedOut: false, run: { status: "completed" } });
    const started = await call("orchestra_start", { project, goal: "MCP orchestra", orchestrator: "plannerbot", workers: ["execbot x2"] });
    expect(started.result.structuredContent.run.workerDetails).toHaveLength(2);
    await client.orchestraAction(project, started.result.structuredContent.run.id, "abort");
  });
});

describe("loom connect", () => {
  it.each(["claude", "codex", "opencode", "grok"])("prints the %s registration without invoking the CLI", async agent => {
    const fakeHome = tmpDir("connect-home");
    const { stdout } = await promisify(execFile)(process.execPath, [...cli, "connect", agent, "--dry-run"], {
      cwd: root, env: { ...process.env, HOME: fakeHome, LOOM_HOME: fakeHome, NO_COLOR: "1" },
    });
    // OpenCode's mcp add takes only a name and asks for the command, so it gets told what to answer
    expect(stdout.trim()).toBe(agent === "opencode"
      ? "opencode mcp add loom\nOpenCode asks next: choose a local server and enter the command: loom mcp-server"
      : `${agent} mcp add loom -- loom mcp-server`);
    expect(fs.readdirSync(fakeHome)).toEqual([]);
  });
  it("previews list commands in a fake HOME", async () => {
    const fakeHome = tmpDir("connect-list-home");
    const { stdout } = await promisify(execFile)(process.execPath, [...cli, "connect", "--list", "--dry-run"], {
      cwd: root, env: { ...process.env, HOME: fakeHome, LOOM_HOME: fakeHome },
    });
    expect(stdout.trim().split("\n")).toEqual(["claude mcp list", "codex mcp list", "opencode mcp list", "grok mcp list"]);
    expect(fs.readdirSync(fakeHome)).toEqual([]);
  });
});
