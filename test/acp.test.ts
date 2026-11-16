/**
 * The ACP adapter against a stand-in ACP agent (test/acp-fake-agent.mjs): sessions per chat and
 * resume, update → event mapping, and permission requests decided by Loom's mode.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpAdapter } from "../src/adapters/acp.js";
import { setApprovalBroker } from "../src/core/approvals.js";
import { writeMcpSession, type McpSession } from "../src/core/mcp.js";
import type { AdapterEvent, McpServerConfig } from "../src/types.js";
import { tmpDir } from "./helpers.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "acp-fake-agent.mjs");
const agents: AcpAdapter[] = [];
const mcps: McpSession[] = [];

function mcp(config: McpServerConfig[]) {
  const session = writeMcpSession(config)!;
  mcps.push(session);
  return session;
}

function agent(mode: "bypass" | "auto" | "ask", extra: Record<string, unknown> = {}) {
  process.env.LOOM_HOME ??= tmpDir("home-acp");
  const dir = tmpDir("acp-proj");
  const logFile = path.join(dir, "acp.log");
  const a = new AcpAdapter("gem", dir, { command: [process.execPath, fake], permissions: mode, ...extra, env: { FAKE_ACP_LOG: logFile, ...(extra.env as Record<string, string> ?? {}) } });
  agents.push(a);
  const events: AdapterEvent[] = [];
  a.onEvent((e) => events.push(e));
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> }) : []);
  return { a, events, calls, dir };
}
const texts = (events: AdapterEvent[]) => events.filter((e) => e.kind === "message" && !(e.payload as { reasoning?: boolean }).reasoning).map((e) => String((e.payload as { text: string }).text));

afterEach(async () => {
  setApprovalBroker(null);
  for (const a of agents.splice(0)) await a.stop();
  for (const session of mcps.splice(0)) session.cleanup();
});

describe("ACP adapter", () => {
  it.each([
    undefined,
    {},
    { http: false, sse: false },
    { http: true },
    { sse: true },
    { http: true, sse: true },
  ])("passes MCP servers to new and loaded sessions with transport capabilities %j", async (mcpCapabilities) => {
    const { a, calls, dir } = agent("bypass", { env: { FAKE_ACP_CAPABILITIES: JSON.stringify({ mcpCapabilities }) } });
    const config = mcp([
      { name: "Local Files", url: "", command: "node", args: ["server.mjs", "a path with spaces"], env: { TOKEN: "test token", EMPTY: "" } },
      { name: "Bare", url: "", command: "bare-server" },
      { name: "HTTP", url: "https://http.example/mcp", headers: { Authorization: "Bearer test", "X-Project": "loom" } },
      { name: "HTTP no auth", url: "https://public.example/mcp" },
      { name: "SSE", url: "https://sse.example/sse", headers: { "X-Key": "test" } },
      { name: "SSE no auth", url: "https://public.example/sse" },
      { name: "Disabled", url: "", command: "disabled-server", enabledForSession: false },
      { name: "Placeholder", url: "" },
    ]);
    const expected = [
      { name: "Local Files", command: "node", args: ["server.mjs", "a path with spaces"], env: [{ name: "TOKEN", value: "test token" }, { name: "EMPTY", value: "" }] },
      { name: "Bare", command: "bare-server", args: [], env: [] },
      ...(mcpCapabilities?.http ? [
        { name: "HTTP", type: "http", url: "https://http.example/mcp", headers: [{ name: "Authorization", value: "Bearer test" }, { name: "X-Project", value: "loom" }] },
        { name: "HTTP no auth", type: "http", url: "https://public.example/mcp", headers: [] },
      ] : []),
      ...(mcpCapabilities?.sse ? [
        { name: "SSE", type: "sse", url: "https://sse.example/sse", headers: [{ name: "X-Key", value: "test" }] },
        { name: "SSE no auth", type: "sse", url: "https://public.example/sse", headers: [] },
      ] : []),
    ];
    expect(a.capabilities.mcp).toBe(true);
    await a.send({ text: "first", mcp: config });
    await a.send({ text: "second", mcp: config });
    expect(calls().filter((c) => c.method === "session/new" || c.method === "session/load")).toEqual([
      { method: "session/new", params: { cwd: dir, mcpServers: expected } },
      { method: "session/load", params: { sessionId: "s1", cwd: dir, mcpServers: expected } },
    ]);

    // Loading takes this turn's servers, including removal of the whole list.
    await a.send({ text: "without servers" });
    expect(calls().filter((c) => c.method === "session/load").at(-1)!.params.mcpServers).toEqual([]);
  });

  it("sends an empty list when there are no MCP servers or only unsupported transports", async () => {
    const { a, calls } = agent("bypass");
    await a.send({ text: "none", chat: "empty" });
    await a.send({ text: "remote", chat: "remote", mcp: mcp([{ name: "HTTP", url: "https://http.example/mcp" }]) });
    expect(calls().filter((c) => c.method === "session/new").map((c) => c.params.mcpServers)).toEqual([[], []]);
  });

  it("a turn: thoughts, plan, answer and usage arrive as Loom events; one session per chat, resumed", async () => {
    const { a, events, calls } = agent("bypass");
    expect(await a.available()).toBe(true);
    await a.send({ text: "first", chat: "main" });
    expect(events.find((e) => e.kind === "message" && (e.payload as { reasoning?: boolean }).reasoning)).toBeTruthy();
    expect(events.find((e) => e.kind === "status" && (e.payload as { state: string }).state === "plan_updated")).toBeTruthy();
    expect(texts(events)).toEqual(["Hello from ACP (s1): first"]);
    expect(events.find((e) => e.kind === "run_complete")!.payload).toMatchObject({ inputTokens: 12, outputTokens: 34 });
    await a.send({ text: "second", chat: "main" });
    expect(texts(events).at(-1)).toBe("Hello from ACP (s1): second"); // same session
    expect(texts(events).join()).not.toContain("REPLAYED HISTORY");
    await a.send({ text: "elsewhere", chat: "other" });
    expect(texts(events).at(-1)).toBe("Hello from ACP (s2): elsewhere");
    // bypass picks the agent's own bypass mode when it has one
    expect(calls().find((c) => c.method === "session/set_mode")).toBeUndefined(); // no preset, no modes map
  }, 30_000);

  it("a new process resumes a chat's session with session/load, without replaying history into the thread", async () => {
    const { a, events, calls, dir } = agent("bypass");
    await a.send({ text: "one", chat: "main" });
    await a.stop();
    const again = new AcpAdapter("gem", dir, { command: [process.execPath, fake], permissions: "bypass", env: { FAKE_ACP_LOG: path.join(dir, "acp.log") } });
    agents.push(again);
    const ev2: AdapterEvent[] = [];
    again.onEvent((e) => ev2.push(e));
    await again.send({ text: "two", chat: "main", mcp: mcp([{ name: "Local", url: "", command: "local-server", env: { TOKEN: "test" } }]) });
    // the fake's sessions died with it, so load fails and a fresh session is made — and nothing replayed leaks in
    expect(calls().filter((c) => c.method === "session/load").length).toBe(1);
    expect(calls().filter((c) => c.method === "session/load" || c.method === "session/new").slice(-2).map((c) => ({ method: c.method, servers: c.params.mcpServers }))).toEqual([
      { method: "session/load", servers: [{ name: "Local", command: "local-server", args: [], env: [{ name: "TOKEN", value: "test" }] }] },
      { method: "session/new", servers: [{ name: "Local", command: "local-server", args: [], env: [{ name: "TOKEN", value: "test" }] }] },
    ]);
    expect(texts(ev2).join()).not.toContain("REPLAYED");
    expect(texts(events)).toEqual(["Hello from ACP (s1): one"]);
  }, 30_000);

  it("bypass allows, auto refuses what can't be undone, ask puts it to a person", async () => {
    const by = agent("bypass");
    await by.a.send({ text: "run: ls", chat: "main" });
    expect(texts(by.events)[0]).toMatch(/^permission: yes-always/);
    expect(by.events.find((e) => e.kind === "tool_call")!.payload).toMatchObject({ tool: "Run ls", kind: "execute" });
    expect(by.events.find((e) => e.kind === "tool_result")!.payload).toMatchObject({ ok: true, output: "ran: yes-always" });

    const auto = agent("auto");
    await auto.a.send({ text: "run: rm -rf ~/", chat: "main" });
    expect(texts(auto.events)[0]).toMatch(/^permission: no/);
    expect(auto.events.find((e) => e.kind === "status" && (e.payload as { state: string }).state === "auto_refused")).toBeTruthy();
    await auto.a.send({ text: "run: ls", chat: "main" });
    expect(texts(auto.events).find((t) => t.startsWith("permission: yes"))).toMatch(/^permission: yes-once/);

    const asked: string[] = [];
    setApprovalBroker(async (req) => { asked.push(req.tool); return req.tool === "Run ls" ? { behavior: "allow", scope: "session" } : { behavior: "deny" }; });
    const ask = agent("ask");
    await ask.a.send({ text: "run: ls", chat: "main" });
    await ask.a.send({ text: "run: make deploy", chat: "main" });
    expect(asked).toEqual(["Run ls", "Run make deploy"]);
    expect(texts(ask.events).filter((t) => t.startsWith("permission")).map((t) => t.split("Hello")[0])).toEqual(["permission: yes-always", "permission: no"]);
  }, 30_000);

  it("diffs become file edits, a trailing question asks you, and interrupt cancels the turn", async () => {
    const { a, events } = agent("bypass");
    await a.send({ text: "edit please", chat: "main" });
    expect(events.find((e) => e.kind === "file_edit")!.payload).toMatchObject({ path: "a.txt", summary: "created" });
    await a.send({ text: "ask me", chat: "main" });
    expect(events.find((e) => e.kind === "needs_input")!.payload).toMatchObject({ question: "Hello which file should I change?" });
    const turn = a.send({ text: "slow one", chat: "main" });
    await new Promise((r) => setTimeout(r, 300));
    await a.interrupt();
    await turn;
    expect(events.find((e) => e.kind === "status" && (e.payload as { state: string }).state === "interrupted")).toBeTruthy();
    expect(a.busy()).toBe(false);
  }, 30_000);

  it("says what's missing when it has no command, and when the agent won't start", async () => {
    const dir = tmpDir("acp-none");
    expect(await new AcpAdapter("x", dir, {}).available()).toBe(false);
    await expect(new AcpAdapter("x", dir, {}).send({ text: "hi" })).rejects.toThrow(/needs options.command or options.preset/);
    const broken = new AcpAdapter("x", dir, { command: [process.execPath, "-e", "process.exit(3)"] });
    agents.push(broken);
    await expect(broken.send({ text: "hi" })).rejects.toThrow(/the ACP agent exited \(3\)/);
  }, 30_000);
});

describe("ACP agent in a real project", () => {
  it("answers in the thread like any other agent", async () => {
    const { LoomDaemon } = await import("../src/daemon/server.js");
    const { DaemonClient } = await import("../src/daemon/client.js");
    const { readDaemonConfig } = await import("../src/core/registry.js");
    const { makeProjectDir, waitUntil } = await import("./helpers.js");
    process.env.LOOM_HOME = tmpDir("home-acp-daemon");
    process.env.LOOM_NO_NOTIFY = "1";
    const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    try {
      const client = new DaemonClient(readDaemonConfig()!);
      const dir = makeProjectDir({ name: "acp-proj", agents: [{ id: "gem", kind: "acp", role: "worker", options: { command: [process.execPath, fake], permissions: "bypass" } }] } as never);
      const id = (await client.addProject(dir)).project.id;
      await client.send(id, "hello acp", "gem");
      await waitUntil(async () => (await client.events(id, 0, 200)).events.some((e) => e.kind === "message" && e.agentId === "gem" && String((e.payload as { text?: string }).text).includes("from ACP (s1): hello acp")), 20_000);
    } finally {
      await daemon.close();
    }
  }, 60_000);
});
