import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { TriggerRunner } from "../src/daemon/triggers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { isDue, readTriggers, writeTriggers, type Trigger } from "../src/core/triggers.js";
import { changeAutomation, parseQuiet, readAutomation, writeControl } from "../src/core/auto-r4/state.js";
import { queueWebhooks, readWebhooks, WebhookSender } from "../src/core/auto-r4/webhooks.js";
import { projectWebhookSecret, saveOrchestraRecipe } from "../src/core/orchestra-options.js";
import { savePrRecord } from "../src/core/pr-feedback.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, rt: ProjectRuntime, runner: TriggerRunner, dir: string, pid: string, base: string, admin: string;
const internals = () => daemon as unknown as { runtime(id: string): Promise<ProjectRuntime>; triggers: TriggerRunner; runtimes: Map<string, ProjectRuntime> };
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("a4-daemon"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  internals().triggers.stop();
  client = new DaemonClient(readDaemonConfig()!); admin = readDaemonConfig()!.adminToken;
  runner = new TriggerRunner(id => internals().runtime(id));
  runner.setOpenRuntimes(() => internals().runtimes.values());
});
beforeEach(async () => {
  writeControl({});
  dir = makeProjectDir({ routes: { review: ["plannerbot"] } });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  pid = (await client.addProject(dir)).project.id; rt = await internals().runtime(pid); rt.queue.setPaused(true);
  base = `/api/projects/${pid}/automation`;
});
afterAll(async () => { runner?.stop(); await daemon?.close(); });

async function request(route: string, method = "GET", body?: object, token = admin) {
  return fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function add(body: object, token = admin): Promise<Trigger> {
  const response = await request(base + "/triggers", "POST", body, token);
  const result = await response.json() as { trigger: Trigger; error?: string }; expect(result.error).toBeUndefined(); expect(response.status).toBe(200); return result.trigger;
}
async function device(body: object): Promise<string> {
  const pair = await (await request("/api/pair/new", "POST", body)).json() as { token: string };
  const response = await fetch(client.baseUrl + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token, name: "automation phone" }) });
  return ((await response.json()) as { clientToken: string }).clientToken;
}

it("matches legacy trigger gates and exposes only boolean machine controls to scoped devices", async () => {
  const otherProject = (await client.addProject(makeProjectDir())).project.id;
  const phone = await device({}), scoped = await device({ projects: [pid] }), other = await device({ projects: [otherProject] });
  const trigger = await add({ when: "every weekday at 9am", prompt: "owner" });
  for (const token of [phone, scoped]) {
    for (const body of [{ on: "turn_failed", prompt: "x" }, { onChange: "docs/**", prompt: "files" }, { every: "1h", condition: "cmd:exit 0", prompt: "cmd" }]) expect((await request(base + "/triggers", "POST", body, token)).status).toBe(403);
    expect((await request(base + `/triggers/${trigger.id}`, "PATCH", { prompt: "changed" }, token)).status).toBe(403);
    expect((await request(base + `/triggers/${trigger.id}`, "DELETE", undefined, token)).status).toBe(403);
  }
  for (const token of [admin, phone]) {
    expect((await request(base + `/triggers/${trigger.id}`, "PATCH", { enabled: false }, token)).status).toBe(200);
    expect((await request(base + `/triggers/${trigger.id}`, "PATCH", { enabled: true }, token)).status).toBe(200);
    expect((await request(base + `/triggers/${trigger.id}/fire`, "POST", {}, token)).status).toBe(200);
    expect((await request("/api/automation", "PUT", { quiet: "22:00-07:00", days: "mon-fri" }, token)).status).toBe(200);
    const added = await request(base + "/webhooks", "POST", { url: "http://127.0.0.1:9999", events: ["turn_finished"] }, token);
    expect(added.status).toBe(200);
    const { webhook } = await added.json() as any;
    queueWebhooks(dir, pid, "turn_finished", {}, token);
    const did = readWebhooks(dir).deliveries.at(-1)!.id;
    expect((await request(base + `/deliveries/${encodeURIComponent(did)}/resend`, "POST", {}, scoped)).status).toBe(403);
    expect((await request(base + `/deliveries/${encodeURIComponent(did)}/resend`, "POST", {}, token)).status).toBe(200);
    expect((await request(base + `/webhooks/${webhook.id}`, "DELETE", undefined, scoped)).status).toBe(403);
    expect((await request(base + `/webhooks/${webhook.id}`, "DELETE", undefined, token)).status).toBe(200);
  }
  for (const [suffix, method, body] of [[`/triggers/${trigger.id}/fire`, "POST", {}], [`/triggers/${trigger.id}`, "PATCH", { enabled: false }], ["/webhooks", "POST", { url: "http://192.168.1.2", events: ["turn_finished"] }]] as const) expect((await request(base + suffix, method, body, scoped)).status).toBe(403);
  expect((await request("/api/automation", "PUT", { paused: true }, scoped)).status).toBe(403);
  expect((await request("/api/automation", "GET", undefined, scoped)).status).toBe(403);
  expect((await request(base + "/preview", "POST", { when: "every weekday at 9am" }, scoped)).status).toBe(200);
  writeControl({ quiet: parseQuiet("22:00-07:00", "mon-fri"), paused: true, resumeAt: Date.now() + 60_000 });
  const view = await (await request(base, "GET", undefined, scoped)).json() as any;
  expect(view.control).toEqual({ quiet: true, paused: true }); expect(view.held).toBeTypeOf("number"); expect(view.hold).toBe("automation paused"); expect(view.canEditTriggers).toBe(false);
  writeControl({});
  expect((await (await request(base, "GET", undefined, scoped)).json() as any).control).toEqual({ quiet: false, paused: false });
  expect([403, 404]).toContain((await request(base, "GET", undefined, other)).status);
  const guest = await device({ guest: { project: pid, chat: "main", role: "view", name: "guest" } });
  expect([401, 403, 404]).toContain((await request(base, "GET", undefined, guest)).status);
});

