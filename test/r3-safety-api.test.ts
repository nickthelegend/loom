import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requestApproval } from "../src/core/approvals.js";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { readSafety } from "../src/core/safety.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, id: string, dir: string;
const secret = "ghp_" + "Z".repeat(36);
const previousHome = process.env.LOOM_HOME;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-api-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { port } = await daemon.listen(); base = `http://127.0.0.1:${port}`;
  const cfg = readDaemonConfig()!; token = cfg.adminToken; client = new DaemonClient(cfg);
  dir = makeProjectDir({ name: "r3-safety", agents: [
    { id: "plannerbot", kind: "echo", role: "planner" },
    { id: "execbot", kind: "echo", role: "executor", options: { sandbox: "danger-full-access", permissionMode: "bypassPermissions" } },
  ] });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); git("add", ".gitignore"); git("commit", "-qm", "seed");
  id = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); if (previousHome === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = previousHome; });
async function api(url: string, method = "GET", body?: unknown, auth = token) {
  const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() as any };
}
const endpoint = () => `/api/projects/${id}`;
async function pair(body: object) {
  const minted = await api("/api/pair/new", "POST", body); expect(minted.status).toBe(200);
  const claimed = await api("/api/pair/claim", "POST", { token: minted.body.token, name: "r3-test" });
  expect(claimed.status).toBe(200); return claimed.body.clientToken as string;
}

it("saves presets and all rule fields, applies modes, rejects malformed settings without changing policy", async () => {
  const policy = { preset: "trusting", allow: ["Read*"], deny: ["mcp__*"], protectedPaths: ["private/**"], shellDeny: ["rm -rf *"], approvalTimeoutMin: 2 };
  expect((await api(endpoint() + "/safety", "PUT", policy)).status).toBe(200);
  expect((await api(endpoint() + "/safety")).body.policy).toEqual(policy);
  expect(readSafety(id)).toEqual(policy);
  expect(readProjectConfig(dir).agents.every(a => a.options?.permissions === "bypass")).toBe(true);
  expect(readProjectConfig(dir).agents.find(a => a.id === "execbot")!.options).not.toHaveProperty("sandbox");
  expect(readProjectConfig(dir).agents.find(a => a.id === "execbot")!.options).not.toHaveProperty("permissionMode");
  expect((await api(endpoint() + "/safety", "PUT", { ...policy, approvalTimeoutMin: -1 })).status).toBe(400);
  expect(readSafety(id)).toEqual(policy);
  const denied = await requestApproval({ project: id, agent: "execbot", tool: "mcp__delete", input: {} });
  expect(denied.behavior).toBe("deny");
  expect((await requestApproval({ project: id, agent: "execbot", tool: "Read", input: {} })).behavior).toBe("allow");
});

it("refuses scoped and share-live guests for safety, permission changes, secret overrides and risky audit", async () => {
  const scoped = await pair({ projects: [id] });
  const guest = await pair({ guest: { project: id, chat: "main", role: "approve", name: "Guest" } });
  for (const auth of [scoped, guest]) {
    expect((await api(endpoint() + "/safety", "PUT", { preset: "normal" }, auth)).status).toBe(403);
    expect((await api(endpoint() + "/safety", "GET", undefined, auth)).status).toBe(403);
    expect((await api(endpoint() + "/agents/execbot/permissions", "POST", { permissions: "bypass" }, auth)).status).toBe(403);
    expect((await api(endpoint() + "/git/commit", "POST", { message: "x", overrideSecrets: true }, auth)).status).toBe(403);
    expect((await api("/api/audit?risky=true", "GET", undefined, auth)).status).toBe(403);
  }
  const device = await pair({});
  expect((await api(endpoint() + "/safety", "PUT", { preset: "normal" }, device)).status).toBe(200);
});

it("auto-denies at the project deadline, records the decision once, and rejects late answers", async () => {
  expect((await api(endpoint() + "/safety", "PUT", { preset: "normal", approvalTimeoutMin: 0.01 })).status).toBe(200);
  const pending = requestApproval({ project: id, agent: "execbot", tool: "Bash", input: { command: `echo ${secret}` } });
  let card: any;
  await waitUntil(async () => { card = (await api(endpoint() + "/approvals")).body.approvals[0]; return !!card; });
  expect(card.expiresAt).toBeGreaterThan(card.createdAt); expect(JSON.stringify(card)).not.toContain(secret);
  expect(await pending).toMatchObject({ behavior: "deny", message: expect.stringContaining("0.01 minutes") });
  expect((await api(endpoint() + `/approvals/${card.id}`, "POST", { decision: "allow" })).status).toBe(404);
  const events = (await api(endpoint() + "/events")).body.events;
  expect(events.filter((e: any) => e.payload.approvalId === card.id && e.payload.phase === "decided")).toHaveLength(1);
  expect((await client.audit(0, true)).entries.some(e => e.who === "timed out")).toBe(true);
});

