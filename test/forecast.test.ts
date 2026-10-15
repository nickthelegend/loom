/**
 * Pre-flight forecast: what a turn on an agent usually costs and takes, read
 * from its own recent turns — and the budget warning when one more could cross it.
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FORECAST_WINDOW, Recent, forecastFrom } from "../src/core/forecast.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

describe("the forecast", () => {
  it("is the median and the 80th percentile, so one marathon turn doesn't move it", () => {
    const f = forecastFrom([0.1, 0.12, 0.11, 0.1, 2.5], [60_000, 70_000, 65_000, 62_000, 900_000]);
    expect(f).toEqual({ turns: 5, ms: { typical: 65_000, high: 236_000 }, usd: { typical: 0.11, high: 0.596 } });
  });

  it("needs a few turns, and an agent that reports no spend gets time only", () => {
    expect(forecastFrom([0.1, 0.1], [1000, 1000])).toBeNull();
    expect(forecastFrom([], [1000, 2000, 3000])).toEqual({ turns: 3, ms: { typical: 2000, high: 2600 } });
  });

  it("warns when one more long turn could cross the day's budget", () => {
    const costs = [0.5, 0.5, 0.5, 1];
    expect(forecastFrom(costs, [1, 1, 1, 1], { capUsd: 5, spentUsd: 4.5 })!.budget).toEqual({ capUsd: 5, spentUsd: 4.5, mayCross: true });
    expect(forecastFrom(costs, [1, 1, 1, 1], { capUsd: 5, spentUsd: 1 })!.budget).toEqual({ capUsd: 5, spentUsd: 1, mayCross: false });
  });

  it("remembers only the latest turns", () => {
    const r = new Recent();
    for (let i = 0; i < FORECAST_WINDOW + 10; i++) r.push(i);
    expect(r.values()).toHaveLength(FORECAST_WINDOW);
    expect(r.values()[0]).toBe(10);
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-forecast");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("in a project", () => {
  it("each agent's status carries its forecast once it has turns behind it — and again after a restart", async () => {
    const dir = tmpDir("forecast");
    writeProjectConfig(dir, { name: "fc", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } });
    const info = { id: `fc-${path.basename(dir)}`, name: "fc", dir };
    rt = await ProjectRuntime.open(info);
    const forecast = async () => (await rt!.status()).agents.find((a) => a.id === "echo")?.forecast as Record<string, any> | undefined;
    for (let i = 1; i <= 2; i++) {
      await rt.sendMessage(`turn ${i}`);
      await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === i);
    }
    expect(await forecast()).toBeUndefined();
    await rt.sendMessage("turn 3 is a little longer than the others");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 3);
    const f = await forecast();
    expect(f).toMatchObject({ turns: 3, ms: { typical: expect.any(Number) }, usd: { typical: expect.any(Number), high: expect.any(Number) } });
    expect(f!.usd.typical).toBeGreaterThan(0);
    // read back from the log when the project opens again
    await rt.close();
    rt = await ProjectRuntime.open(info);
    expect(await forecast()).toEqual(f);
  });
});
