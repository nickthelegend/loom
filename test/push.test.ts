/**
 * Push notifications end-to-end against a mock Expo push server:
 * device registers → agent asks a question → phone gets one push;
 * route hops stay silent → exactly one push at route completion.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

interface Delivered {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let mock: http.Server;
let delivered: Delivered[] = [];
let clientToken: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  delete process.env.LOOM_NO_PUSH;

  // Mock Expo push endpoint.
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        delivered.push(...(JSON.parse(body) as Delivered[]));
      } catch {
        // ignore
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const addr = mock.address() as { port: number };
  process.env.LOOM_EXPO_PUSH_URL = `http://127.0.0.1:${addr.port}/push`;

  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const listening = await daemon.listen();
  baseUrl = `http://${listening.host}:${listening.port}`;
  client = new DaemonClient(readDaemonConfig()!);

  projectId = (await client.addProject(makeProjectDir({ name: "buzz" }))).project.id;

  // Pair a device and register its push token.
  const { token } = await client.newPairingToken();
  const claim = (await (
    await fetch(`${baseUrl}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "pixel" }),
    })
  ).json()) as { clientToken: string };
  clientToken = claim.clientToken;
});

afterAll(async () => {
  await daemon.close();
  mock.close();
  delete process.env.LOOM_EXPO_PUSH_URL;
});

async function registerPush(pushToken: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/push/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token: pushToken, platform: "android" }),
  });
  return res.status;
}

describe("push notifications", () => {
  it("registration requires a paired device token (not admin)", async () => {
    const cfg = readDaemonConfig()!;
    const asAdmin = await fetch(`${baseUrl}/api/push/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "ExponentPushToken[x]" }),
    });
    expect(asAdmin.status).toBe(403);
    expect(await registerPush("ExponentPushToken[test-device]")).toBe(200);
    const { clients } = await client.pairedClients();
    expect(clients.find((c) => c.name === "pixel")?.push).toBe(true);
  });

  it("an agent question buzzes the phone with the question text", async () => {
    delivered = [];
    await client.send(projectId, "please ask: ship it tonight?");
    await waitUntil(() => delivered.some((d) => d.body.includes("ship it tonight")));
    const ask = delivered.find((d) => d.body.includes("ship it tonight"))!;
    expect(ask.to).toBe("ExponentPushToken[test-device]");
    expect(ask.title).toBe("Loom · buzz");
    expect(ask.data?.kind).toBe("needs_input");
    // The turn also completes → solo run_complete push arrives too.
    await waitUntil(() => delivered.some((d) => d.body.includes("finished its turn")));
  });

  it("route hops stay silent; the outcome pushes exactly once", async () => {
    delivered = [];
    await client.startRoute(projectId, "tiny task", ["plannerbot", "execbot"]);
    await waitUntil(() => delivered.some((d) => d.body.includes("route complete")));
    await new Promise((r) => setTimeout(r, 300)); // let stragglers land
    expect(delivered.filter((d) => d.body.includes("finished its turn"))).toHaveLength(0);
    expect(delivered.filter((d) => d.body.includes("route complete"))).toHaveLength(1);
  });

  it("test-push endpoint reaches every registered device; unregister silences it", async () => {
    delivered = [];
    const { sent } = await client.pushTest();
    expect(sent).toBe(1);
    await waitUntil(() => delivered.length === 1);
    expect(delivered[0]!.body).toContain("test notification");

    const res = await fetch(`${baseUrl}/api/push/register`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(res.status).toBe(200);
    delivered = [];
    await client.send(projectId, "hello again");
    await waitUntil(async () => {
      const { events } = await client.events(projectId, undefined, 30);
      return events.filter((e) => e.kind === "run_complete").length >= 1;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(delivered).toHaveLength(0);
  });
});
