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
import { ProjectRuntime } from "../src/daemon/runtime.js";
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

/**
 * The daily series (#16, #17): one walk answers both "what did this project
 * cost last week" and "which agent is eating the tokens".
 */
describe("the daily series", () => {
  it("buckets spend and tokens by day and by agent, from real turns", async () => {
    const dir = makeProjectDir({ name: "series" });
    const rt = await ProjectRuntime.open({ id: "series", name: "series", dir });
    try {
      await rt.sendMessage("one", "plannerbot");
      await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length >= 1);
      await rt.handoff("execbot");
      await rt.sendMessage("two", "execbot");
      await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length >= 2);

      const series = rt.costSeries(7);
      expect(series.length).toBe(1); // both turns landed today
      const today = series[0]!;
      expect(today.turns).toBe(2);
      expect(today.usd).toBeCloseTo(0.002, 6); // echo charges 0.001/turn
      expect(today.tokensIn).toBeGreaterThan(0);
      // The per-agent split is the #17 answer: who is eating the tokens.
      expect(Object.keys(today.byAgent).sort()).toEqual(["execbot", "plannerbot"]);
      expect(today.byAgent.plannerbot!.usd).toBeCloseTo(0.001, 6);
      expect(today.byAgent.execbot!.turns).toBe(1);
    } finally {
      await rt.close();
    }
  });

  it("keeps old days out of a short window", async () => {
    const dir = makeProjectDir({ name: "series-window" });
    const rt = await ProjectRuntime.open({ id: "serwin", name: "serwin", dir });
    try {
      // A turn eight days ago, planted at the ledger's own source of truth.
      rt.log.append({
        kind: "status",
        agentId: "plannerbot",
        payload: { state: "turn_cost", costUsd: 5 },
        ts: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
      expect(rt.costSeries(7)).toHaveLength(0);
      const wide = rt.costSeries(30);
      expect(wide).toHaveLength(1);
      expect(wide[0]!.usd).toBe(5);
    } finally {
      await rt.close();
    }
  });
});
