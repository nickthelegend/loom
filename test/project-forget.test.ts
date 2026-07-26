/**
 * Forgetting a project.
 *
 * `unregisterProject` sat in core/registry.ts with no caller for the whole life
 * of the project: you could point Loom at a directory over the API and had no
 * supported way to un-point it, short of editing ~/.loom/registry.json by hand
 * and restarting the daemon. These tests exist so the route can't quietly lose
 * its wiring again.
 *
 * The load-bearing assertion is the last one. "Forget" must not mean "delete":
 * the project's .loom/ holds its event log and its memory, and a tool that
 * throws those away because someone tidied a list is a tool you cannot trust
 * with the history it is selling you.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
}, 30_000);

afterAll(async () => {
  await daemon.close();
});

describe("forgetting a project", () => {
  it("takes it off the board", async () => {
    const dir = makeProjectDir({ name: "throwaway" });
    const id = (await client.addProject(dir)).project.id;
    expect((await client.listProjects()).projects.map((p) => p.id)).toContain(id);

    const r = await client.forgetProject(id);
    expect(r.removed).toBe(true);
    expect((await client.listProjects()).projects.map((p) => p.id)).not.toContain(id);
  });

  it("refuses an id it doesn't know, rather than reporting a cheerful success", async () => {
    await expect(client.forgetProject("nope-not-a-project")).rejects.toThrow();
  });

  it("leaves .loom/ on disk, so re-adding the directory restores its history", async () => {
    const dir = makeProjectDir({ name: "remembered" });
    const loom = path.join(dir, ".loom");
    // Something only this project could know, written where its history lives.
    fs.writeFileSync(path.join(loom, "log.db"), "pretend-event-log");

    const first = (await client.addProject(dir)).project.id;
    await client.forgetProject(first);

    expect(fs.existsSync(loom)).toBe(true);
    expect(fs.readFileSync(path.join(loom, "log.db"), "utf8")).toBe("pretend-event-log");

    // And adding the same directory back finds that history rather than a blank one.
    const again = (await client.addProject(dir)).project.id;
    expect((await client.listProjects()).projects.map((p) => p.id)).toContain(again);
    expect(fs.readFileSync(path.join(loom, "log.db"), "utf8")).toBe("pretend-event-log");
  });
});
