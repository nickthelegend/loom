import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { ensureDaemonConfig, readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";
import { AGENT_SKILLS_MARKER, AGENT_SKILLS_SIGNATURE, AGENT_SKILLS_VERSION, agentSkillsStatus } from "../src/core/agent-skills.js";
import { makeProjectDir, tmpDir } from "./helpers.js";
import { logbook } from "../src/core/logbook.js";

let daemon: LoomDaemon | undefined, base: string, token: string, home: string;
const headers = (auth = token) => ({ authorization: `Bearer ${auth}`, "content-type": "application/json" });
const call = (route = "", method = "GET", body?: unknown, auth = token) => fetch(`${base}/api/agent-skills${route}`, {
  method, headers: headers(auth), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function start() {
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen();
  base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken;
}
async function pair(body: object = {}) {
  const minted = await fetch(`${base}/api/pair/new`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  expect(minted.status).toBe(200);
  const { token: pairing } = await minted.json() as { token: string };
  const claimed = await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairing, name: "skills-test" }) });
  expect(claimed.status).toBe(200);
  return (await claimed.json() as { clientToken: string }).clientToken;
}
beforeEach(() => {
  home = tmpDir("agent-skills-api-home");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("LOOM_HOME", tmpDir("agent-skills-daemon"));
  vi.stubEnv("LOOM_NO_NOTIFY", "1");
  // HOME is fake here, so the startup refresh the suite normally turns off is safe to run
  vi.stubEnv("LOOM_NO_AGENT_SKILLS_UPDATE", "");
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  vi.unstubAllEnvs();
});

describe("agent skills API", () => {
  it("reports versions per agent, installs/updates and removes shared destinations only once", async () => {
    await start();
    const initial = await (await call()).json();
    expect(initial.autoUpdate).toBe(true);
    expect(initial.agents).toHaveLength(4);
    const installed = await (await call("/install", "POST", { agents: ["codex", "opencode"] })).json();
    expect(installed.results).toHaveLength(7);
    expect(installed.results.every((r: { action: string }) => r.action === "installed")).toBe(true);
    const skillsDir = path.join(home, ".agents", "skills");
    fs.writeFileSync(path.join(skillsDir, "loom", AGENT_SKILLS_VERSION), JSON.stringify({ revision: "old", committedAt: "2020-01-01T00:00:00Z" }));
    const updated = await (await call("/install", "POST", { agents: ["codex"] })).json();
    expect(updated.results.find((r: { id: string }) => r.id === "loom").action).toBe("updated");
    const status = await (await call()).json();
    expect(status.agents[1].skills.every((s: { current: boolean }) => s.current)).toBe(true);
    expect(status.agents[3].skills).toEqual(status.agents[1].skills);
    const removed = await call("/uninstall", "POST", { agents: ["codex", "opencode"] });
    expect(removed.status).toBe(200);
    expect(fs.readdirSync(skillsDir)).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([".agents"]);
  });

  it("reports conflicts without replacing unmanaged content", async () => {
    const dest = path.join(home, ".grok", "skills", "loom");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), "mine");
    await start();
    for (const action of ["install", "uninstall"]) {
      const response = await call(`/${action}`, "POST", { agents: ["grok"] });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.results.find((r: { id: string }) => r.id === "loom")).toMatchObject({ action: "conflict" });
      expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("mine");
    }
  });

  it("validates the whole selection before writing", async () => {
    await start();
    for (const action of ["install", "uninstall"]) {
      for (const body of [{}, { agents: [] }, { agents: "all" }, { agents: ["codex", "bad"] }, { agents: ["all"] }, { agents: ["codex"], targets: [home] }]) {
        expect((await call(`/${action}`, "POST", body)).status).toBe(400);
      }
    }
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("requires auth, restricts machine status, and reserves mutation for owners/admins", async () => {
    await start();
    const client = new DaemonClient(readDaemonConfig()!);
    const { project } = await client.addProject(makeProjectDir({ agents: [{ id: "echo", kind: "echo" }] }));
    const scoped = await pair({ projects: [project.id] });
    const device = await pair();
    const guest = await pair({ guest: { project: project.id, chat: "main", role: "view" } });
    const owner = await pair({ owner: true });
    for (const [route, method, body] of [["", "GET", undefined], ["/install", "POST", { agents: ["codex"] }], ["/uninstall", "POST", { agents: ["codex"] }]] as const) {
      expect((await call(route, method, body, "bad-token")).status).toBe(401);
      expect((await call(route, method, body, scoped)).status).toBe(403);
      expect((await call(route, method, body, guest)).status).toBe(403);
      expect((await call(route, method, body, device)).status).toBe(method === "GET" ? 200 : 403);
      expect(fs.existsSync(path.join(home, ".agents", "skills"))).toBe(false);
    }
    expect((await call("/install", "POST", { agents: ["codex"] }, owner)).status).toBe(200);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "loom", "SKILL.md"))).toBe(true);
    expect((await call("/uninstall", "POST", { agents: ["codex"] }, owner)).status).toBe(200);
  });
});

describe("daemon startup updates", () => {
  function oldCopy() {
    const dir = path.join(home, ".agents", "skills", "loom");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "old instructions");
    fs.writeFileSync(path.join(dir, AGENT_SKILLS_MARKER), AGENT_SKILLS_SIGNATURE + "\n");
    fs.writeFileSync(path.join(dir, AGENT_SKILLS_VERSION), JSON.stringify({ revision: "old", committedAt: "2020-01-01T00:00:00Z" }));
    return dir;
  }
  it("updates a managed old version on boot without installing missing skills", async () => {
    const dir = oldCopy();
    const before = logbook.list({ limit: 1000 }).filter(r => r.message.startsWith("agent skills:")).length;
    await start();
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).not.toBe("old instructions");
    expect(agentSkillsStatus().agents[1]!.skills.find(s => s.id === "loom")!.current).toBe(true);
    expect(fs.readdirSync(path.dirname(dir))).toEqual(["loom"]);
    expect(fs.readdirSync(home)).toEqual([".agents"]);
    const logs = logbook.list({ limit: 1000 }).filter(r => r.message.startsWith("agent skills:"));
    expect(logs).toHaveLength(before + 1);
    expect(logs.some(r => r.message === "agent skills: updated 1 managed skills")).toBe(true);
  });
  it("honors agentSkills.autoUpdate=false across startup and leaves manual install available", async () => {
    const dir = oldCopy();
    const cfg = ensureDaemonConfig({ host: "127.0.0.1", port: 0 });
    cfg.agentSkills = { autoUpdate: false };
    writeDaemonConfig(cfg);
    await start();
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe("old instructions");
    expect((await (await call()).json()).autoUpdate).toBe(false);
    expect(readDaemonConfig()!.agentSkills?.autoUpdate).toBe(false);
    expect((await call("/install", "POST", { agents: ["codex"] })).status).toBe(200);
    expect(agentSkillsStatus().agents[1]!.skills.every(s => s.current)).toBe(true);
  });
});
