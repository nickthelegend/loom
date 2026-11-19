import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig, writeProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { isAdapter, type ProjectConfig } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("config-reload-home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
});

afterAll(async () => { await daemon.close(); });

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function project() {
  const dir = makeProjectDir();
  const { project: info } = await client.addProject(dir);
  await client.project(info.id);
  // Keep the loaded runtime so assertions cannot trigger an HTTP-driven reload.
  const rt = (daemon as unknown as { runtimes: Map<string, ProjectRuntime> }).runtimes.get(info.id)!;
  const file = path.join(dir, ".loom", "config.json");
  const config = readProjectConfig(dir)!;
  const write = () => fs.writeFileSync(file, JSON.stringify(config));
  const reloads = () => rt.log.list({ limit: 500 }).filter(e => e.payload.state === "config_reloaded");
  const errors = () => rt.log.list({ limit: 500 }).filter(e => e.payload.state === "config_reload_failed");
  // fs.watchFile takes its baseline stat asynchronously; an edit made before that
  // becomes the baseline and is never reported (a busy CI runner hit exactly this)
  await pause(600);
  return { dir, id: info.id, rt, file, config, write, reloads, errors };
}


describe("project config watcher", () => {
  it("applies agents, roles, instructions, permissions and routes without another request", async () => {
    const p = await project();
    const shared = p.rt.config;
    const untouched = p.rt.agent("execbot");
    const replaced = p.rt.agent("plannerbot");
    Object.assign(p.config.agents[0]!, { role: "architect", instructions: "Prefer small changes.", permissions: "ask" });
    p.config.agents.push({ id: "reviewbot", kind: "echo", role: "reviewer" });
    p.config.permissions = { allow: ["docker compose up"] };
    p.config.routes = { inspect: ["architect", "reviewer"] };
    p.write();
    await waitUntil(() => p.reloads().length === 1);

    expect(p.rt.config).toBe(shared);
    expect(p.rt.agent("execbot")).toBe(untouched);
    expect(p.rt.agent("plannerbot")).not.toBe(replaced);
    expect(p.rt.agentRole("plannerbot")).toBe("architect");
    expect(p.rt.config.agents[0]!.options?.permissions).toBe("ask");
    expect(p.rt.autoPolicy().allow).toContain("docker compose up");
    expect(p.reloads()[0]!.payload).toMatchObject({ added: ["reviewbot"], updated: ["plannerbot"], fields: ["permissions", "routes"] });

    await p.rt.sendMessage("hello", "plannerbot");
    await waitUntil(() => p.rt.log.list({ kinds: ["message"] }).some(e => e.agentId === "plannerbot" && String(e.payload.text).includes("briefed:")));
    await waitUntil(() => !p.rt.anyBusy());
    await p.rt.startRoute({ task: "inspect this", spec: "inspect" });
    await waitUntil(() => p.rt.routeState()?.status === "completed");
    expect(p.rt.log.list({ kinds: ["run_complete"] }).some(e => e.agentId === "reviewbot")).toBe(true);
  });

  it("follows repeated atomic saves and removes optional settings and idle agents", async () => {
    const p = await project();
    p.config.agents[0]!.instructions = "Be concise.";
    p.config.routes = { ship: ["plannerbot"] };
    p.config.permissions = { allow: ["make check"] };
    writeProjectConfig(p.dir, p.config);
    await waitUntil(() => p.reloads().length === 1);
    p.rt.baton.acquire("plannerbot");
    p.config.agents = p.config.agents.filter(a => a.id !== "plannerbot");
    delete p.config.routes;
    delete p.config.permissions;
    writeProjectConfig(p.dir, p.config);
    await waitUntil(() => p.reloads().length === 2);
    expect(() => p.rt.agent("plannerbot")).toThrow("unknown agent");
    expect(p.rt.baton.holder()).toBeNull();
    expect(p.rt.config.routes).toBeUndefined();
    expect(p.rt.autoPolicy().allow).not.toContain("make check");
    await p.rt.sendMessage("still running");
    await waitUntil(() => p.rt.log.list({ kinds: ["run_complete"] }).some(e => e.agentId === "execbot"));
  });

  it.each(["update", "remove", "disable"] as const)("defers %s of a busy agent while applying an idle agent's edit", async action => {
    const p = await project();
    const running = p.rt.agent("plannerbot");
    await p.rt.sendMessage("sleep:1200 finish this turn", "plannerbot");
    await waitUntil(() => isAdapter(running) && running.busy());
    if (action === "update") p.config.agents[0]!.options = { permissions: "ask" };
    else if (action === "remove") p.config.agents.shift();
    else p.config.agents[0]!.enabled = false;
    p.config.agents.find(a => a.id === "execbot")!.role = "reviewer";
    p.write();
    await waitUntil(() => p.reloads().some(e => (e.payload.deferred as string[]).includes("plannerbot")));
    expect(p.rt.agent("plannerbot")).toBe(running);
    expect(p.rt.config.agents[0]!.enabled).not.toBe(false);
    expect(p.rt.agentRole("execbot")).toBe("reviewer");
    // Saving an unrelated setting must not overwrite the pending file edit.
    p.rt.setAgentRole("execbot", "tester");
    expect(readProjectConfig(p.dir)!.agents).toEqual(p.config.agents.map(a => a.id === "execbot" ? { ...a, role: "tester" } : a));
    await waitUntil(() => p.rt.log.list({ kinds: ["run_complete"] }).some(e => e.agentId === "plannerbot"));
    await waitUntil(() => p.reloads().some(e => (e.payload.deferred as string[]).length === 0 && [...e.payload.updated as string[], ...e.payload.removed as string[]].includes("plannerbot")));
    if (action === "update") {
      expect(p.rt.agent("plannerbot")).not.toBe(running);
      expect(p.rt.config.agents[0]!.options?.permissions).toBe("ask");
    } else {
      expect(() => p.rt.agent("plannerbot")).toThrow("unknown agent");
      expect(p.rt.baton.holder()).toBeNull();
    }
    expect(p.rt.log.list({ kinds: ["status"] }).some(e => e.agentId === "plannerbot" && e.payload.state === "interrupted")).toBe(false);
  });

  it.each(["interrupt", "error"])("applies the latest deferred edit after a turn ends by %s", async ending => {
    const p = await project();
    await p.rt.sendMessage(ending === "error" ? "sleep:900 fail:expected" : "sleep:5000", "plannerbot");
    p.config.agents[0]!.role = "first edit";
    p.write();
    await waitUntil(() => p.reloads().length === 1);
    p.config.agents[0]!.role = "latest edit";
    p.write();
    if (ending === "interrupt") await p.rt.interrupt();
    await waitUntil(() => p.rt.agentRole("plannerbot") === "latest edit");
    expect(p.rt.config.agents[0]!.role).toBe("latest edit");
  });

  it("applies a deferred edit before a queued follow-up captures its agent", async () => {
    const p = await project();
    await p.rt.sendMessage("sleep:900 first turn", "plannerbot");
    p.config.agents[0]!.instructions = "Use the new instructions.";
    p.write();
    await waitUntil(() => p.reloads().some(e => (e.payload.deferred as string[]).includes("plannerbot")));
    await p.rt.sendMessage("queued follow-up", "plannerbot");
    await waitUntil(() => p.rt.log.list({ kinds: ["run_complete"] }).length === 2);
    const reply = p.rt.log.list({ kinds: ["message"] }).find(e => e.agentId === "plannerbot" && String(e.payload.text).includes("queued follow-up"));
    expect(reply?.payload.text).toContain("briefed:");
    expect(p.rt.agentInstructions("plannerbot")).toContain("Use the new instructions.");
  });

  it("keeps the previous config on invalid edits and recovers on the next save", async () => {
    const p = await project();
    const before = structuredClone(p.rt.config);
    const live = p.rt.agent("plannerbot");
    for (const [index, raw] of [
      '{"agents": [',
      JSON.stringify({ ...p.config, agents: [...p.config.agents, p.config.agents[0]] }),
      JSON.stringify({ ...p.config, agents: [{ id: "bad", kind: "unknown", role: "tester" }] }),
    ].entries()) {
      fs.writeFileSync(p.file, raw);
      await waitUntil(() => p.errors().length === index + 1);
      expect(p.errors().at(-1)!.chat).toBe("main");
      expect(p.errors().at(-1)!.payload.message).toContain("keeping the previous config");
      expect(p.rt.config).toEqual(before);
      expect(p.rt.agent("plannerbot")).toBe(live);
      expect((await client.project(p.id)).project.agents).toHaveLength(2);
    }
    p.config.agents[0]!.role = "fixed";
    p.write();
    await waitUntil(() => p.rt.agentRole("plannerbot") === "fixed");
    expect(p.reloads()).toHaveLength(1);
  });

  it("debounces partial writes and ignores unchanged saves and its own writes", async () => {
    const p = await project();
    fs.writeFileSync(p.file, "{");
    await pause(40);
    p.config.agents[0]!.role = "final";
    p.write();
    await waitUntil(() => p.reloads().length === 1);
    expect(p.errors()).toHaveLength(0);
    const live = p.rt.agent("plannerbot");
    p.write();
    p.rt.setAgentRole("execbot", "tester");
    await pause(400);
    expect(p.rt.agent("plannerbot")).toBe(live);
    expect(p.reloads()).toHaveLength(1);
    expect(p.rt.agentRole("execbot")).toBe("tester");
  });

  it("enables a disabled agent and keeps watching after deletion and recreation", async () => {
    const p = await project();
    p.config.agents[0]!.enabled = false;
    p.write();
    await waitUntil(() => p.reloads().length === 1);
    expect(() => p.rt.agent("plannerbot")).toThrow();
    fs.unlinkSync(p.file);
    await waitUntil(() => p.errors().length === 1);
    p.config.agents[0]!.enabled = true;
    p.write();
    await waitUntil(() => p.reloads().length === 2);
    await p.rt.sendMessage("enabled again", "plannerbot");
    await waitUntil(() => p.rt.log.list({ kinds: ["run_complete"] }).length === 1);
  });

  it("closes the watcher and cancels a scheduled reload", async () => {
    const dir = makeProjectDir();
    const rt = await ProjectRuntime.open({ id: "closing", name: "closing", dir });
    const before = structuredClone(rt.config);
    const changed: ProjectConfig = { ...before, agents: [] };
    writeProjectConfig(dir, changed);
    await rt.close();
    writeProjectConfig(dir, { ...changed, name: "after close" });
    await pause(300);
    expect(rt.config).toEqual(before);
  });
});
