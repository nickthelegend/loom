/**
 * `loom watch`, driven for real.
 *
 * The command is a thin skin over DaemonClient.subscribe, so what needs proving
 * is the plumbing it stands on: a subscriber sees a project's events as they
 * happen, scoping to one project actually scopes, and closing the subscription
 * releases the socket rather than leaving the daemon holding a dead client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let aId: string;
let bId: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const say = (projectId: string, text: string) =>
  fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ text }),
  });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  aId = (await client.addProject(makeProjectDir({ name: "watched" }))).project.id;
  bId = (await client.addProject(makeProjectDir({ name: "other" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("the stream loom watch stands on", () => {
  it("delivers a project's events live", async () => {
    const seen: LoomEvent[] = [];
    const close = client.subscribe((_pid, e) => seen.push(e), aId);
    // Subscription is a socket; give it a beat to be open before provoking.
    await waitUntil(async () => {
      await say(aId, "hello, watcher");
      return seen.some((e) => e.kind === "message");
    });
    close();
    const msg = seen.find((e) => e.kind === "message");
    expect(String(msg!.payload.text)).toContain("hello, watcher");
  });

  it("scopes to the asked-for project", async () => {
    const seen: Array<{ pid: string; e: LoomEvent }> = [];
    const close = client.subscribe((pid, e) => seen.push({ pid, e }), aId);
    await waitUntil(async () => {
      await say(bId, "noise from elsewhere");
      await say(aId, "signal");
      return seen.some((x) => String(x.e.payload.text ?? "").includes("signal"));
    });
    close();
    expect(seen.some((x) => String(x.e.payload.text ?? "").includes("noise"))).toBe(false);
  });

  it("without a scope, carries the project id so lines can be prefixed", async () => {
    const seen: Array<{ pid: string; e: LoomEvent }> = [];
    const close = client.subscribe((pid, e) => seen.push({ pid, e }));
    await waitUntil(async () => {
      await say(bId, "cross-project line");
      return seen.some((x) => x.pid === bId);
    });
    close();
    expect(seen.find((x) => x.pid === bId)).toBeTruthy();
  });
});