it("debounces file changes through the serialized queue, excluding state and worktrees", async () => {
  await add({ onChange: "docs/**", prompt: "Review {{files}}" });
  fs.mkdirSync(path.join(dir, "docs")); await runner.tickAutomation(1000);
  fs.writeFileSync(path.join(dir, "docs/a.md"), "a"); await runner.tickAutomation(1500);
  fs.writeFileSync(path.join(dir, "docs/b.md"), "b"); await runner.tickAutomation(1800);
  expect(rt.queue.length).toBe(0); await runner.tickAutomation(16800);
  expect(rt.queue.snapshot().items[0]?.text).toContain('["docs/a.md","docs/b.md"]');
  expect(rt.queue.length).toBe(1);
});

it("observes local and fetched branch commits without firing on its initial baseline", async () => {
  const t = await add({ onCommit: "main", prompt: "Review {{range}}\n{{commits}}" });
  await runner.tickAutomation(); expect(rt.queue.length).toBe(0);
  const previous = git("rev-parse", "HEAD"); fs.writeFileSync(path.join(dir, "new"), "x"); git("add", "new"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "new commit");
  await runner.tickAutomation(); expect(rt.queue.snapshot().items[0]?.text).toContain(`${previous}..`); expect(rt.queue.snapshot().items[0]?.text).toContain("new commit");
  await request(base + `/triggers/${t.id}`, "PATCH", { enabled: false });
  rt.queue.clear(); rt.queue.setPaused(true);
  const source = tmpDir("a4-remote"); execFileSync("git", ["clone", "-q", dir, source]);
  git("remote", "add", "origin", source); git("fetch", "-q", "origin");
  await add({ onCommit: "origin/main", prompt: "Fetched {{commits}}" }); await runner.tickAutomation();
  fs.writeFileSync(path.join(source, "remote-file"), "remote");
  execFileSync("git", ["add", "."], { cwd: source }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "remote commit"], { cwd: source });
  git("fetch", "-q", "origin"); await runner.tickAutomation(); expect(rt.queue.snapshot().items[0]?.text).toContain("remote commit");
});

