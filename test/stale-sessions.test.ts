/**
 * Hung sessions: detected, then reaped.
 *
 * A session whose CLI hung stayed "busy" forever — alive enough to hold the
 * flag, dead enough to never finish — and every dispatch after it got "is
 * busy" until someone noticed and restarted the daemon. Detection is a clock
 * started at dispatch and stopped by any terminal event; the reap is
 * interrupt → stop → respawn from config, with the baton released if the
 * corpse held it, because a lock owned by a session that no longer exists
 * refuses everyone forever.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectStatus } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const status = async (): Promise<ProjectStatus> => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: H() });
  return ((await r.json()) as { project: ProjectStatus }).project;
};

const stale = async () => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}/stale`, { headers: H() });
  return ((await r.json()) as { stale: Array<{ agentId: string; busyMs: number }> }).stale;
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(makeProjectDir({ name: "stale" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("detection", () => {
  it("a healthy finished turn is never stale", async () => {
    await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ text: "quick one", agentId: "plannerbot" }),
    });
    await waitUntil(async () => !(await status()).agents.find((a) => a.id === "plannerbot")!.busy);
    expect(await stale()).toHaveLength(0);
  });

  it("a hung turn crosses the threshold and is reported", async () => {
    // A genuinely hung session: echo sleeps far beyond the test, holding busy.
    await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ text: "sleep:55000", agentId: "plannerbot" }),
    });
    await waitUntil(async () => (await status()).agents.find((a) => a.id === "plannerbot")!.busy);
    expect(await stale()).toHaveLength(0); // busy is not stale — yet

    // Ten real minutes would make the suite unrunnable; move the clock instead
    // of faking the hang. The hang is real, the age is simulated.
    const rt = daemon["runtimes"].get(projectId) as ProjectRuntime;
    const since = rt["busySince"] as Map<string, number>;
    since.set("plannerbot", Date.now() - ProjectRuntime.STALE_TURN_MS - 1000);

    const rows = await stale();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe("plannerbot");
    expect(rows[0]!.busyMs).toBeGreaterThanOrEqual(ProjectRuntime.STALE_TURN_MS);
  });
});

describe("the reap", () => {
  it("respawns the session and frees the baton", async () => {
    // The hung agent holds the baton from the sleep dispatch above.
    expect((await status()).holder).toBe("plannerbot");

    const r = await fetch(`${baseUrl}/api/projects/${projectId}/agents/plannerbot/reap`, {
      method: "POST",
      headers: H(),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { respawned: boolean }).respawned).toBe(true);

    // Fresh session: not busy, not stale, baton released.
    const p = await status();
    const a = p.agents.find((x) => x.id === "plannerbot")!;
    expect(a.busy).toBe(false);
    expect(a.available).toBe(true);
    expect(p.holder).toBeNull();
    expect(await stale()).toHaveLength(0);

    // And it takes a normal turn again — respawn means alive, not just quiet.
    const send = await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ text: "back to work", agentId: "plannerbot" }),
    });
    expect(send.status).toBe(200);
  });

  it("refuses to reap an agent that doesn't exist", async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/agents/ghost/reap`, {
      method: "POST",
      headers: H(),
    });
    expect(r.status).toBe(400);
  });
});
