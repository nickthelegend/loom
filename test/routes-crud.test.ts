/**
 * Named-route CRUD (#11): a team's pipeline becomes a saved, validated thing
 * instead of one person's shell history.
 *
 * The rule that matters: a route is validated against the CURRENT roster at
 * save. A route that names an agent the project doesn't have would sit in the
 * file looking runnable and die at its first step — refusing it at write is
 * the difference between a template library and a folder of landmines.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let projectId: string;
let projectDir: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "routes" });
  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("saving a route", () => {
  it("persists a valid pipeline to config", async () => {
    const { routes } = await client.saveRoute(projectId, "review-loop", [
      "plannerbot",
      "execbot",
    ]);
    expect(routes["review-loop"]).toEqual(["plannerbot", "execbot"]);
    // In the file, so it's version-controllable and travels with the repo.
    expect(readProjectConfig(projectDir)!.routes!["review-loop"]).toEqual([
      "plannerbot",
      "execbot",
    ]);
  });

  it("accepts roles as steps, same as loom route does", async () => {
    const { routes } = await client.saveRoute(projectId, "by-role", ["planner", "executor"]);
    expect(routes["by-role"]).toEqual(["planner", "executor"]);
  });

  it("refuses a route naming an agent the project doesn't have", async () => {
    await expect(client.saveRoute(projectId, "broken", ["ghostbot"])).rejects.toThrow();
    expect(readProjectConfig(projectDir)!.routes!["broken"]).toBeUndefined();
  });

  it("replaces an existing route wholesale", async () => {
    await client.saveRoute(projectId, "review-loop", ["execbot"]);
    expect(readProjectConfig(projectDir)!.routes!["review-loop"]).toEqual(["execbot"]);
  });
});

describe("removing a route", () => {
  it("removes what exists and says so about what doesn't", async () => {
    const { routes } = await client.deleteRoute(projectId, "by-role");
    expect(routes["by-role"]).toBeUndefined();
    await expect(client.deleteRoute(projectId, "by-role")).rejects.toThrow(/no route named/);
  });
});