it("keeps ordinary approval and abort decisions race-safe", async () => {
  await api(endpoint() + "/safety", "PUT", { preset: "normal" });
  const ctl = new AbortController();
  const pending = requestApproval({ project: id, agent: "execbot", tool: "Bash", input: { command: "npm test" }, signal: ctl.signal });
  let card: any;
  await waitUntil(async () => { card = (await api(endpoint() + "/approvals")).body.approvals[0]; return !!card; });
  expect((await api(endpoint() + `/approvals/${card.id}`, "POST", { decision: "allow" })).status).toBe(200);
  ctl.abort(); expect(await pending).toMatchObject({ behavior: "allow" });
  expect((await api(endpoint() + "/approvals")).body.approvals).toEqual([]);
});

it("blocks a secret commit with safe findings, accepts an explicit override and audits it", async () => {
  fs.writeFileSync(path.join(dir, "leak.txt"), secret);
  expect((await api(endpoint() + "/git/stage", "POST", { paths: ["leak.txt"] })).status).toBe(200);
  const blocked = await api(endpoint() + "/git/commit", "POST", { message: "leak" });
  expect(blocked.status).toBe(409); expect(blocked.body.code).toBe("secrets_detected"); expect(JSON.stringify(blocked.body)).not.toContain(secret);
  const allowed = await api(endpoint() + "/git/commit", "POST", { message: "intentional", overrideSecrets: true });
  expect(allowed.status).toBe(200);
  expect((await client.audit(0, true)).entries.some(e => e.what === "secret_override")).toBe(true);
});

it("redacts real echo transcripts, exports and risky calls without spawning agent CLIs", async () => {
  const sent = await api(endpoint() + "/messages", "POST", { text: `hello ${secret}`, agentId: "execbot" }); expect(sent.status).toBe(200);
  await waitUntil(async () => (await api(endpoint() + "/events")).body.events.some((e: any) => e.kind === "message" && e.agentId === "execbot"));
  expect(JSON.stringify((await api(endpoint() + "/events")).body)).not.toContain(secret);
  const sendRisk = await api(endpoint() + "/messages", "POST", { text: "run: rm -rf /tmp/r3-example", agentId: "execbot" }); expect(sendRisk.status).toBe(200);
  await waitUntil(async () => (await client.audit(0, true)).entries.some(e => e.what.startsWith("risky tool:")));
  const replay = await fetch(base + endpoint() + "/chats/main/replay?download=1", { headers: { authorization: `Bearer ${token}` } });
  expect(replay.status).toBe(200); expect(await replay.text()).not.toContain(secret);
  const audit = await client.audit(0, true); expect(audit.entries.every(e => !e.what.includes("baton"))).toBe(true);
});


it("runs safety and risky-audit CLI commands against only the isolated daemon", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, timeout: 15_000 });
  const saved = JSON.parse((await cli("safety", "--preset", "strict")).stdout);
  expect(saved.policy.preset).toBe("strict");
  expect(JSON.parse((await cli("safety")).stdout).policy.protectedPaths).toContain(".env");
  const audit = JSON.parse((await cli("audit", "--risky", "--json")).stdout);
  expect(audit.some((e: any) => e.what === "secret_override")).toBe(true);
  await cli("safety", "--preset", "normal");
});

it("refuses changing policy during an active turn without mutating saved settings", async () => {
  const before = (await client.safety(id)).policy;
  await api(endpoint() + "/messages", "POST", { text: "sleep:2000 work", agentId: "execbot" });
  await waitUntil(async () => (await api(endpoint())).body.project.agents.some((a: any) => a.id === "execbot" && a.busy));
  expect((await api(endpoint() + "/safety", "PUT", { preset: "trusting" })).status).toBe(400);
  expect((await client.safety(id)).policy).toEqual(before);
  await client.interrupt(id);
  await waitUntil(async () => !(await api(endpoint())).body.project.agents.some((a: any) => a.busy));
});
