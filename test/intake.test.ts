import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushIntakePrs, intakePrBody, readIntake, saveIntake } from "../src/core/intake.js";
import { recordOpenedPr } from "../src/core/pr-feedback.js";
import { setProvider } from "../src/core/providers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { isDue, nextFire, readTriggers, writeTriggers } from "../src/core/triggers.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { TriggerRunner } from "../src/daemon/triggers.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = process.cwd();
const envKeys = ["PATH", "LOOM_HOME", "LOOM_NO_NOTIFY", "LINEAR_API_KEY", "LOOM_TEST_LINEAR_URL"];
let oldEnv: Record<string, string | undefined>;
let daemon: LoomDaemon;
let client: DaemonClient;
let rt: ProjectRuntime;
let dir: string, id: string, fixture: string, calls: string;
const issueUrl = (n: number) => `https://github.com/acme/app/issues/${n}`;
const prUrl = "https://github.com/acme/app/pull/99";
const githubIssue = (n: number) => ({ number: n, title: `Fix ${n}`, body: "Please fix this.\nRun tests.", url: issueUrl(n), labels: [{ name: "loom" }] });
let control: { issues: ReturnType<typeof githubIssue>[]; fail?: boolean };
let linearServer: http.Server;
let linearCalls: Array<{ query: string; variables: Record<string, any>; authorization?: string }>;
let linearFail: boolean;
let linearPages: any[][];
const linearIssue = (n: number) => ({ id: `uuid-${n}`, identifier: `ENG-${n}`, title: `Linear ${n}`, description: "Linear task", url: `https://linear.app/acme/issue/ENG-${n}`, labels: { nodes: [{ name: "loom" }] } });
const save = () => fs.writeFileSync(fixture, JSON.stringify(control));
const history = (): Array<{ args: string[]; cwd: string }> => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
const api = async (method: string, suffix: string, body?: unknown, token = readDaemonConfig()!.adminToken) => {
  const res = await fetch(`${client.baseUrl}/api/projects/${id}${suffix}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
const start = (ids = [issueUrl(1)], extra = {}) => client.startIntake(id, { source: "github", ids, mode: "chat", ...extra });
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const runtime = () => (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
const cli = (args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => err ? reject(new Error(stderr)) : resolve(stdout));
});

beforeEach(async () => {
  oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  process.env.LOOM_HOME = tmpDir("home-intake");
  process.env.LOOM_NO_NOTIFY = "1";
  delete process.env.LINEAR_API_KEY;
  const bin = tmpDir("gh-intake");
  fixture = path.join(bin, "fixture.json"); calls = path.join(bin, "calls.jsonl");
  control = { issues: [githubIssue(1), githubIssue(2)] }; save();
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const data = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
if (data.fail) { console.error('upstream failed'); process.exit(1); }
if (args[0] === 'issue' && args[1] === 'list') {
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : null;
  console.log(JSON.stringify(data.issues.filter(i => !label || i.labels.some(l => l.name === label))));
} else if (args[0] === 'issue' && args[1] === 'comment') console.log('ok');
else if (args[0] === 'pr' && args[1] === 'create') console.log(${JSON.stringify(prUrl)});
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({ state: 'OPEN', url: ${JSON.stringify(prUrl)}, statusCheckRollup: [] }));
else console.log('[]');
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${oldEnv.PATH}`;
  linearCalls = []; linearFail = false; linearPages = [[linearIssue(1)]];
  linearServer = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body);
    linearCalls.push({ ...input, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (linearFail) return void res.end(JSON.stringify({ errors: [{ message: `rejected ${req.headers.authorization}` }] }));
    if (input.query.includes("commentCreate")) return void res.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
    const page = input.variables.after ? Number(input.variables.after) : 0;
    res.end(JSON.stringify({ data: { viewer: { assignedIssues: { nodes: linearPages[page], pageInfo: { hasNextPage: page + 1 < linearPages.length, endCursor: String(page + 1) } } } } }));
  });
  await new Promise<void>(resolve => linearServer.listen(0, "127.0.0.1", resolve));
  process.env.LOOM_TEST_LINEAR_URL = `http://127.0.0.1:${(linearServer.address() as { port: number }).port}/graphql`;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir(); id = (await client.addProject(dir)).project.id; rt = await runtime();
});

afterEach(async () => {
  await flushIntakePrs(dir).catch(() => {});
  await daemon?.close();
  await new Promise<void>(resolve => linearServer.close(() => resolve()));
  for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
});