it("delivers events with fields, records failed turns, and never triggers itself", async () => {
  const t = await add({ on: "turn_failed", prompt: "Fix {{event.message}}", failureLimit: 2 });
  rt.log.append({ kind: "error", agentId: "plannerbot", payload: { message: "first failure" } }); await runner.tickAutomation();
  expect(rt.queue.snapshot().items[0]?.text).toContain("Fix first failure");
  const chat = readTriggers(dir).triggers.find(x => x.id === t.id)!.chat;
  rt.queue.shift(); rt.log.append({ kind: "error", agentId: "plannerbot", chat, payload: { message: "own failure" } }); await runner.tickAutomation();
  expect(rt.queue.length).toBe(0); expect(readTriggers(dir).triggers.find(x => x.id === t.id)?.failures).toBe(1);
  rt.log.append({ kind: "error", agentId: "plannerbot", payload: { message: "second failure" } }); await runner.tickAutomation();
  rt.queue.shift(); rt.log.append({ kind: "error", agentId: "plannerbot", chat, payload: { message: "second own failure" } }); await runner.tickAutomation();
  expect(readTriggers(dir).triggers.find(x => x.id === t.id)?.enabled).toBe(false);
  expect(rt.log.list({ kinds: ["needs_input"] }).some(e => e.payload.trigger === t.id)).toBe(true);
  expect(readTriggers(dir).runs.some(r => r.note.includes("paused after 2"))).toBe(true);
});

it("uses existing PR facts for merges and CI failure events without duplicate firings", async () => {
  await add({ on: "ci_failed", prompt: "Check {{event.check}} at {{event.commit}}" });
  await add({ on: "pr_merged", prompt: "Merged {{event.prNumber}}" });
  savePrRecord(dir, { repo: "owner/repo", prNumber: 1, chat: "main", source: "delivery", openedAt: Date.now(), checkedAt: Date.now(), state: "MERGED", url: "https://github.com/owner/repo/pull/1", signatures: [JSON.stringify(["ci", "tests", "abc"])] });
  await runner.tickAutomation(); expect(rt.queue.snapshot().items.map(i => i.text).join("\n")).toContain("Check tests at abc");
  expect(rt.queue.snapshot().items.map(i => i.text).join("\n")).toContain("Merged 1");
  const count = rt.queue.length; await runner.tickAutomation(); expect(rt.queue.length).toBe(count);
});

it("counts a rejected queued action as a failed run and pauses only its trigger", async () => {
  const t = await add({ on: "approval_expired", prompt: "repair", route: "review", failureLimit: 1 });
  rt.log.append({ kind: "approval", payload: { phase: "decided", behavior: "deny", message: "No answer within 10 minutes — denied." } });
  await runner.tickAutomation();
  delete rt.config.routes!.review;
  rt.queue.setPaused(false); await rt.drainPromptQueue(); await runner.tickAutomation();
  expect(readTriggers(dir).triggers.find(x => x.id === t.id)).toMatchObject({ failures: 1, enabled: false });
  expect(rt.queue.paused).toBe(false);
  expect(rt.log.list({ kinds: ["needs_input"] }).at(-1)?.payload.question).toContain("paused after 1");
});

it("allows the next firing after the user removes a waiting automation prompt", async () => {
  const t = await add({ every: "1h", prompt: "removable" });
  await runner.fire(pid, dir, t.id, { kind: "manual" });
  rt.queue.remove(rt.queue.snapshot().items[0]!.id); rt.queue.setPaused(true);
  expect((await runner.fire(pid, dir, t.id, { kind: "manual" })).ok).toBe(true);
  rt.queue.clear(); expect(readAutomation(dir).pending[t.id]).toBeUndefined();
});

