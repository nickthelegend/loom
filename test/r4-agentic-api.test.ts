import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { mcpRequest, mcpTools } from "../src/core/mcp-server.js";
import { writeLoomMcpSession, loomToolScope } from "../src/core/loom-tools.js";
import { lintSkill } from "../src/core/agentic-r4/skills.js";
import { waitForTarget } from "../src/core/agentic-r4/wait.js";
import { runHook } from "../src/core/agentic-r4/hooks.js";
import { agenticAction, loadAgenticView } from "../src/cli/tui-r4.js";
import { EchoAdapter } from "../src/adapters/echo.js";
import { registerAgentKind } from "../src/adapters/index.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const captures: Array<{ text: string; token: string; scope: ReturnType<typeof loomToolScope> }> = [];
class QuestionEcho extends EchoAdapter {
  override readonly capabilities = { ...this.capabilities, mcp: true };
  private answer?: () => void;
  override async send(input: SendInput) {
    const token = (input.mcp?.servers.find(s => s.key === "loom")?.entry as any)?.env?.LOOM_MCP_TOKEN;
    if (token) captures.push({ text: input.text, token, scope: { ...loomToolScope(token)! } });
    if (input.text !== "structured-question") return super.send(input);
    this._busy = true;
    try {
      const answered = new Promise<void>(resolve => { this.answer = resolve; });
      this.emit({ kind: "needs_input", payload: { requestId: "r4-question", question: "Continue?", questions: [{ id: "choice" }] } });
      await answered;
      await new Promise(resolve => setTimeout(resolve, 300));
      this.emit({ kind: "message", payload: { text: "Finished after your answer" } });
      this.emit({ kind: "run_complete", payload: {} });
    } finally { this._busy = false; }
  }
  async respondToUserInput(_chat: string, requestId: string, _answers: Record<string, unknown>) {
    this.emit({ kind: "status", payload: { state: "question_answered", requestId } });
    this.answer?.();
  }
}

let daemon: LoomDaemon, client: DaemonClient, scoped: DaemonClient, phone: DaemonClient, guest: DaemonClient;
let project: string, other: string, dir: string;
const home = tmpDir("r4-agentic-home"), root = path.resolve(import.meta.dirname, "..");
let seq = 0;
const rpc = (c: DaemonClient, method: string, params?: object) => mcpRequest(c, { jsonrpc: "2.0", id: ++seq, method, params }) as Promise<any>;
const call = async (name: string, args: object = {}, c = client) => (await rpc(c, "tools/call", { name: `loom_${name}`, arguments: args })).result;
const P = (suffix: string) => `/api/projects/${project}${suffix}`;
async function pair(body: object) {
  const mint = await client.api<{ token: string }>("POST", "/api/pair/new", body);
  const claim = await fetch(client.baseUrl + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: mint.token, name: "r4 phone" }) }).then(r => r.json()) as any;
  return new DaemonClient({ ...readDaemonConfig()!, adminToken: claim.clientToken });
}
async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, LOOM_HOME: home }, timeout: 20_000 });
    return { stdout, stderr, code: 0 };
  } catch (error) { const e = error as { stdout: string; stderr: string; code: number }; return e; }
}
beforeAll(async () => {
  process.env.LOOM_HOME = home; process.env.LOOM_NO_NOTIFY = "1";
  registerAgentKind("echo", (cfg, cwd) => new QuestionEcho(cfg.id, "echo", cwd, cfg.options));
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ name: "agentic" });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd: dir });
  project = (await client.addProject(dir)).project.id;
  other = (await client.addProject(makeProjectDir({ name: "private" }))).project.id;
  scoped = await pair({ projects: [project] }); phone = await pair({});
  guest = await pair({ guest: { project, chat: "main", role: "view", name: "guest" } });
}, 30_000);
afterAll(async () => { await daemon?.close(); registerAgentKind("echo", (cfg, cwd) => new EchoAdapter(cfg.id, "echo", cwd, cfg.options)); });

