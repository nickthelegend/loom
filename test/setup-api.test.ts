import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { BUILTIN_PROVIDERS } from "../src/core/providers.js";
import { runSetupCommand, type InstallEvent, type SetupCommand } from "../src/core/setup-install.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, token: string, fail: boolean;
let calls: SetupCommand[];
const sockets: WebSocket[] = [];
const request = (route: string, method = "GET", body?: unknown, auth = token) => fetch(client.baseUrl + route, {
  method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function pair(body: object = {}) {
  const minted = await (await request("/api/pair/new", "POST", body)).json();
  return (await (await request("/api/pair/claim", "POST", { token: minted.token, name: "setup" })).json()).clientToken as string;
}
async function watch(auth = token) {
  const events: InstallEvent[] = [];
  const socket = new WebSocket(client.baseUrl.replace("http", "ws") + `/ws?token=${encodeURIComponent(auth)}`);
  sockets.push(socket);
  socket.on("message", frame => { const event = JSON.parse(String(frame)); if (event.type === "setup:install") events.push(event); });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return events;
}
beforeEach(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("setup-api"));
  const home = tmpDir("setup-user");
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  for (const p of BUILTIN_PROVIDERS) for (const key of p.envKeys) vi.stubEnv(key, "");
  calls = []; fail = false;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, setup: {
    agents: async () => [],
    run: (spec, opts) => {
      calls.push(spec);
      const script = spec.args[0] === "i"
        ? `console.log("installing"); setTimeout(() => { console.error("notice"); process.exit(${fail ? 1 : 0}) }, 200)`
        : `console.log(${JSON.stringify(spec.args[0] === "prefix" ? home : "fake 2.0")})`;
      return runSetupCommand({ command: process.execPath, args: ["-e", script] }, opts);
    },
  } });
  await daemon.listen();
  token = readDaemonConfig()!.adminToken; client = new DaemonClient(readDaemonConfig()!);
});
afterEach(async () => { for (const ws of sockets.splice(0)) ws.terminate(); await daemon?.close(); vi.unstubAllEnvs(); });

it("streams real fake-process output over WS, returns detected version, and rejects concurrent installs", async () => {
  const events = await watch();
  const installing = request("/api/setup/install", "POST", { kind: "codex" });
  await waitUntil(() => events.some(e => e.phase === "output"));
  expect((await request("/api/setup/install", "POST", { kind: "codex" })).status).toBe(409);
  const response = await installing;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, version: "fake 2.0" });
  await waitUntil(() => events.some(e => e.phase === "finished"));
  expect(events[0]).toMatchObject({ type: "setup:install", kind: "codex", phase: "started" });
  expect(events.at(-1)).toMatchObject({ phase: "finished", ok: true, version: "fake 2.0" });
  expect(events).toContainEqual({ type: "setup:install", kind: "codex", phase: "output", stream: "stderr", line: "notice" });
  expect(calls.map(c => [c.command, ...c.args])).toEqual([["npm", "i", "-g", "@openai/codex"], ["codex", "--version"]]);
  fail = true;
  const failed = await request("/api/setup/install", "POST", { kind: "codex" });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ ok: false, version: null, error: "notice" });
  fail = false;
  expect((await client.installAgent("codex")).ok).toBe(true);
});

it("rejects unknown kinds and all command overrides before running anything", async () => {
  for (const body of [{ kind: "unknown" }, { kind: "constructor" }, { kind: "codex; exit" }, { kind: "codex", args: [] }, { kind: "codex", command: "node" }, {}, { kind: 1 }, ["codex"]]) {
    expect((await request("/api/setup/install", "POST", body)).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

it("refuses devices, scoped tokens and guests, accepts owners, and hides machine progress from scopes", async () => {
  const { project } = await client.addProject(makeProjectDir());
  const device = await pair();
  const scoped = await pair({ projects: [project.id] });
  const guest = await pair({ guest: { project: project.id, chat: "main", role: "view" } });
  const owner = await pair({ owner: true });
  const scopedEvents = await watch(scoped), guestEvents = await watch(guest);
  for (const auth of [device, scoped, guest, "invalid"]) {
    expect((await request("/api/setup/install", "POST", { kind: "codex" }, auth)).status).toBe(auth === "invalid" ? 401 : 403);
    for (const action of ["dismiss", "restore"]) expect((await request(`/api/onboarding/${action}`, "POST", {}, auth)).status).toBe(auth === "invalid" ? 401 : 403);
  }
  expect(calls).toEqual([]);
  for (const route of ["/api/onboarding", "/api/setup/requirements"]) {
    expect((await request(route, "GET", undefined, device)).status).toBe(200);
    for (const auth of [scoped, guest, "invalid"]) expect((await request(route, "GET", undefined, auth)).status).toBe(auth === "invalid" ? 401 : 403);
  }
  expect((await request("/api/setup/install", "POST", { kind: "opencode" }, owner)).status).toBe(200);
  expect((await request("/api/onboarding/dismiss", "POST", {}, owner)).status).toBe(200);
  expect(scopedEvents).toEqual([]); expect(guestEvents).toEqual([]);
});

it("returns requirements with fix text and permission/disk facts", async () => {
  const report = await client.setupRequirements();
  expect(report.node.ok).toBe(true);
  expect(report.git).toMatchObject({ ok: true, version: "fake 2.0", fix: "" });
  expect(report.npm).toMatchObject({ ok: true, needsSudo: false });
  expect(report.disk.freeBytes).toBeGreaterThan(0);
});

it("loom setup prints derived progress and JSON; setup install calls only the isolated daemon", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = (args: string[]) => promisify(execFile)(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], {
    cwd: tmpDir("setup-cli-outside"), env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const text = (await cli(["setup"])).stdout;
  expect(text).toContain("Get started"); expect(text).toContain("○ Try the demo");
  expect(text).toContain("loom try"); expect(text).toContain("--workers");
  expect(JSON.parse((await cli(["setup", "--json"])).stdout)).toEqual(await client.onboarding());
  await client.addProject(makeProjectDir());
  expect((await cli(["setup"])).stdout).toContain("✓ Open a project");
  expect((await cli(["setup", "install", "codex"])).stdout).toContain("codex installed: fake 2.0");
  await expect(cli(["setup", "install", "nope"])).rejects.toThrow("unknown install kind");
  fail = true;
  await expect(cli(["setup", "install", "codex"])).rejects.toThrow("notice");
});