it("records condition skips, durably holds triggers and timed queue items, then releases them", async () => {
  const skipped = await add({ every: "1h", prompt: "skip", condition: "dirty" });
  expect((await runner.fire(pid, dir, skipped.id, { kind: "manual" })).note).toContain("condition dirty");
  expect(readTriggers(dir).runs.at(-1)?.ok).toBe(false);
  const t = await add({ every: "1h", prompt: "held prompt" });
  await request("/api/automation", "PUT", { paused: true, for: "2h" });
  await runner.fire(pid, dir, t.id, { kind: "scheduled" }); await runner.fire(pid, dir, t.id, { kind: "scheduled" });
  expect(readAutomation(dir).held).toHaveLength(1);
  rt.enqueue({ text: "timed prompt", target: { kind: "agent", agentId: "plannerbot" }, when: { kind: "at", at: Date.now() - 1 } });
  rt.queue.setPaused(false); await rt.drainPromptQueue(); expect(rt.queue.length).toBe(1);
  const view = await (await request(base)).json() as { held: number }; expect(view.held).toBe(2);
  writeControl({ paused: true, resumeAt: Date.now() - 1 });
  const restarted = new TriggerRunner(id => internals().runtime(id)); restarted.setOpenRuntimes(() => internals().runtimes.values()); await restarted.tickAutomation(); await rt.drainPromptQueue();
  await waitUntil(() => rt.log.list({ kinds: ["message"] }).some(e => e.agentId && String(e.payload.text).includes("held prompt")));
  expect(readAutomation(dir).held).toHaveLength(0);
});

it("queues saved routes, Orchestra goals and full Orchestra recipe options", async () => {
  saveOrchestraRecipe("a4-recipe", { goal: "recipe goal", orchestrator: "plannerbot", workers: ["execbot"], planOnly: true, maxUsd: 7 });
  for (const action of [{ route: "review" }, { orchestrate: true }, { recipe: "a4-recipe" }]) {
    const t = await add({ kind: "webhook", prompt: action.recipe ? "" : "do work", ...action });
    expect((await runner.fire(pid, dir, t.id, { kind: "webhook", delivery: t.id })).ok).toBe(true);
  }
  const items = rt.queue.snapshot().items;
  expect(items[0]?.target).toMatchObject({ kind: "auto", routeName: "review" });
  expect(items[1]?.target).toMatchObject({ kind: "orchestra" });
  expect(items[2]?.target).toMatchObject({ kind: "orchestra", recipeOptions: { planOnly: true, maxUsd: 7 } });
  rt.queue.clear(); rt.queue.unshift(items[2]!); rt.queue.setPaused(false); await rt.drainPromptQueue();
  await waitUntil(() => rt.orchestra.list().some(r => r.goal.includes("recipe goal")));
  const run = rt.orchestra.list().find(r => r.goal.includes("recipe goal"))!; expect(run.planOnly).toBe(true); expect(run.budgetUsd).toBe(7);
  await rt.orchestra.abort(run.id);
  rt.queue.unshift(items[0]!); await rt.drainPromptQueue();
  await waitUntil(() => rt.log.list({ kinds: ["route_completed"] }).length > 0);
  rt.queue.unshift(items[1]!); await rt.drainPromptQueue();
  await waitUntil(() => Boolean(rt.orchestra.active()));
  expect(rt.orchestra.active()!.goal).toContain("do work");
  await rt.orchestra.abort(rt.orchestra.active()!.id);
});