describe("MCP content and tools", () => {
  it("advertises resources and prompts, with all original tools and the seven additions", async () => {
    expect((await rpc(client, "initialize")).result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    const tools = (await rpc(client, "tools/list")).result.tools;
    expect(tools).toHaveLength(26);
    expect(tools.map((t: any) => t.name)).toEqual(mcpTools().map(t => t.name));
    expect(tools.every((t: any) => t.inputSchema.additionalProperties === false)).toBe(true);
  });
  it("lists and reads scoped chat, memory, board and run resources over HTTP and stdio", async () => {
    await call("send", { project, text: "resource transcript", agent: "plannerbot", wait: true });
    await client.remember(project, "decision", "Use scoped resources");
    const compared = await client.compare(project, { prompt: "resource report", entrants: ["plannerbot", "execbot"] });
    await waitForTarget(client, project, compared.run.id);
    const list = (await rpc(scoped, "resources/list")).result.resources;
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list.every((r: any) => r.uri.startsWith(`loom://projects/${project}/`))).toBe(true);
    for (const suffix of ["chats/main", "memories", "board", `runs/${compared.run.id}`]) {
      const response = await fetch(client.baseUrl + "/mcp", { method: "POST", headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: `loom://projects/${project}/${suffix}` } }) }).then(r => r.json()) as any;
      expect(JSON.parse(response.result.contents[0].text)).toBeTruthy();
    }
    expect((await rpc(scoped, "resources/read", { uri: `loom://projects/${other}/board` })).error).toBeTruthy();
    expect((await rpc(client, "resources/read", { uri: "file:///etc/passwd" })).error).toBeTruthy();
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "src/cli/index.ts"), "mcp-server"], { env: { ...process.env, LOOM_HOME: home } }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: `loom://projects/${project}/chats/main` } }) + "\n");
    });
    expect(JSON.parse(result).result.contents[0].text).toContain("resource transcript");
  });
  it("uses existing named templates and validates required arguments without exposing the machine library to scoped callers", async () => {
    await client.saveTemplate("Review change", "Review {{file}} for {{risk}}");
    expect((await rpc(phone, "prompts/list")).result.prompts[0].arguments).toEqual([{ name: "file", required: true }, { name: "risk", required: true }]);
    const result = await rpc(client, "prompts/get", { name: "Review change", arguments: { file: "a.ts", risk: "races" } });
    expect(result.result.messages[0].content.text).toBe("Review a.ts for races");
    expect((await rpc(client, "prompts/get", { name: "Review change", arguments: { file: "a.ts" } })).error).toBeTruthy();
    expect((await rpc(scoped, "prompts/list")).result).toEqual({ prompts: [] });
    expect((await rpc(scoped, "prompts/get", { name: "Review change", arguments: { file: "a.ts", risk: "races" } })).error).toBeTruthy();
  });
  it("runs the six new tools with project scope and logs the paired device identity", async () => {
    for (const tool of ["queue", "approvals", "review", "costs", "triggers"]) {
      expect((await call(tool, { project }, scoped)).isError).toBeUndefined();
      expect((await call(tool, { project: other }, scoped)).isError).toBe(true);
    }
    expect((await call("orchestra_retry", { project, run: "missing", task: "missing", agent: "execbot" }, scoped)).content[0].text).not.toMatch(/owner|scope|403/);
    await call("costs", { project }, phone);
    const log = await client.api<any>("GET", P("/r4/log"));
    expect(log.calls.at(-1)).toMatchObject({ actor: "r4 phone", tool: "loom_costs", ok: true });
    expect(log.calls.some((c: any) => c.tool === "loom_orchestra_retry" && !c.ok)).toBe(true);
    await expect(guest.api("GET", P("/r4/tools"))).rejects.toThrow();
  });
  it("enqueues, starts a review and retries one failed task through scoped tools", async () => {
    await client.queuePause(project, true);
    const queued = await call("queue", { project, text: "scoped queue item", agent: "plannerbot" }, scoped);
    expect(queued.structuredContent.item.text).toBe("scoped queue item");
    expect((await call("queue", { project }, scoped)).structuredContent.queue).toHaveLength(1);
    await client.queuePause(project, false);
    await waitForTarget(client, project, "main");
    const review = await call("review", { project, agents: ["execbot"], text: "Review this small change" }, scoped);
    expect(review.isError).toBeUndefined();
    await waitUntil(async () => (await client.review(project, review.structuredContent.review.reviewId)).review.status === "done");
    const { run } = await client.compare(project, { prompt: "fail: retry fixture", entrants: ["plannerbot", "execbot"] });
    await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.status === "completed");
    const before = (await client.orchestraRun(project, run.id)).run;
    const retried = await call("orchestra_retry", { project, run: run.id, task: before.tasks[0]!.id, agent: "execbot@replacement" }, scoped);
    expect(retried.isError).toBeUndefined();
    await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks[0]!.attempts === 2);
    const after = (await client.orchestraRun(project, run.id)).run;
    expect(after.tasks[0]!.dir).toBe(before.tasks[0]!.dir);
    expect(after.tasks[1]!.attempts).toBe(1);
    await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.status === "completed");
  });
  it("persists per-project switches, filters worker tools and rejects disabled calls", async () => {
    await scoped.api("PUT", P("/r4/tools"), { disabledTools: ["loom_costs"] });
    const session = writeLoomMcpSession([], { project, api: client.baseUrl })!;
    const token = (session.servers[0]!.entry as any).env.LOOM_MCP_TOKEN;
    const worker = new DaemonClient({ ...readDaemonConfig()!, adminToken: token });
    try {
      expect((await rpc(worker, "prompts/list")).result).toEqual({ prompts: [] });
      expect((await rpc(worker, "prompts/get", { name: "Review change", arguments: { file: "a.ts", risk: "races" } })).error).toBeTruthy();
      expect((await rpc(worker, "tools/list")).result.tools.some((t: any) => t.name === "loom_costs")).toBe(false);
      expect((await call("costs", { project }, worker)).isError).toBe(true);
      await expect(worker.api("PUT", P("/r4/tools"), { disabledTools: [] })).rejects.toThrow();
      expect((await call("triggers", { project }, worker)).isError).toBeUndefined();
      expect((await call("fleets", {}, worker)).isError).toBe(true);
    } finally { session.cleanup(); }
    expect(fs.readFileSync(path.join(home, `agentic-${project}.json`), "utf8")).toContain("loom_costs");
    await phone.api("PUT", P("/r4/tools"), { disabledTools: [] });
  });
});

