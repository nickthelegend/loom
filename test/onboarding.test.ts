import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, registerProject } from "../src/core/registry.js";
import { BUILTIN_PROVIDERS, forgetProvider, setProvider } from "../src/core/providers.js";
import { AGENT_SKILLS_VERSION, installAgentSkills, uninstallAgentSkills } from "../src/core/agent-skills.js";
import { createShare, revokeShare } from "../src/core/shares.js";
import { EventLog } from "../src/core/eventlog.js";
import type { OnboardingOptions, OnboardingStep } from "../src/core/onboarding.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, home: string;
let agents: Awaited<ReturnType<NonNullable<OnboardingOptions["agents"]>>>;
async function start() {
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, setup: { agents: async () => agents } });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
}
const step = async (id: OnboardingStep["id"]) => (await client.onboarding()).steps.find(s => s.id === id)!;
const call = (route: string, body: unknown, token = readDaemonConfig()!.adminToken) => fetch(client.baseUrl + route, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
async function pair(body: object) {
  const minted = await (await call("/api/pair/new", body)).json();
  return (await (await call("/api/pair/claim", { token: minted.token, name: "onboarding" })).json()).clientToken as string;
}
beforeEach(async () => {
  home = tmpDir("onboarding-user");
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("LOOM_HOME", tmpDir("onboarding-home"));
  vi.stubEnv("LOOM_NO_NOTIFY", "1"); vi.stubEnv("LOOM_DEMO_DURATION_MS", "0");
  for (const p of BUILTIN_PROVIDERS) for (const key of p.envKeys) vi.stubEnv(key, "");
  agents = [];
  await start();
});
afterEach(async () => { await daemon?.close(); vi.unstubAllEnvs(); });

it("starts entirely incomplete, with ordered stable UI actions and optional sharing", async () => {
  const report = await client.onboarding();
  expect(report.dismissed).toBe(false);
  expect(report.steps.map(s => s.id)).toEqual(["demo", "agent", "project", "message", "fleet", "phone", "skills", "share"]);
  expect(report.steps.map(s => s.action)).toEqual(["try", "install-agent", "open-project", "send-message", "run-fleet", "pair-phone", "skills", "share"]);
  expect(report.steps.every(s => !s.done && s.detail.length > 0)).toBe(true);
  expect(report.steps.filter(s => s.optional).map(s => s.id)).toEqual(["share"]);
});

it("counts a demo marker and a registered project, but a demo agent alone only means tried", async () => {
  await client.addProject(makeProjectDir({ agents: [{ id: "demo", kind: "demo" }] }));
  expect((await step("demo")).done).toBe(false);
  expect(await step("agent")).toMatchObject({ done: false, detail: expect.stringContaining("Demo tried") });
  await client.tryProject({ dir: path.join(tmpDir("onboarding-demo"), "demo") });
  expect((await step("demo")).done).toBe(true);
  expect((await step("project")).done).toBe(true);
  expect((await step("agent")).done).toBe(false);
  expect((await step("message")).done).toBe(false);
});

it("requires a detected, signed-in real CLI, or an explicitly configured provider", async () => {
  for (const status of [
    { kind: "demo", found: true, authed: true }, { kind: "echo", found: true, authed: true },
    { kind: "model", found: true, authed: true }, { kind: "codex", found: false, authed: true },
    { kind: "codex", found: true, authed: false }, { kind: "codex", found: true, authed: null },
  ]) { agents = [status]; expect((await step("agent")).done).toBe(false); }
  agents = [{ kind: "codex", found: true, authed: true }];
  expect((await step("agent")).done).toBe(true);
  agents = [];
  setProvider("openrouter", { key: "test-only-key" });
  expect((await step("agent")).done).toBe(true);
  forgetProvider("openrouter");
  expect((await step("agent")).done).toBe(false);
  setProvider("ollama", { baseUrl: "http://127.0.0.1:11434" });
  expect((await step("agent")).done).toBe(true);
});

it("reads a finished echo turn from any project's non-main chat, including after restart", async () => {
  await client.addProject(makeProjectDir());
  const dir = makeProjectDir();
  const { project } = await client.addProject(dir);
  const { chat } = await client.createChat(project.id, "another chat");
  const log = await EventLog.open(path.join(dir, ".loom"));
  log.append({ kind: "message", chat: chat.id, payload: { text: "not a finished turn", author: "user" } });
  log.close();
  expect((await step("message")).done).toBe(false);
  const sent = await call(`/api/projects/${project.id}/messages`, { text: "hello", agentId: "execbot", chat: chat.id });
  expect(sent.status).toBe(200);
  await waitUntil(async () => (await step("message")).done);
  await daemon.close(); await start();
  expect((await step("message")).done).toBe(true);
});

it.each(["compare", "race", "orchestra"])("counts a real two-worker %s run and keeps progress after restart", async mode => {
  const { project } = await client.tryProject({ dir: path.join(tmpDir("onboarding-fleet"), "demo") });
  const { run } = mode === "compare"
    ? await client.compare(project.id, { prompt: "add dark mode", entrants: ["demo-1", "demo-2"] })
    : await client.startOrchestra(project.id, { goal: "add dark mode and write tests", orchestrator: "demo-1", workers: ["demo-2", "demo-3"], ...(mode === "race" ? { race: true } : { plan: true }) });
  await waitUntil(async () => ["completed", "failed", "aborted"].includes((await client.orchestraRun(project.id, run.id)).run.status));
  expect((await client.orchestraRun(project.id, run.id)).run.status).toBe("completed");
  expect((await step("fleet")).done).toBe(true);
  await daemon.close(); await start();
  expect((await step("fleet")).done).toBe(true);
});

it("doesn't count a merely planned fleet, one worker, or corrupt run records", async () => {
  const dir = makeProjectDir(); registerProject(dir, "planned");
  const runs = path.join(dir, ".loom", "orchestra"); fs.mkdirSync(runs);
  fs.writeFileSync(path.join(runs, "torn.json"), "{");
  for (const run of [
    { workers: ["a", "b"], tasks: [] },
    { workers: ["a"], tasks: [{ agent: "a", startedAt: 1 }] },
    { workers: ["a", "b"], tasks: [{ agent: "a", startedAt: 1 }, { agent: "a", startedAt: 2 }] },
  ]) {
    fs.writeFileSync(path.join(runs, "run.json"), JSON.stringify(run));
    expect((await step("fleet")).done).toBe(false);
  }
});

it("counts devices but not owner sessions or guests, and derives share links separately", async () => {
  const { project } = await client.addProject(makeProjectDir());
  await pair({ owner: true });
  expect((await step("phone")).done).toBe(false);
  const shared = createShare({ projectId: project.id, chat: "main", title: "hello" });
  expect((await step("share")).done).toBe(true);
  revokeShare(shared.share.id);
  expect((await step("share")).done).toBe(false);
  await pair({ guest: { project: project.id, chat: "main", role: "view" } });
  expect((await step("phone")).done).toBe(false);
  expect((await step("share")).done).toBe(true);
  await pair({});
  expect((await step("phone")).done).toBe(true);
});

it("requires all bundled skills current in one agent directory, then notices removal", async () => {
  installAgentSkills({ agents: ["codex"] });
  expect((await step("skills")).done).toBe(true);
  fs.writeFileSync(path.join(home, ".agents", "skills", "loom", AGENT_SKILLS_VERSION), JSON.stringify({ revision: "old", committedAt: "2020-01-01T00:00:00Z" }));
  expect((await step("skills")).done).toBe(false);
  installAgentSkills({ agents: ["codex"] });
  expect((await step("skills")).done).toBe(true);
  uninstallAgentSkills({ agents: ["codex"] });
  expect((await step("skills")).done).toBe(false);
});

it("persists dismissal and restoration independently of progress and subsequent pairing writes", async () => {
  expect(await client.dismissOnboarding(true)).toEqual({ dismissed: true });
  await pair({});
  await daemon.close(); await start();
  expect((await client.onboarding()).dismissed).toBe(true);
  expect((await step("phone")).done).toBe(true);
  await client.dismissOnboarding(false);
  await daemon.close(); await start();
  expect((await client.onboarding()).dismissed).toBe(false);
  expect((await step("phone")).done).toBe(true);
});

it("derives sharing from a successfully minted team invite and reloads its metadata", async () => {
  const hub = await startHubServer({ port: 0, secret: "test-secret" });
  const statePath = path.join(process.env.LOOM_HOME!, "team.json");
  const host = { projects: () => [], runtimes: () => [], statePath };
  const team = new TeamLink(host);
  try {
    await team.signIn(hub.url, { github: "onboarding", secret: "test-secret" });
    const created = await team.createTeam("onboarding");
    expect(team.hasInvites()).toBe(false);
    await team.invite(created.id);
    expect(team.hasInvites()).toBe(true);
    const reloaded = new TeamLink(host);
    expect(reloaded.hasInvites()).toBe(true);
    await reloaded.stop();
    await daemon.close(); await start();
    expect((await step("share")).done).toBe(true);
  } finally { await team.stop(); await hub.close(); }
});
