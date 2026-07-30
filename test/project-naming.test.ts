/**
 * A project always has a name, whatever the config on disk says.
 *
 * Found by running the built CLI against a hand-written `.loom/config.json` —
 * the shape the docs steer people towards, because editing that file is how you
 * set up agents. Leaving the optional-looking `name` out of it meant:
 *
 *   - the defaulting branch in POST /api/projects never ran (a config existed),
 *   - so `--name` was silently ignored,
 *   - and `registerProject` stored `name: null`.
 *
 * That null is unfixable from the UI (there is no row to click) and leaks into
 * everything that prints a project — including `snapshot()`, whose declared
 * `project: string` simply vanished from the JSON, because stringify drops
 * undefined. ProjectConfig types `name` as required, but the file is parsed
 * through an unchecked cast, so the type system was never going to catch it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readDaemonConfig, readProjectConfig, listProjects } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let token: string;
let baseUrl: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** A project directory whose config deliberately omits `name`. */
function unnamedProjectDir(dirName: string): string {
  const dir = path.join(tmpDir("unnamed"), dirName);
  fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".loom", "config.json"),
    JSON.stringify({ agents: [{ id: "plannerbot", kind: "echo", role: "planner" }] }, null, 2),
  );
  return dir;
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
});

afterAll(async () => {
  await daemon.close();
});

describe("a config with no name", () => {
  it("falls back to the directory instead of registering null", async () => {
    const dir = unnamedProjectDir("fallback-here");
    const { project } = await client.addProject(dir);

    const row = listProjects().find((p) => p.id === project.id)!;
    expect(row.name).toBe("fallback-here");
    // The specific shape of the bug: a null that no surface can repair.
    expect(row.name).not.toBeNull();
  });

  it("honours --name rather than dropping it on the floor", async () => {
    const dir = unnamedProjectDir("ignored-flag");
    const { project } = await client.addProject(dir, "chosen-name");

    expect(listProjects().find((p) => p.id === project.id)!.name).toBe("chosen-name");
  });

  it("writes the name back so the file stops being a trap", async () => {
    // Persisting matters: otherwise every future read of this directory has to
    // re-derive the name, and the next code path that forgets to is a new bug.
    const dir = unnamedProjectDir("persist-me");
    await client.addProject(dir, "written-through");

    expect(readProjectConfig(dir)!.name).toBe("written-through");
  });

  it("gives snapshots the project field they promise", async () => {
    // snapshot() declares `project: string`. With an unnamed config it emitted
    // no such key at all, because JSON.stringify omits undefined — a type
    // lying about its own runtime.
    const dir = unnamedProjectDir("snap-named");
    const { project } = await client.addProject(dir);

    const r = await fetch(`${baseUrl}/api/projects/${project.id}/snapshot`, { headers: H() });
    const snap = (await r.json()) as Record<string, unknown>;
    expect(snap.project).toBe("snap-named");
    expect(typeof snap.project).toBe("string");
  });

  it("leaves a config that already has a name alone", async () => {
    // Re-adding a known project must not rename it; `loom rename` is the tool
    // for that, and it moves the label without moving the id.
    const dir = unnamedProjectDir("keeps-its-own");
    const cfg = readProjectConfig(dir)!;
    fs.writeFileSync(
      path.join(dir, ".loom", "config.json"),
      JSON.stringify({ ...cfg, name: "declared-identity" }, null, 2),
    );

    const { project } = await client.addProject(dir, "should-not-win");
    expect(listProjects().find((p) => p.id === project.id)!.name).toBe("declared-identity");
    expect(readProjectConfig(dir)!.name).toBe("declared-identity");
  });

  it("survives a whitespace-only name, which is the same nothing", async () => {
    const dir = unnamedProjectDir("blank-name");
    const cfg = readProjectConfig(dir)!;
    fs.writeFileSync(
      path.join(dir, ".loom", "config.json"),
      JSON.stringify({ ...cfg, name: "   " }, null, 2),
    );

    const { project } = await client.addProject(dir);
    expect(listProjects().find((p) => p.id === project.id)!.name).toBe("blank-name");
  });
});