it("signs outgoing events, retries failures, and sends again with a new delivery id", async () => {
  const received: Array<{ body: string; signature: string; id: string }> = [];
  const server = http.createServer((req, res) => { let body = ""; req.on("data", c => { body += c; }); req.on("end", () => { received.push({ body, signature: String(req.headers["x-loom-signature-256"]), id: String(req.headers["x-loom-delivery"]) }); res.statusCode = received.length === 1 ? 503 : 200; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    expect((await request(base + "/webhooks", "POST", { url: `http://127.0.0.1:${port}`, events: ["turn_finished"] })).status).toBe(200);
    rt.log.append({ kind: "run_complete", agentId: "plannerbot", payload: { result: "done" } }); await runner.tickAutomation();
    await waitUntil(() => readWebhooks(dir).deliveries[0]?.attempts === 1);
    expect(received).toHaveLength(1);
    expect(received[0]!.signature).toBe("sha256=" + createHmac("sha256", projectWebhookSecret(dir)).update(received[0]!.body).digest("hex"));
    const pending = readWebhooks(dir).deliveries[0]!; expect(pending.status).toBe("pending");
    const sender = new WebhookSender(); await sender.tick(dir, pending.nextAt!);
    expect(readWebhooks(dir).deliveries[0]?.status).toBe("sent"); expect(received[1]!.id).toBe(received[0]!.id);
    await request(base + "/deliveries/" + encodeURIComponent(pending.id) + "/resend", "POST", {}); await sender.tick(dir);
    expect(received).toHaveLength(3); expect(received[2]!.id).not.toBe(received[0]!.id);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

const root = process.cwd();
const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", LOOM_AUTO_RESTART: "off" }, timeout: 90_000 })).stdout;

it("runs the actual CLI for schedule previews, watches, quiet hours and pause/resume", async () => {
  const out = await cli("triggers:add", "review docs", "--when", "every weekday at 9am", "--if", "clean");
  expect(out).toContain("Cron: 0 9 * * 1-5"); expect(out.indexOf("Cron:")).toBeLessThan(out.indexOf("✓"));
  await cli("triggers:add", "review {{files}}", "--on-change", "docs/**");
  await cli("quiet", "22:00-07:00", "--days", "mon-fri");
  expect(JSON.parse(await cli("triggers:pause", "--for", "2h")).control.paused).toBe(true);
  expect(JSON.parse(await cli("triggers:resume")).control.paused).toBe(false);
  expect(readTriggers(dir).triggers.some(t => t.kind === "file")).toBe(true);
}, 240_000);

it("preserves actual CLI send JSON and NDJSON contracts", async () => {
  const waited = await cli("send", "contract check", "--agent", "plannerbot", "--wait", "--json");
  expect(JSON.parse(waited)).toBeTypeOf("object");
  const streamed = await cli("send", "stream check", "--agent", "plannerbot", "--stream");
  const frames = streamed.trim().split("\n").map(line => JSON.parse(line));
  expect(frames.length).toBeGreaterThan(1);
}, 240_000);

it("consumes a failed schedule slot and preserves pending runs when preflight throws", async () => {
  const t = await add({ every: "1h", prompt: "scheduled", route: "review" });
  const data = readTriggers(dir); data.triggers[0]!.createdAt = Date.now() - 3_600_001; writeTriggers(dir, data);
  delete rt.config.routes!.review;
  changeAutomation(dir, s => { s.pending[t.id] = 123; });
  await runner.tick();
  const failed = readTriggers(dir).triggers[0]!;
  expect(failed.failures).toBe(1); expect(failed.lastFiredAt).toBeGreaterThan(0);
  expect(readAutomation(dir).pending[t.id]).toBe(123);
  await runner.tick(new Date(failed.lastFiredAt! + 1000)); await runner.tick(new Date(failed.lastFiredAt! + 2000));
  expect(readTriggers(dir).triggers[0]!.failures).toBe(1);
  expect(isDue(failed, new Date(failed.lastFiredAt! + 3_600_000))).toBe(true);
});

it("uses independent 20s schedules and 15s automation without opening idle projects", async () => {
  const t = await add({ every: "1h", prompt: "later" });
  const runtime = vi.fn(async () => rt), isolated = new TriggerRunner(runtime);
  const engine = (isolated as any).automation; const background = vi.spyOn(engine, "tick").mockResolvedValue(undefined);
  try {
    vi.useFakeTimers(); isolated.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime).not.toHaveBeenCalled(); expect(background).not.toHaveBeenCalled();
    isolated.setOpenRuntimes(() => [rt]);
    await vi.advanceTimersByTimeAsync(15_000); expect(background).not.toHaveBeenCalled();
    const data = readTriggers(dir); data.triggers[0] = { ...t, kind: "file", onChange: "docs/**" }; writeTriggers(dir, data);
    await vi.advanceTimersByTimeAsync(14_999); expect(background).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(background).toHaveBeenCalledTimes(1); expect(runtime).not.toHaveBeenCalled();
  } finally { isolated.stop(); vi.useRealTimers(); }
});

it("releases held deliveries without history churn while another run waits or runs", async () => {
  const t = await add({ kind: "webhook", prompt: "held" });
  writeControl({ paused: true });
  for (const delivery of ["first", "second"]) await runner.fire(pid, dir, t.id, { kind: "webhook", delivery });
  changeAutomation(dir, s => { s.held.forEach(h => { h.at = 1; }); });
  writeControl({}); await runner.tickAutomation();
  expect(readAutomation(dir).held).toHaveLength(1);
  const count = readTriggers(dir).runs.length;
  for (let i = 0; i < 4; i++) await runner.tickAutomation();
  expect(readTriggers(dir).runs).toHaveLength(count);
  changeAutomation(dir, s => { delete s.pending[t.id]; });
  await runner.tickAutomation(); expect(readTriggers(dir).runs).toHaveLength(count);
  changeAutomation(dir, s => { s.pending[t.id] = rt.log.lastId(); });
  rt.queue.shift(); // pending still represents an active turn
  await runner.tickAutomation(); expect(readTriggers(dir).runs).toHaveLength(count);
  changeAutomation(dir, s => { delete s.pending[t.id]; });
  await runner.tickAutomation(); expect(readAutomation(dir).held).toHaveLength(0); expect(rt.queue.length).toBe(1);
});

it("resets dormant cursors on new triggers and webhooks and excludes old event deliveries", async () => {
  const t = await add({ on: "turn_failed", prompt: "old" });
  await request(base + `/triggers/${t.id}`, "DELETE");
  rt.log.append({ kind: "run_complete", payload: { old: true } });
  const fresh = await add({ on: "turn_failed", prompt: "new" });
  expect(readAutomation(dir).cursor).toBe(rt.log.lastId());
  await request(base + `/triggers/${fresh.id}`, "DELETE");
  rt.log.append({ kind: "run_complete", payload: { old: true } });
  await request(base + "/webhooks", "POST", { url: "http://127.0.0.1:9999", events: ["turn_finished"] });
  expect(readAutomation(dir).cursor).toBe(rt.log.lastId());
  const hook = readWebhooks(dir).webhooks[0]!;
  queueWebhooks(dir, pid, "turn_finished", {}, "old", hook.createdAt! - 1);
  expect(readWebhooks(dir).deliveries).toHaveLength(0);
  queueWebhooks(dir, pid, "turn_finished", {}, "new", hook.createdAt!);
  expect(readWebhooks(dir).deliveries).toHaveLength(1);
});

it("bounds alternating successful event-trigger chains and stores depth with the queued chat", async () => {
  const a = await add({ on: "run_completed", prompt: "A", orchestrate: true });
  const b = await add({ on: "run_completed", prompt: "B", orchestrate: true });
  await runner.fire(pid, dir, a.id, { kind: "manual" });
  for (const [id, depth] of [[a.id, 0], [b.id, 1], [a.id, 2]] as const) {
    const chat = readTriggers(dir).triggers.find(t => t.id === id)!.chat!;
    expect(readAutomation(dir).depth[chat]).toBe(depth);
    rt.queue.shift(); rt.log.append({ kind: "orchestra", chat, payload: { phase: "completed" } });
    await runner.tickAutomation();
  }
  expect(rt.queue.length).toBe(0);
  expect(readTriggers(dir).runs.at(-1)).toMatchObject({ trigger: b.id, note: "skipped: started by a chain of automation runs" });
});

it("retains file batches and branch ranges accumulated while the previous run is busy", async () => {
  fs.mkdirSync(path.join(dir, "docs"));
  const file = await add({ onChange: "docs/**", prompt: "{{files}}" });
  await runner.tickAutomation(0);
  fs.writeFileSync(path.join(dir, "docs/a"), "a"); await runner.tickAutomation(1000); await runner.tickAutomation(16000);
  expect(rt.queue.length).toBe(1);
  fs.writeFileSync(path.join(dir, "docs/b"), "b"); await runner.tickAutomation(17000); await runner.tickAutomation(32000);
  rt.queue.clear(); rt.queue.setPaused(true); await runner.tickAutomation(47000);
  expect(rt.queue.snapshot().items[0]?.text).toContain("docs/b");
  await request(base + `/triggers/${file.id}`, "PATCH", { enabled: false }); rt.queue.clear(); rt.queue.setPaused(true);
  const branch = await add({ onCommit: "main", prompt: "{{range}} {{commits}}" });
  const commit = (name: string) => { fs.writeFileSync(path.join(dir, name), name); git("add", name); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name); };
  commit("first"); await runner.tickAutomation(); const previous = git("rev-parse", "HEAD");
  commit("second"); await runner.tickAutomation(); expect(readAutomation(dir).watches[branch.id]?.value).toBe(previous);
  commit("third"); rt.queue.clear(); rt.queue.setPaused(true); await runner.tickAutomation();
  expect(rt.queue.snapshot().items[0]?.text).toContain(`${previous}..`);
  expect(rt.queue.snapshot().items[0]?.text).toContain("second"); expect(rt.queue.snapshot().items[0]?.text).toContain("third");
});

it("fires due schedules even while the independent automation loop is unfinished", async () => {
  const t = await add({ every: "1m", prompt: "due" });
  const data = readTriggers(dir); data.triggers[0]!.createdAt = Date.now() - 61_000; writeTriggers(dir, data);
  changeAutomation(dir, s => { s.held.push({ trigger: t.id, at: 1, opts: { kind: "manual" } }); });
  const isolated = new TriggerRunner(async () => rt); isolated.setOpenRuntimes(() => [rt]);
  let release!: () => void;
  vi.spyOn((isolated as any).automation, "tick").mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const background = isolated.tickAutomation();
  try { await isolated.tick(); expect(rt.queue.snapshot().items[0]?.text).toContain("due"); }
  finally { release(); await background; }
});


it.each([
  { target: {}, kind: "run_complete", payload: {} },
  { target: { route: "review" }, kind: "route_completed", payload: {} },
  { target: { orchestrate: true }, kind: "orchestra", payload: { phase: "completed" } },
] as const)("reconciles completed $kind runs before firing again without a background poll", async ({ target, kind, payload }) => {
  const t = await add({ every: "1h", prompt: "repeat", ...target });
  await runner.fire(pid, dir, t.id, { kind: "manual" });
  expect((await runner.fire(pid, dir, t.id, { kind: "scheduled" })).note).toContain("still waiting");
  const chat = readTriggers(dir).triggers[0]!.chat!;
  rt.queue.shift(); // Dispatch has started, but no completion has arrived.
  rt.log.append({ kind: "run_complete", chat: "unrelated", payload: {} });
  if (kind !== "run_complete") rt.log.append({ kind: "run_complete", chat, payload: {} });
  expect((await runner.fire(pid, dir, t.id, { kind: "scheduled" })).note).toContain("still running");
  const cursor = readAutomation(dir).cursor;
  rt.log.append({ kind, chat, payload });
  expect(await runner.fire(pid, dir, t.id, { kind: "scheduled" })).toMatchObject({ ok: true });
  expect(rt.queue.length).toBe(1);
  const pending = readAutomation(dir).pending[t.id];
  expect(pending).toBeDefined();
  expect(readAutomation(dir).cursor).toBe(cursor); // Event delivery still belongs to the background loop.
  await runner.tickAutomation();
  expect(readAutomation(dir).pending[t.id]).toBe(pending); // The old completion cannot clear the new run.
  expect(readTriggers(dir).runs.filter(r => r.trigger === t.id && r.note === "completed")).toHaveLength(1);
});

it("honors the failure breaker when reconciling before the next schedule", async () => {
  const t = await add({ every: "1h", prompt: "fail", failureLimit: 1 });
  await runner.fire(pid, dir, t.id, { kind: "manual" });
  const chat = readTriggers(dir).triggers[0]!.chat!;
  rt.queue.shift();
  rt.log.append({ kind: "error", chat, payload: { message: "failed turn" } });
  expect(await runner.fire(pid, dir, t.id, { kind: "scheduled" })).toMatchObject({ ok: false, note: "skipped: trigger paused" });
  expect(rt.queue.length).toBe(0);
  await runner.tickAutomation();
  expect(readTriggers(dir).triggers[0]).toMatchObject({ enabled: false, failures: 1 });
});