describe("assigned issue intake", () => {
  it("lists GitHub issues in the project repo and sends a bounded, quoted task to the selected echo agent", async () => {
    control.issues[0]!.body = "a".repeat(8000) + "SHOULD_BE_TRUNCATED"; save();
    const listed = await client.intake(id, "github", "loom");
    expect(listed.issues[0]).toEqual({ source: "github", id: issueUrl(1), number: 1, title: "Fix 1", url: issueUrl(1), labels: ["loom"] });
    expect(history()[0]).toMatchObject({ cwd: fs.realpathSync(dir), args: expect.arrayContaining(["issue", "list", "--assignee", "@me", "--state", "open", "--json", "number,title,body,labels,url", "--label", "loom"]) });
    const { issues } = await start([issueUrl(1)], { agent: "execbot" });
    const chat = issues[0]!.started!.chat!;
    expect(rt.chats().find(c => c.id === chat)).toMatchObject({ title: "#1 Fix 1", agentId: "execbot" });
    await waitUntil(() => rt.log.list({ chat, limit: 50 }).some(e => e.kind === "message" && e.agentId === "execbot"));
    const messages = rt.log.list({ chat, limit: 50 }).filter(e => e.kind === "message");
    const text = String(messages.find(e => e.payload.author === "user")!.payload.text);
    expect(text).toContain("quoted task description is a user-authored work request");
    expect(text).toContain(`> Fix 1\n> \n> ${"a".repeat(8000)}`);
    expect(text).toContain(`> ${issueUrl(1)}`);
    expect(text).not.toContain("SHOULD_BE_TRUNCATED");
    expect(readIntake(dir)[0]!.started.chat).toBe(chat);
  });

  it("serializes overlapping starts, survives restart and returns existing links even for closed issues", async () => {
    rt.queue.setPaused(true);
    const results = await Promise.all([start(), start(), start([issueUrl(1), issueUrl(1)])]);
    expect(new Set(results.map(r => r.issues[0]!.started!.chat)).size).toBe(1);
    expect(rt.queue.length).toBe(1);
    expect(readIntake(dir)).toHaveLength(1);
    const chat = results[0]!.issues[0]!.started!.chat;
    expect((await client.intake(id)).issues[0]!.started).toEqual({ chat });
    await daemon.close();
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
    client = new DaemonClient(readDaemonConfig()!); rt = await runtime();
    control.issues = []; save();
    expect((await start()).issues[0]!.started!.chat).toBe(chat);
    expect(rt.queue.length).toBe(1);
    expect(rt.chats().filter(c => c.title === "#1 Fix 1")).toHaveLength(1);
  });

  it("validates requests before starting work and fails honestly on provider errors", async () => {
    for (const body of [ { source: "bad", ids: [], mode: "chat" }, { source: "github", ids: [], mode: "bad" }, { source: "github", ids: [1], mode: "chat" }, { source: "github", ids: [issueUrl(1)], mode: "chat", agent: "missing" } ]) {
      expect((await api("POST", "/intake/start", body)).status).toBe(400);
    }
    await expect(start([issueUrl(1), "--help"])).rejects.toThrow("no longer open and assigned");
    expect(readIntake(dir)).toHaveLength(0);
    expect(rt.chats()).toHaveLength(1);
    expect((await api("GET", "/intake?source=other")).status).toBe(400);
    control.fail = true; save();
    await expect(client.intake(id)).rejects.toThrow("check gh login");
    await expect(client.intake(id, "linear")).rejects.toThrow("LINEAR_API_KEY");
  });

  it("resumes a reserved chat after an interrupted start without duplicating its queued task", async () => {
    rt.queue.setPaused(true);
    await start();
    const row = readIntake(dir)[0]!;
    saveIntake(dir, { ...row, pending: true });
    await start(); expect(rt.queue.length).toBe(1);
    rt.queue.remove(rt.queue.peek()!.id);
    saveIntake(dir, { ...row, pending: true });
    rt.queue.setPaused(true);
    await start(); expect(rt.queue.length).toBe(1);
    expect(readIntake(dir)[0]!.pending).toBe(false);
    expect(rt.chats().filter(c => c.title === "#1 Fix 1")).toHaveLength(1);
  });

  it("keeps a partial batch retryable when the queue is full and refuses a corrupt ledger", async () => {
    rt.queue.setPaused(true);
    for (let n = 0; n < 99; n++) rt.enqueue({ text: `existing ${n}` });
    await expect(start([issueUrl(1), issueUrl(2)])).rejects.toThrow("queue is full");
    expect(readIntake(dir)).toHaveLength(1);
    expect(rt.chats().filter(c => c.title.startsWith("#"))).toHaveLength(1);
    rt.queue.remove(rt.queue.peek()!.id);
    const { issues } = await start([issueUrl(1), issueUrl(2)]);
    expect(issues).toHaveLength(2);
    expect(rt.queue.length).toBe(100);
    expect(readIntake(dir)).toHaveLength(2);
    fs.writeFileSync(path.join(dir, ".loom", "intake.json"), "broken");
    await expect(start()).rejects.toThrow();
    expect(rt.chats().filter(c => c.title.startsWith("#"))).toHaveLength(2);
    // Restore the ledger so teardown can exercise the normal backlink path.
    fs.writeFileSync(path.join(dir, ".loom", "intake.json"), "[]");
  });

  it("paginates Linear assignedIssues, uses stored keys with env precedence and never exposes provider error text", async () => {
    setProvider("linear", { key: "stored-secret", baseUrl: "https://api.linear.app/graphql" });
    linearPages = [[linearIssue(1)], [linearIssue(2)]];
    expect((await client.intake(id, "linear", "loom")).issues.map(i => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(linearCalls[0]).toMatchObject({ authorization: "stored-secret", variables: { after: null, filter: { state: { type: { nin: ["completed", "canceled"] } }, labels: { name: { eq: "loom" } } } } });
    expect(linearCalls[0]!.query).toContain("viewer { assignedIssues");
    expect(linearCalls[1]!.variables.after).toBe("1");
    process.env.LINEAR_API_KEY = "env-secret";
    rt.queue.setPaused(true);
    const { issues } = await client.startIntake(id, { source: "linear", ids: ["uuid-1"], mode: "chat", agent: "plannerbot" });
    expect(rt.chats().find(c => c.id === issues[0]!.started!.chat)!.title).toBe("ENG-1 Linear 1");
    expect(rt.queue.peek()!.text).toContain("> Linear task");
    expect(linearCalls.at(-1)!.authorization).toBe("env-secret");
    linearFail = true;
    const failed = await api("GET", "/intake?source=linear");
    expect(failed.status).toBe(400);
    expect(JSON.stringify(failed.body)).not.toContain("env-secret");
    expect(failed.body.error).toContain("Linear intake failed");
  });

  it("posts GitHub and Linear PR backlinks once and retries failures from the durable ledger", async () => {
    rt.queue.setPaused(true);
    const chat = (await start()).issues[0]!.started!.chat!;
    control.fail = true; save();
    recordOpenedPr(dir, prUrl, { chat, source: "delivery" });
    await expect(flushIntakePrs(dir)).rejects.toThrow("GitHub intake failed");
    expect(readIntake(dir)[0]!.prs).toEqual([{ url: prUrl }]);
    control.fail = false; save();
    await rt.prFeedback.pollNow();
    expect(readIntake(dir)[0]!.prs).toEqual([{ url: prUrl, sent: true }]);
    const count = history().filter(c => c.args[1] === "comment").length;
    recordOpenedPr(dir, prUrl, { chat: "wrong", source: "delivery" });
    await flushIntakePrs(dir);
    expect(history().filter(c => c.args[1] === "comment")).toHaveLength(count);
    expect(history().filter(c => c.args[1] === "comment").at(-1)!.args).toEqual(["issue", "comment", issueUrl(1), "--body", `Loom opened a pull request for this issue: ${prUrl}`]);
    expect(intakePrBody(dir, chat, "Summary")).toBe("Summary\n\nCloses #1\n");
    expect(intakePrBody(dir, "main", "Summary")).toBe("Summary");
    process.env.LINEAR_API_KEY = "linear-secret";
    const linearChat = (await client.startIntake(id, { source: "linear", ids: ["uuid-1"], mode: "chat" })).issues[0]!.started!.chat!;
    recordOpenedPr(dir, "https://github.com/acme/app/pull/100", { chat: linearChat, source: "delivery" });
    await flushIntakePrs(dir);
    const comments = linearCalls.filter(c => c.query.includes("commentCreate"));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.variables.input).toEqual({ issueId: "uuid-1", body: "Loom opened a pull request for this issue: https://github.com/acme/app/pull/100" });
    expect(intakePrBody(dir, linearChat, "Summary")).toBe("Summary");
  });

  it("queues an orchestra per issue, records the dispatched run and adds the closing reference to a real delivery", async () => {
    git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); git("add", "-A"); git("commit", "-qm", "seed");
    const origin = tmpDir("intake-origin"); execFileSync("git", ["init", "-q", "--bare", origin]);
    git("remote", "add", "origin", origin); git("push", "-qu", "origin", "main");
    rt.queue.setPaused(true);
    const { issues } = await start([issueUrl(1), issueUrl(2)], { mode: "orchestra", agent: "plannerbot" });
    expect(rt.queue.snapshot().items.map(i => i.target)).toEqual([{ kind: "orchestra", orchestrator: "plannerbot" }, { kind: "orchestra", orchestrator: "plannerbot" }]);
    await api("POST", "/queue/pause", { paused: false });
    await waitUntil(() => rt.orchestra.list()[0]?.status === "waiting_human");
    const run = rt.orchestra.list()[0]!;
    expect(run.chat).toBe(issues[0]!.started!.chat);
    expect(rt.log.list({ chat: run.chat, kinds: ["message"], limit: 100 }).find(e => e.payload.author === "user")?.payload.text).toBe(run.goal);
    expect(readIntake(dir)[0]!.started).toEqual({ chat: run.chat, run: run.id });
    expect((await client.intake(id)).issues[0]!.started!.run).toBe(run.id);
    expect(rt.queue.length).toBe(1);
    fs.writeFileSync(path.join(run.dir, "fix.txt"), "fixed");
    await rt.orchestra.deliver(run, "pr");
    expect(run.deliveryError).toBeUndefined();
    await flushIntakePrs(dir);
    const creation = history().find(c => c.args[0] === "pr" && c.args[1] === "create")!;
    expect(creation.args[creation.args.indexOf("--body") + 1]).toContain("Closes #1");
    expect(readIntake(dir)[0]!.prs).toEqual([{ url: prUrl, sent: true }]);
  });

  it("keeps intake schedules off by default, uses the shared start path, and only starts newly assigned issues", async () => {
    rt.queue.setPaused(true);
    const { trigger } = await client.addTrigger(id, { kind: "intake", every: "1h", intake: { source: "github", label: "loom", mode: "chat" }, agent: "execbot" });
    expect(trigger.enabled).toBe(false); expect(trigger.nextAt).toBeNull();
    const runner = new TriggerRunner(() => runtime());
    const data = readTriggers(dir); const t = data.triggers[0]!; t.createdAt = Date.now() - 7_200_000; writeTriggers(dir, data);
    expect(isDue(t, new Date())).toBe(false);
    await runner.tick(); expect(rt.queue.length).toBe(0);
    await client.updateTrigger(id, trigger.id, { enabled: true });
    const enabled = readTriggers(dir).triggers[0]!;
    expect(nextFire(enabled)).toBe(enabled.createdAt + 3_600_000);
    await runner.tick(); expect(rt.queue.length).toBe(2);
    await client.fireTrigger(id, trigger.id); expect(rt.queue.length).toBe(2);
    control.issues.push(githubIssue(3)); save();
    await client.fireTrigger(id, trigger.id); expect(rt.queue.length).toBe(3);
    expect(rt.queue.snapshot().items.every(i => i.target.kind === "agent" && i.target.agentId === "execbot")).toBe(true);
    expect((await api("POST", "/triggers", { kind: "intake", every: "1h" })).status).toBe(400);
    expect((await api("POST", "/triggers", { kind: "intake", intake: { source: "github" } })).status).toBe(400);
  });

  it("lists and starts through the real CLI and honors label and source selection", async () => {
    rt.queue.setPaused(true);
    expect(await cli(["intake", "--github", "--label", "loom"])).toContain("#1 Fix 1");
    expect(await cli(["intake", "--label", "missing"])).toContain("No assigned issues");
    const result = JSON.parse(await cli(["intake", "--start", "--agent", "execbot", "--json"]));
    expect(result).toHaveLength(2); expect(result[0].started.chat).toBeTruthy();
    expect(rt.queue.length).toBe(2);
    await cli(["intake", "--start"]); expect(rt.queue.length).toBe(2);
    process.env.LINEAR_API_KEY = "linear-secret";
    expect(await cli(["intake", "--linear"])).toContain("ENG-1 Linear 1");
    await expect(cli(["intake", "--github", "--linear"])).rejects.toThrow("choose --github or --linear");
  });

  it("refuses scoped devices access to the owner's assignments", async () => {
    const pair = await fetch(`${client.baseUrl}/api/pair/new`, { method: "POST", headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ projects: [id] }) }).then(r => r.json());
    const claim = await fetch(`${client.baseUrl}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token, name: "scoped" }) }).then(r => r.json());
    expect((await api("GET", "/intake", undefined, claim.clientToken)).status).toBe(403);
    expect((await api("POST", "/intake/start", { source: "github", ids: [issueUrl(1)], mode: "chat" }, claim.clientToken)).status).toBe(403);
    expect(readIntake(dir)).toHaveLength(0);
  });
});
