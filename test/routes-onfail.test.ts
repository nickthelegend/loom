/**
 * Conditional routes (#10): "review fails → back to execute", as data.
 *
 * The rules under test: onFail must point BACKWARD (a forward jump on failure
 * would skip work); the loop is budgeted (a pipeline that never converges
 * should fail saying so, not orbit); and a step without onFail keeps the old
 * behaviour — error sinks the route.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSteps } from "../src/core/routes.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectConfig, RouteState } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const cfg: ProjectConfig = {
  name: "x",
  agents: [
    { id: "plannerbot", kind: "echo", role: "planner" },
    { id: "execbot", kind: "echo", role: "executor" },
  ],
};
const anyAdapter = () => true;

describe("resolving onFail", () => {
  it("resolves a backward target by id or role", () => {
    const r = resolveSteps(
      ["plannerbot", { step: "execbot", onFail: "planner" }],
      cfg,
      anyAdapter,
    );
    expect(r.onFail).toEqual([null, "plannerbot"]);
  });

  it("refuses a forward or self jump", () => {
    expect(() =>
      resolveSteps([{ step: "plannerbot", onFail: "execbot" }, "execbot"], cfg, anyAdapter),
    ).toThrow(/EARLIER/);
    expect(() =>
      resolveSteps([{ step: "plannerbot", onFail: "plannerbot" }], cfg, anyAdapter),
    ).toThrow(/EARLIER/);
  });

  it("refuses a target that matches nobody", () => {
    expect(() =>
      resolveSteps(["plannerbot", { step: "execbot", onFail: "ghost" }], cfg, anyAdapter),
    ).toThrow(/matches no agent/);
  });
});

describe("looping over a real daemon", () => {
  let daemon: LoomDaemon;
  let client: DaemonClient;
  let baseUrl: string;
  let token: string;
  let projectId: string;

  const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const route = async (): Promise<RouteState | null> =>
    (await client.routeState(projectId)).route;

  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const { host, port } = await daemon.listen();
    baseUrl = `http://${host}:${port}`;
    token = readDaemonConfig()!.adminToken;
    client = new DaemonClient(readDaemonConfig()!);
    projectId = (await client.addProject(makeProjectDir({ name: "onfail" }))).project.id;
  });

  afterAll(async () => {
    await daemon.close();
  });

  it("a failing step with onFail loops back, and the budget ends it honestly", async () => {
    // The echo route instruction contains the task text, and the task carries
    // fail: — so execbot errors every time it runs. plannerbot succeeds (the
    // instruction is prefixed, so its fail: only matters for... it too would
    // fail. Use a task WITHOUT fail:, and a step instruction WITH it, so only
    // the exec step errors.
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/route`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({
        task: "build the thing",
        spec: [
          "plannerbot",
          { step: "execbot", instruction: "fail:refused to build", onFail: "plannerbot" },
        ],
      }),
    });
    expect(r.status).toBe(200);

    // It loops (loops climbs), then fails naming the loop — not silently, and
    // not forever.
    await waitUntil(async () => (await route())?.status === "failed", { timeoutMs: 30_000 });
    const done = await route();
    expect(done!.reason).toContain("loops back");
    expect(done!.loops).toBe(done!.maxLoops ?? 3);
  });
});
