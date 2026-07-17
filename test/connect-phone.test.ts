/**
 * The "connect a phone" backend: the network options a phone can use to reach
 * the daemon, the QR + deep link a pairing mints, opening phone access with a
 * second listener (localhost untouched), the loopback admin bootstrap, and
 * client-side errors reported up into the Console.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { LoomDaemon, lanIp } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let adminToken: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-phone");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  adminToken = readDaemonConfig()!.adminToken;
});

afterAll(async () => {
  await daemon.close();
});

const admin = () => ({ authorization: `Bearer ${adminToken}` });
const get = (p: string) => fetch(`${baseUrl}${p}`, { headers: admin() });
const post = (p: string, body?: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { ...admin(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("connect a phone — network options", () => {
  it("reports the LAN and tailnet options with reachability", async () => {
    const j = (await (await get("/api/pair/networks")).json()) as {
      boundHost: string;
      exposed: string[];
      localnet: { ip: string | null; reachable: boolean };
      tailnet: { available: boolean; reachable: boolean; reason?: string };
    };
    expect(j.boundHost).toBe("127.0.0.1");
    expect(Array.isArray(j.exposed)).toBe(true);
    // A localhost-only daemon can't be reached by a phone yet — that's the cue
    // to offer "enable phone access".
    expect(j.localnet.reachable).toBe(false);
    // Tailnet is honest about not being set up (this box isn't on a tailnet in CI).
    if (!j.tailnet.available) expect(j.tailnet.reason).toBeTruthy();
  });

  it("is admin-only", async () => {
    expect((await fetch(`${baseUrl}/api/pair/networks`)).status).toBe(401);
  });
});

describe("connect a phone — QR mint", () => {
  it("returns a deep link and an SVG QR for a single-use token", async () => {
    const j = (await (await post("/api/pair/new", {})).json()) as {
      token: string;
      url: string;
      link: string;
      qrSvg: string;
      expiresAt: number;
    };
    expect(typeof j.token).toBe("string");
    expect(j.url).toContain("127.0.0.1");
    expect(j.link).toBe(`${j.url}/app#pair=${j.token}`);
    expect(j.qrSvg.startsWith("<svg")).toBe(true);
    expect(j.expiresAt).toBeGreaterThan(Date.now());
  });

  it("never points the link at an arbitrary host from the client", async () => {
    const j = (await (await post("/api/pair/new", { host: "8.8.8.8" })).json()) as { url: string };
    expect(j.url).toContain("127.0.0.1");
    expect(j.url).not.toContain("8.8.8.8");
  });
});

describe("connect a phone — open access", () => {
  it("rejects a host that is not this machine's", async () => {
    expect((await post("/api/pair/expose", { host: "8.8.8.8" })).status).toBe(400);
  });

  it("adds a second listener on the LAN IP while localhost keeps serving", async () => {
    const lan = lanIp();
    if (!lan) return; // no routable LAN address on this box — nothing to bind
    const res = await post("/api/pair/expose", { host: lan });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { exposed: string[] }).exposed).toContain(lan);

    // Localhost is untouched, and the new address answers on the same port.
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    const port = new URL(baseUrl).port;
    expect((await fetch(`http://${lan}:${port}/api/health`)).status).toBe(200);

    // …and the modal would now see it as reachable.
    const nets = (await (await get("/api/pair/networks")).json()) as {
      localnet: { reachable: boolean };
    };
    expect(nets.localnet.reachable).toBe(true);
  });

  it("is idempotent — exposing the same IP twice keeps one listener", async () => {
    const lan = lanIp();
    if (!lan) return;
    await post("/api/pair/expose", { host: lan });
    expect(daemon.exposedIps().filter((ip) => ip === lan).length).toBe(1);
  });
});

describe("local admin bootstrap", () => {
  it("hands the admin token to a same-machine (loopback) caller", async () => {
    const j = (await (await fetch(`${baseUrl}/api/bootstrap`)).json()) as {
      token: string;
      admin: boolean;
    };
    expect(j.admin).toBe(true);
    expect(j.token).toBe(adminToken);
  });
});

describe("client errors reach the Console", () => {
  it("records a posted client error into the logbook", async () => {
    expect(
      (await post("/api/logs", { level: "error", scope: "window", message: "boom in the browser" })).status,
    ).toBe(200);
    const { logs } = (await (await get("/api/logs?level=error")).json()) as {
      logs: Array<{ scope: string; message: string }>;
    };
    expect(logs.some((r) => r.scope === "window" && r.message === "boom in the browser")).toBe(true);
  });

  it("requires a message", async () => {
    expect((await post("/api/logs", { level: "error" })).status).toBe(400);
  });
});
