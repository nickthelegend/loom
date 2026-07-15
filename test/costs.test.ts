/**
 * Cost telemetry: per-turn costs accumulate per agent, routes attribute
 * their spend, and totals survive a runtime reopen (rehydration from log).
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let projectId: string;
let projectDir: string;

// Echo agents report a deterministic $0.001 per turn.
const TURN = 0.001;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "ledger" });
  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => {
  await daemon.close();
});

async function turnsDone(n: number): Promise<void> {
  await waitUntil(async () => (await client.costs(projectId)).costs.turns >= n);
}

describe("cost telemetry", () => {
  it("accumulates per-agent turns and spend", async () => {
    await client.send(projectId, "one");
    await turnsDone(1);
    await client.send(projectId, "two");
    await turnsDone(2);

    const { costs } = await client.costs(projectId);
    expect(costs.turns).toBe(2);
    expect(costs.totalUsd).toBeCloseTo(2 * TURN, 6);
    const planner = costs.byAgent.find((a) => a.agentId === "plannerbot")!;
    expect(planner.turns).toBe(2);
    expect(planner.usd).toBeCloseTo(2 * TURN, 6);

    const { project } = await client.project(projectId);
    expect(project.costUsd).toBeCloseTo(2 * TURN, 6);
  });

  it("splits by agent after a handoff", async () => {
    await client.handoff(projectId, "execbot");
    await client.send(projectId, "three");
    await turnsDone(3);
    const { costs } = await client.costs(projectId);
    expect(costs.byAgent.find((a) => a.agentId === "execbot")!.turns).toBe(1);
    expect(costs.totalUsd).toBeCloseTo(3 * TURN, 6);
  });

  it("routes attribute exactly their own spend", async () => {
    await client.startRoute(projectId, "small task", ["plannerbot", "execbot"]);
    await waitUntil(async () => {
      const { events } = await client.events(projectId, undefined, 300);
      return events.some((e) => e.kind === "route_completed");
    });
    const { events } = await client.events(projectId, undefined, 300);
    const done = events.find((e) => e.kind === "route_completed")!;
    expect(Number(done.payload.costUsd)).toBeCloseTo(2 * TURN, 6);
    const { route } = await client.routeState(projectId);
    expect(route?.costUsd).toBeCloseTo(2 * TURN, 6);
    // Project total = 3 chat turns + 2 route turns.
    const { costs } = await client.costs(projectId);
    expect(costs.totalUsd).toBeCloseTo(5 * TURN, 6);
  });

  it("totals survive a runtime reopen (rehydrated from the log)", async () => {
    const before = (await client.costs(projectId)).costs;
    // Touch the config to force the daemon to reopen the runtime.
    const cfgFile = path.join(projectDir, ".loom", "config.json");
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(cfgFile, future, future);
    await client.project(projectId); // triggers hot-reload
    const after = (await client.costs(projectId)).costs;
    expect(after.totalUsd).toBeCloseTo(before.totalUsd, 6);
    expect(after.turns).toBe(before.turns);
    expect(after.byAgent.length).toBe(before.byAgent.length);
  });
});
