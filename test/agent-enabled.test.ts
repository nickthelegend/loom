/**
 * Switching an agent off, over a real daemon.
 *
 * "Off" is the interesting word. A roster entry that still answers is the kind
 * of off that costs money, so these check the agent is genuinely stopped and
 * dropped — not merely hidden from a list — and that it comes back the same way
 * a fresh one would.
 *
 * The refusals matter as much as the happy path: an agent holding the baton or
 * mid-turn must not be switchable off, for the same reason it can't be removed.
 * Doing it there strands the lock on something that no longer exists.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectStatus } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const setEnabled = (agentId: string, enabled: boolean) =>
  fetch(`${baseUrl}/api/projects/${projectId}/agents/${agentId}/enabled`, {
    method: "PUT",
    headers: H(),
    body: JSON.stringify({ enabled }),
  });

const status = async (): Promise<ProjectStatus> => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: H() });
  return ((await r.json()) as { project: ProjectStatus }).project;
};

const agent = async (id: string) => (await status()).agents.find((a) => a.id === id);

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "roster" }); // plannerbot + execbot (echo)
  const res = await client.addProject(projectDir);
  projectId = res.project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("switching an agent off", () => {
  it("reports every agent enabled until told otherwise", async () => {
    // Absent in config means on — an existing project must not wake up with
    // half its roster silently switched off.
    for (const a of (await status()).agents) expect(a.enabled).toBe(true);
  });

  it("stops the agent and writes it to config, so it survives a restart", async () => {
    const r = await setEnabled("execbot", false);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: "execbot", enabled: false });

    const off = await agent("execbot");
    expect(off?.enabled).toBe(false);
    expect(off?.available).toBe(false);
    expect(off?.busy).toBe(false);

    // .loom/config.json is the source of truth, not in-memory state.
    const cfg = readProjectConfig(projectDir)!;
    expect(cfg.agents.find((a) => a.id === "execbot")?.enabled).toBe(false);
  });

  it("still reports what a disabled agent IS, not a guess", async () => {
    // Switching an agent off must not change its tier: the surfaces that filter
    // on that field would otherwise offer a disabled bridge as an adapter.
    expect((await agent("execbot"))?.tier).toBe("adapter");
    expect((await agent("execbot"))?.kind).toBe("echo");
  });

  it("refuses to send to it, rather than quietly doing nothing", async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ text: "are you there", agentId: "execbot" }),
    });
    expect(r.ok).toBe(false);
  });

  it("brings it back, ready to take a turn", async () => {
    const r = await setEnabled("execbot", true);
    expect(r.status).toBe(200);
    expect((await agent("execbot"))?.enabled).toBe(true);

    // and it really works again — not just a flag flipped back
    await client.send(projectId, "welcome back", "execbot");
    await waitUntil(async () => {
      const { events } = await client.events(projectId, 0, 200);
      return events.some((e) => e.kind === "run_complete" && e.agentId === "execbot");
    });
  });

  it("refuses while the agent holds the baton, and says how to fix it", async () => {
    await client.handoff(projectId, "execbot");
    const r = await setEnabled("execbot", false);
    expect(r.status).toBe(409);
    const { error } = (await r.json()) as { error: string };
    expect(error).toMatch(/holds the baton/);
    expect(error).toMatch(/hand it off/); // names the fix, not just the refusal
    expect((await agent("execbot"))?.enabled).toBe(true); // and nothing changed
  });
});
