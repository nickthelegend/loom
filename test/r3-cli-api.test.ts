import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";
import { setProvider } from "../src/core/providers.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");
const cli = ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "src/cli/index.ts")];
let daemon: LoomDaemon, client: DaemonClient, dir: string, pid: string, token: string, scoped: string, guest: string;
let provider: http.Server, providerId: string;
const env = () => ({ ...process.env, NO_COLOR: "1", LOOM_AUTO_RESTART: "0" });
function run(args: string[], cwd = dir): Promise<{ out: string; err: string; code: number }> {
  return new Promise(resolve => execFile(process.execPath, [...cli, ...args], { cwd, env: env(), timeout: 15000 }, (error, out, err) => resolve({ out, err, code: error ? Number(error.code) || 1 : 0 })));
}
function rest(route: string, method = "GET", body?: unknown, auth = token) {
  return fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function pair(options: unknown) {
  const minted = await rest("/api/pair/new", "POST", options).then(r => r.json()) as any;
  return (await rest("/api/pair/claim", "POST", { token: minted.token }).then(r => r.json()) as any).clientToken as string;
}
async function mcp(name: string, args: unknown = {}, auth = token): Promise<any> {
  return fetch(client.baseUrl + "/mcp", { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `loom_${name}`, arguments: args } }) }).then(r => r.json());
}
const lines = (out: string): any[] => out.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-api-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const cfg = readDaemonConfig()!;
  writeDaemonConfig({ ...cfg, projectsRoot: tmpDir("r3-new-projects") });
  token = cfg.adminToken; client = new DaemonClient(cfg);
  dir = makeProjectDir({ name: "r3-project", agents: [{ id: "solo", kind: "echo", role: "worker" }] });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd: dir });
  pid = (await client.addProject(dir)).project.id;
  scoped = await pair({ projects: [pid] });
  guest = await pair({ guest: { project: pid, chat: "main", role: "view", name: "guest" } });
  provider = http.createServer((req, res) => {
    let raw = ""; req.on("data", data => { raw += data; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (!body.model) return void res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${body.model} hello` } }] })}\n\n`);
      setTimeout(() => res.end("data: [DONE]\n\n"), 150);
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  providerId = "r3-provider";
  setProvider(providerId, { baseUrl: `http://127.0.0.1:${(provider.address() as any).port}`, key: "test", label: "Test" });
});
afterAll(async () => {
  provider?.closeAllConnections(); await new Promise<void>(resolve => provider ? provider.close(() => resolve()) : resolve());
  await daemon?.close();
});

describe("2.1 real CLI streams", () => {
  it("emits live deltas before completion, durable events and one outcome as clean NDJSON", async () => {
    const child = spawn(process.execPath, [...cli, "send", "stream:70 hello from the stream", "--stream"], { cwd: dir, env: env() });
    let out = "", err = "", ended = false;
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    const done = new Promise<number | null>(resolve => child.on("close", code => { ended = true; resolve(code); }));
    try {
      await waitUntil(() => out.includes('"type":"delta"') || ended);
      expect(ended, err).toBe(false);
      expect(await done, err).toBe(0);
      const events = lines(out);
      expect(events[0].type).toBe("accepted");
      expect(events.some(e => e.kind === "message")).toBe(true);
      expect(events.filter(e => e.type === "outcome")).toMatchObject([{ status: "ok", agent: "solo" }]);
      expect(events.at(-1).reply).toContain("hello from the stream");
    } finally { child.kill(); }
  });
  it("returns error and timeout exit codes without prose on stdout", async () => {
    const failed = await run(["send", "fail:expected failure", "--stream"]);
    expect(failed.code).toBe(1); expect(lines(failed.out).at(-1)).toMatchObject({ type: "outcome", status: "error" });
    const timed = await run(["send", "sleep:4000", "--stream", "--timeout", "1"]);
    expect(timed.code).toBe(124); expect(lines(timed.out).at(-1).status).toBe("timeout");
    await client.interrupt(pid);
  });
  it("keeps queued sends correlated to their own request", async () => {
    await client.send(pid, "sleep:1600 previous turn", "solo");
    const result = await run(["send", "this queued request", "--stream"]);
    expect(result.code, result.err).toBe(0);
    expect(lines(result.out).at(-1).reply).toContain("this queued request");
    expect(lines(result.out).filter(e => e.type === "outcome")).toHaveLength(1);
    expect(lines(result.out).filter(e => e.kind === "message").every(e => !String(e.payload.text).includes("previous turn"))).toBe(true);
  });
  it("terminates an interrupted agent stream and leaves work running when only the watcher is stopped", async () => {
    for (const stopAgent of [true, false]) {
      const child = spawn(process.execPath, [...cli, "send", "sleep:5000 interrupt test", "--stream"], { cwd: dir, env: env() });
      let out = ""; child.stdout.on("data", d => { out += d; });
      const done = new Promise<number | null>(resolve => child.on("close", resolve));
      try {
        await waitUntil(() => out.includes('"type":"event"'));
        if (stopAgent) await client.interrupt(pid); else child.kill("SIGINT");
        expect(await done).toBe(stopAgent ? 75 : 130);
        expect(lines(out).at(-1)).toMatchObject({ type: "outcome", status: "interrupted" });
        if (!stopAgent) expect((await client.project(pid)).project.agents.some(a => a.busy)).toBe(true);
      } finally { child.kill(); await client.interrupt(pid); }
      await waitUntil(async () => !(await client.project(pid)).project.agents.some(a => a.busy));
    }
  });
  it("streams two model chats with separate outcomes through the real provider protocol", async () => {
    const result = await run(["ask", "hello", "--models", `${providerId}/alpha,${providerId}/beta`, "--no-briefing", "--json"]);
    expect(result.code, result.err).toBe(0);
    const events = lines(result.out), outcomes = events.filter(e => e.type === "outcome");
    expect(events[0].asked).toHaveLength(2);
    expect(outcomes).toHaveLength(2); expect(new Set(outcomes.map(e => e.chat)).size).toBe(2);
    expect(outcomes.map(e => e.reply).sort()).toEqual(["alpha hello", "beta hello"]);
    expect(events.filter(e => e.type === "delta").length).toBeGreaterThan(0);
  });
  it("follows a live Orchestra through waiting and abort, without unrelated project events", async () => {
    const { run: started } = await client.startOrchestra(pid, { goal: "inspect the project", orchestrator: "solo", workers: ["solo"] });
    const child = spawn(process.execPath, [...cli, "watch", "--run", started.id, "--json"], { cwd: dir, env: env() });
    let out = ""; child.stdout.on("data", d => { out += d; });
    const done = new Promise<number | null>(resolve => child.on("close", resolve));
    try {
      await waitUntil(() => out.includes('"kind":"run"'));
      await client.orchestraAction(pid, started.id, "abort");
      expect(await done).toBe(1);
      const events = lines(out);
      expect(events.every(e => e.run === started.id)).toBe(true);
      expect(events.at(-1)).toMatchObject({ kind: "run", status: "aborted" });
    } finally { child.kill(); await client.orchestraAction(pid, started.id, "abort").catch(() => {}); }
  });
});

describe("2.1 API and CLI configuration", () => {
  it("exports the existing standalone replay renderer through export --format html and phone JSON", async () => {
    const file = path.join(tmpDir("r3-export"), "chat.html");
    const result = await run(["export", "--format", "html", "--out", file]);
    expect(result.code, result.err).toBe(0);
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("<!doctype html>"); expect(html).toContain("hello from the stream");
    const mobile = await rest(`/api/projects/${pid}/chats/main/replay?format=json`).then(r => r.json()) as any;
    const stamp = (t: string) => t.replace(/exported [^·<]+·/, "exported ·"); expect(stamp(mobile.content)).toBe(stamp(html)); expect(mobile.filename).toMatch(/\.html$/);
    expect((await run(["export", "--format", "invalid"])).code).toBe(1);
  });
  it("initializes a template through the CLI and makes a committed starter through the API", async () => {
    const init = makeProjectDir({ agents: [{ id: "solo", kind: "echo", role: "worker" }] });
    const result = await run(["init", "--template", "web", "--no-gitignore"], init);
    expect(result.code, result.err).toBe(0); expect(fs.existsSync(path.join(init, "index.html"))).toBe(true);
    const made = await client.newProject({ name: "Library starter", template: "library", agents: [{ kind: "echo" }] });
    expect(fs.existsSync(path.join(made.project.dir, "index.test.js"))).toBe(true);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: made.project.dir, encoding: "utf8" })).toBe("");
    expect((await client.initTemplates()).templates.map(t => t.name)).toEqual(["web", "node", "library"]);
  });
  it("validates an invalid disk edit even while the runtime holds a good config", async () => {
    const file = path.join(dir, ".loom/config.json"), original = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, '{"name":"broken","agents":false}');
      expect((await client.validateConfig(pid)).errors[0]?.path).toBe("agents");
      const result = await run(["config", "validate"]);
      expect(result.code).toBe(1); expect(result.err).toContain("agents");
    } finally { fs.writeFileSync(file, original); }
    expect((await run(["config", "validate"])).code).toBe(0);
  });
  it("creates and expands literal aliases and completes actual 2.0 options", async () => {
    expect((await run(["alias", "set", "roster", "--", "agents", "--json"])).code).toBe(0);
    const result = await run(["roster"]); expect(result.code, result.err).toBe(0); expect(result.out).toContain("solo");
    expect((await run(["completion", "candidates", "--", "send"])).out).toContain("--json");
    expect((await run(["completion", "candidates", "--", "orchestra"])).out).toContain("--progress");
    expect((await run(["completion", "candidates", "--", "watch"])).out).toContain("--run");
    expect((await run(["completion", "candidates"])).out).toContain("roster");
    expect((await run(["alias", "set", "send", "--", "agents"])).code).toBe(1);
    expect((await run(["alias", "rm", "roster"])).code).toBe(0);
  });
  it("enforces scoped and share-live walls for every new machine-wide route", async () => {
    for (const auth of [scoped, guest]) {
      for (const [route, method, body] of [["/api/aliases", "PUT", { name: "bad", args: ["send"] }], ["/api/aliases", "DELETE", { name: "bad" }], ["/api/projects", "POST", { dir, template: "web" }], ["/api/projects/new", "POST", { name: "forbidden", template: "web" }], ["/api/try", "POST", {}]] as const) {
        expect((await rest(route, method, body, auth)).status, route).toBe(403);
      }
      expect((await rest("/api/aliases", "GET", undefined, auth)).status).toBe(403);
    }
    expect((await rest(`/api/projects/${pid}/config/validate`, "GET", undefined, scoped)).status).toBe(200);
    expect((await rest(`/api/projects/${pid}/config/validate`, "GET", undefined, guest)).status).toBe(403);
  });
  it("exposes all four MCP tools through both transports and preserves scope", async () => {
    await client.remember(pid, "decision", "Use the batch tests");
    expect((await mcp("memory_list", { project: pid, kind: "decision" })).result.structuredContent.memories.length).toBeGreaterThan(0);
    expect((await mcp("scoreboard", { project: pid })).result.structuredContent.byKindModel.length).toBeGreaterThan(0);
    await client.saveFleet("test", "solo");
    expect((await mcp("fleets")).result.structuredContent.fleets).toContainEqual({ name: "test", spec: "solo" });
    const demo = path.join(tmpDir("r3-demo-parent"), "demo");
    expect((await mcp("try", { dir: demo, agents: 1 })).result.structuredContent.project.dir).toBe(demo);
    expect((await mcp("try", { dir: demo }, scoped)).result.isError).toBe(true);
    expect((await mcp("scoreboard", {}, scoped)).result.structuredContent.projects).toEqual([pid]);
    expect((await mcp("memory_list", { project: pid, kind: "decision" }, scoped)).result.structuredContent.memories.length).toBeGreaterThan(0);
    expect((await mcp("fleets", {}, scoped)).result.isError).toBe(true);
    expect((await mcp("memory_list", { project: "not-allowed" }, scoped)).result.isError).toBe(true);
    const child = spawn(process.execPath, [...cli, "mcp-server"], { cwd: dir, env: env() });
    let out = ""; child.stdout.on("data", d => { out += d; });
    const done = new Promise(resolve => child.on("close", resolve));
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "loom_scoreboard", arguments: { project: pid } } }) + "\n");
    await done;
    expect(lines(out)[0].result.structuredContent.project).toBe(pid);
  });
});