describe("consultation, hooks, skills and waits", () => {
  it("consults a read-only echo agent and records reply and usage in the asking thread", async () => {
    await client.send(project, "sleep:1500 asking turn", "plannerbot");
    const result = await call("consult", { project, agent: "execbot", question: "write:must-not-exist.txt side question" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.reply).toContain("side question");
    expect(fs.existsSync(path.join(dir, "must-not-exist.txt"))).toBe(false);
    const events = (await client.chatEvents(project, "main", { limit: 100 })).events;
    expect(events.some(e => e.kind === "message" && e.payload.phase === "answer" && e.payload.consult)).toBe(true);
    expect(events.some(e => e.payload.state === "turn_cost" && e.payload.source === "consult" && e.agentId === "plannerbot")).toBe(true);
    await waitForTarget(client, project, "main");
    expect((await call("consult", { project, agent: "execbot", question: "idle question" })).isError).toBe(true);
  });
  it("binds dispatched credentials before attachment and prevents billing a different chat or agent", async () => {
    const { chat } = await client.createChat(project, "scoped asking turn", { agentId: "plannerbot" });
    await client.api("PATCH", P("/config"), { loomTools: true });
    await client.send(project, "sleep:1600 identity fixture", "plannerbot", { chat: chat.id });
    await waitUntil(() => captures.some(c => c.text.includes("identity fixture")));
    const capture = captures.find(c => c.text.includes("identity fixture"))!;
    expect(capture.scope).toMatchObject({ project, agent: "plannerbot", chat: chat.id });
    const worker = new DaemonClient({ ...readDaemonConfig()!, adminToken: capture.token });
    const missing = writeLoomMcpSession([], { project, api: client.baseUrl })!;
    try {
      expect((await call("consult", { project, agent: "execbot", question: "correct thread" }, worker)).isError).toBeUndefined();
      expect((await call("consult", { project, chat: "main", agent: "execbot", question: "wrong thread" }, worker)).isError).toBe(true);
      const unbound = new DaemonClient({ ...readDaemonConfig()!, adminToken: (missing.servers[0]!.entry as any).env.LOOM_MCP_TOKEN });
      expect((await call("consult", { project, chat: chat.id, agent: "execbot", question: "unbound" }, unbound)).isError).toBe(true);
      const events = (await client.chatEvents(project, chat.id)).events;
      expect(events.filter(e => e.payload.consult).every(e => e.agentId === "plannerbot")).toBe(true);
      expect(events.some(e => e.payload.state === "turn_cost" && e.payload.source === "consult")).toBe(true);
      expect((await client.api<any>("GET", P("/r4/log"))).calls.some((c: any) => c.actor === "plannerbot" && c.tool === "loom_consult")).toBe(true);
    } finally {
      missing.cleanup(); await waitForTarget(client, project, chat.id);
      await client.api("PATCH", P("/config"), { loomTools: false });
    }
    expect(loomToolScope(capture.token)).toBeUndefined();
  });
  it("confines worker consults to their task, charges the run and cancels with the asking credential", async () => {
    const { run } = await client.compare(project, { prompt: "sleep:1800 worker consult", entrants: ["plannerbot", "execbot"] });
    await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks.length === 2);
    const tasks = (await client.orchestraRun(project, run.id)).run.tasks;
    const session = writeLoomMcpSession([], { project, api: client.baseUrl, run: run.id, task: tasks[0]!.id })!;
    const token = (session.servers[0]!.entry as any).env.LOOM_MCP_TOKEN;
    const worker = new DaemonClient({ ...readDaemonConfig()!, adminToken: token });
    try {
      expect((await call("consult", { project, chat: tasks[1]!.chat, agent: "execbot", question: "other task" }, worker)).isError).toBe(true);
      const response = await call("consult", { project, agent: "execbot", question: "bounded read" }, worker);
      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.costUsd).toBe(0.001);
      expect((await client.orchestraRun(project, run.id)).run.costUsd).toBeGreaterThanOrEqual(0.001);
      const pending = call("consult", { project, agent: "execbot", question: "sleep:800 cancelled" }, worker);
      await waitUntil(async () => (await client.chatEvents(project, tasks[0]!.chat)).events.some(e => e.payload.phase === "question" && String(e.payload.text).includes("cancelled")));
      session.cleanup();
      expect((await pending).isError).toBe(true);
    } finally { session.cleanup(); await client.orchestraAction(project, run.id, "abort"); }
  });
  it("keeps hooks off, requires owner consent (including phones), sends JSON and kills overruns", async () => {
    const hooks = path.join(dir, ".loom/hooks"); fs.mkdirSync(hooks, { recursive: true });
    for (const name of ["turn-finished", "needs-you", "run-completed"]) fs.writeFileSync(path.join(hooks, name), '#!/bin/sh\ncat >> hook-events.jsonl\necho hook-output\n', { mode: 0o755 });
    expect((await client.api<any>("GET", P("/r4/hooks"))).enabled).toBe(false);
    await expect(client.api("POST", P("/r4/hooks/test"), { event: "turn-finished" })).rejects.toThrow("disabled");
    await expect(scoped.api("PUT", P("/r4/hooks"), { enabled: true })).rejects.toThrow("owner");
    await phone.api("PUT", P("/r4/hooks"), { enabled: true });
    const tested = await phone.api<any>("POST", P("/r4/hooks/test"), { event: "turn-finished" });
    expect(tested).toMatchObject({ code: 0, timedOut: false, output: "hook-output\n" });
    await call("send", { project, text: "automatic hook", agent: "plannerbot", wait: true });
    await waitUntil(() => fs.readFileSync(path.join(dir, "hook-events.jsonl"), "utf8").split("\n").filter(Boolean).length >= 2);
    const rows = fs.readFileSync(path.join(dir, "hook-events.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    expect(rows.at(-1)).toMatchObject({ event: "turn-finished", project, payload: { kind: "run_complete" } });
    const { chat } = await client.createChat(project, "hook question", { agentId: "execbot" });
    await call("send", { project, chat: chat.id, text: "ask: choose a value", wait: true });
    const { run } = await client.compare(project, { prompt: "hook completion", entrants: ["plannerbot", "execbot"] });
    await waitForTarget(client, project, run.id);
    await waitUntil(() => {
      const events = fs.readFileSync(path.join(dir, "hook-events.jsonl"), "utf8");
      return events.includes('"event":"needs-you"') && events.includes('"event":"run-completed"');
    });
    fs.writeFileSync(path.join(hooks, "needs-you"), '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
    expect((await runHook(project, dir, "needs-you", {}, 30)).timedOut).toBe(true);
    await phone.api("PUT", P("/r4/hooks"), { enabled: false });
    expect((await cli(["hooks", "enable", "--project", project])).code).toBe(0);
    expect(JSON.parse((await cli(["hooks", "list", "--project", project])).stdout).enabled).toBe(true);
    expect(JSON.parse((await cli(["hooks", "test", "turn-finished", "--project", project])).stdout).code).toBe(0);
    expect((await cli(["hooks", "disable", "--project", project])).code).toBe(0);
  }, 90_000);
  it("drafts an editable disabled skill, refuses overwrite and lints front matter", async () => {
    const draft = await phone.api<any>("POST", P("/r4/skills/from-chat"), { chat: "main", name: "saved-steps" });
    expect(draft).toMatchObject({ draft: true, enabled: false });
    expect(fs.readFileSync(draft.file, "utf8")).toContain("automatic hook");
    expect(lintSkill(draft.dir)).toEqual({ valid: true, errors: [] });
    const saved = await cli(["skill:from-chat", "main", "cli-saved", "--project", project]);
    expect(saved.code, saved.stderr).toBe(0); expect(JSON.parse(saved.stdout).enabled).toBe(false);
    await expect(client.api("POST", P("/r4/skills/from-chat"), { chat: "main", name: "saved-steps" })).rejects.toThrow("already exists");
    await expect(client.api("POST", P("/r4/skills/from-chat"), { chat: "main", name: "../escape" })).rejects.toThrow();
    const { chat } = await client.createChat(project, "empty");
    await expect(client.api("POST", P("/r4/skills/from-chat"), { chat: chat.id, name: "empty-skill" })).rejects.toThrow("finished");
    const bad = tmpDir("bad-skill"); fs.writeFileSync(path.join(bad, "SKILL.md"), "# missing metadata");
    expect(lintSkill(bad).valid).toBe(false);
  });
  it("waits for a turn, reports timeout, and returns one JSON object in CLI modes", async () => {
    await client.send(project, "sleep:400 wait target", "plannerbot");
    expect(await waitForTarget(client, project, "main", 10)).toMatchObject({ exitCode: 124, timedOut: true });
    expect(await waitForTarget(client, project, "main")).toMatchObject({ exitCode: 0, status: "ok" });
    const result = await cli(["wait", "main", "--project", project, "--json"]);
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", exitCode: 0 });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const api = await cli(["api", "GET", "/r4/tools", "--project", project]);
    expect(api.code).toBe(0); expect(JSON.parse(api.stdout).tools).toHaveLength(26);
    const failed = await cli(["api", "GET", "/api/projects/not-found"]);
    expect(failed.code).not.toBe(0); expect(JSON.parse(failed.stdout).error).toBeTruthy();
    const data = path.join(dir, "tools.json"); fs.writeFileSync(data, JSON.stringify({ disabledTools: [] }));
    expect((await cli(["api", "PUT", "/r4/tools", "--project", project, "--data", `@${data}`])).code).toBe(0);
    expect((await cli(["skill:lint", path.join(dir, "skills/saved-steps")])).code).toBe(0);
    expect(JSON.parse((await cli(["mcp:log", "--project", project])).stdout).calls.length).toBeGreaterThan(0);
  });
  it("waits through an answered question in the same turn and exits successfully", async () => {
    const { chat } = await client.createChat(project, "answered wait", { agentId: "plannerbot" });
    await client.send(project, "structured-question", "plannerbot", { chat: chat.id });
    expect(await waitForTarget(client, project, chat.id)).toMatchObject({ status: "needs_input", exitCode: 2 });
    expect(await client.send(project, "yes", "plannerbot", { chat: chat.id })).toMatchObject({ answered: true });
    expect(await waitForTarget(client, project, chat.id, 40)).toMatchObject({ status: "timeout", exitCode: 124 });
    expect(await waitForTarget(client, project, chat.id)).toMatchObject({ status: "ok", exitCode: 0 });
    expect(await waitForTarget(client, project, chat.id)).toMatchObject({ status: "ok", exitCode: 0 });
    const events = (await client.chatEvents(project, chat.id)).events;
    expect(events.filter(e => e.payload.state === "turn_started")).toHaveLength(1);
    const result = await cli(["wait", chat.id, "--project", project, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", exitCode: 0 });
  });
  it("maps failed turns, human questions and aborted runs to distinct wait outcomes", async () => {
    await client.handoff(project, "execbot");
    const { chat: failed } = await client.createChat(project, "failed wait", { agentId: "execbot" });
    await client.send(project, "fail: expected failure", "execbot", { chat: failed.id });
    expect(await waitForTarget(client, project, failed.id)).toMatchObject({ exitCode: 1, status: "error" });
    const { chat: question } = await client.createChat(project, "question wait", { agentId: "execbot" });
    await client.send(project, "ask: your decision", "execbot", { chat: question.id });
    expect(await waitForTarget(client, project, question.id)).toMatchObject({ exitCode: 2, status: "needs_input" });
    const { run } = await client.compare(project, { prompt: "sleep:1000 abort wait", entrants: ["plannerbot", "execbot"] });
    await client.orchestraAction(project, run.id, "abort");
    expect(await waitForTarget(client, project, run.id)).toMatchObject({ exitCode: 1, status: "aborted" });
    const { chat: stopped } = await client.createChat(project, "stopped wait", { agentId: "execbot" });
    await client.send(project, "sleep:1500 interrupt wait", "execbot", { chat: stopped.id });
    await waitUntil(async () => (await client.project(project)).project.agents.some(a => a.id === "execbot" && a.busy));
    await client.interrupt(project);
    expect(await waitForTarget(client, project, stopped.id)).toMatchObject({ exitCode: 1, status: "aborted" });
    const failure = await cli(["wait", failed.id, "--project", project, "--json"]);
    expect(failure.code).toBe(1); expect(JSON.parse(failure.stdout).status).toBe("error");
  });
  it("loads live TUI views and resolves real approvals", async () => {
    expect((await loadAgenticView(client, project, "orchestra")).join("\n")).toContain("completed");
    let settled: unknown;
    (daemon as any).approvals.set("r4-approval", { id: "r4-approval", projectId: project, agent: "execbot", tool: "write", input: { path: "x" }, createdAt: Date.now(), settle: (d: unknown) => { settled = d; (daemon as any).approvals.delete("r4-approval"); } });
    expect((await loadAgenticView(phone, project, "approvals")).join("\n")).toContain("r4-approval");
    await agenticAction(phone, project, "deny", ["r4-approval"]);
    expect(settled).toMatchObject({ behavior: "deny" });
    expect((await loadAgenticView(phone, project, "approvals")).join("\n")).toContain("No pending approvals");
  });
});

it("boots with malformed project settings and lets the owner repair them", async () => {
  await daemon.close();
  fs.writeFileSync(path.join(home, `agentic-${project}.json`), '{"hooks":');
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  expect(await client.api("GET", P("/r4/tools"))).toMatchObject({ disabledTools: [], hooks: false });
  await client.api("PUT", P("/r4/tools"), { disabledTools: ["loom_costs"] });
  expect(await client.api("GET", P("/r4/tools"))).toMatchObject({ disabledTools: ["loom_costs"], hooks: false });
});
