/**
 * Loom Cloud relay, end to end: a real daemon, an in-memory stand-in for
 * Supabase Realtime (same semantics: broadcast to everyone but the sender,
 * JSON round-trip), and a "phone" that only ever talks through the bus.
 *
 * What matters most is proven here, not assumed: the operator of the bus sees
 * only ciphertext; forged or replayed-with-another-key envelopes are ignored;
 * relayed requests get exactly the auth a LAN request would; the admin
 * bootstrap can't be reached through the relay; the event feed streams.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDaemonConfig } from "../src/core/registry.js";
import { RelayClient, parseCloudFragment } from "../src/core/relay-client.js";
import {
  encodeMessage,
  fromB64,
  newRelayCredentials,
  RelayDecoder,
  unpackCredentials,
  type RelayCredentials,
} from "../src/core/relay-protocol.js";
import { DaemonClient } from "../src/daemon/client.js";
import { MemoryRelayBus, readCloudSettings } from "../src/daemon/relay.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let admin: DaemonClient;
let baseUrl: string;
let adminToken: string;
let projectId: string;
const bus = new MemoryRelayBus();

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-relay");
  process.env.LOOM_NO_NOTIFY = "1";
  process.env.LOOM_SUPABASE_URL = "https://example.supabase.co";
  process.env.LOOM_SUPABASE_ANON_KEY = "anon-test-key";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, relayTransport: async () => bus.connect() });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  adminToken = cfg.adminToken;
  admin = new DaemonClient(cfg);
  projectId = (await admin.addProject(makeProjectDir({ name: "relayed" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
  delete process.env.LOOM_SUPABASE_URL;
  delete process.env.LOOM_SUPABASE_ANON_KEY;
});

const post = (p: string, body: unknown = {}) =>
  fetch(baseUrl + p, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

let creds: RelayCredentials;
let pairLink: string;

describe("wire format", () => {
  it("round-trips, splits large messages, and rejects the wrong key", () => {
    const c = newRelayCredentials();
    const key = fromB64(c.key);
    const big = { t: "res", id: "1", to: "x", status: 200, body: "y".repeat(300_000) } as const;
    const envs = encodeMessage(key, "d", big);
    expect(envs.length).toBeGreaterThan(1);
    const dec = new RelayDecoder(key, "d");
    let out = null;
    for (const e of envs.reverse()) out = dec.push(JSON.parse(JSON.stringify(e))) ?? out;
    expect(out).toEqual(big);

    const other = new RelayDecoder(fromB64(newRelayCredentials().key), "d");
    expect(other.push(encodeMessage(key, "d", { t: "ping", from: "a", ts: 1 })[0])).toBeNull();
    // a daemon ignores its own direction
    expect(new RelayDecoder(key, "c").push(encodeMessage(key, "d", { t: "ping", from: "a", ts: 1 })[0])).toBeNull();
    // garbage never throws
    expect(dec.push({ v: 1, d: "d", x: "!!!" })).toBeNull();
    expect(dec.push(null)).toBeNull();
  });
});

describe("Loom Cloud relay", () => {
  it("enables, and the pairing link carries the relay credentials in its fragment", async () => {
    const status = await post("/api/cloud/enable");
    expect(status).toMatchObject({ enabled: true, connected: true });
    const s = readCloudSettings();
    expect(s.channel && s.key).toBeTruthy();

    const pair = await post("/api/pair/new");
    pairLink = String(pair.link);
    const fragment = pairLink.split("#")[1]!;
    const cloud = parseCloudFragment(fragment)!;
    expect(cloud.supabaseUrl).toBe("https://example.supabase.co");
    expect(cloud.anonKey).toBe("anon-test-key");
    creds = unpackCredentials(cloud.relay)!;
    expect(creds).toEqual({ channel: s.channel, key: s.key });
  });

  it("a phone pairs, reads and writes entirely through the relay", async () => {
    const phone = new RelayClient(bus.connect(), creds);
    expect(await phone.ping()).not.toBeNull();
    expect(phone.daemon?.name).toBeTruthy();

    // claim the one-time token — over the relay, no direct HTTP at all
    const pairToken = new URLSearchParams(pairLink.split("#")[1]).get("pair")!;
    const claim = await phone.request("POST", "/api/pair/claim", { body: { token: pairToken, name: "test phone" } });
    expect(claim.status).toBe(200);
    const token = String((claim.body as { clientToken: string }).clientToken);
    const auth = `Bearer ${token}`;

    // unauthenticated requests get the same 401 they'd get on the LAN
    expect((await phone.request("GET", "/api/projects")).status).toBe(401);
    const projects = await phone.request("GET", "/api/projects", { auth });
    expect(projects.status).toBe(200);
    expect(JSON.stringify(projects.body)).toContain(projectId);

    // the live feed streams through the relay
    const frames: Array<{ type?: string; event?: { kind: string; payload: { text?: string } } }> = [];
    let opened = false;
    phone.openStream(auth, { onFrame: (f) => frames.push(f as (typeof frames)[0]), onState: (o) => (opened = o) }, projectId);
    await waitUntil(() => opened);
    const sent = await phone.request("POST", `/api/projects/${projectId}/messages`, {
      auth,
      body: { text: "hello from far away" },
    });
    expect(sent.status).toBe(200);
    await waitUntil(() =>
      frames.some((f) => f.type === "event" && f.event?.kind === "message" && String(f.event.payload.text).includes("echo(")),
    );
    phone.closeStream();
    await phone.close();
  });

  it("the relay operator sees only ciphertext", () => {
    const wire = JSON.stringify(bus.wire);
    expect(bus.wire.length).toBeGreaterThan(5);
    for (const needle of ["hello from far away", "/api/projects", "Bearer", "pair/claim", "echo(", projectId]) {
      expect(wire).not.toContain(needle);
    }
  });

  it("refuses the admin bootstrap and non-API paths through the relay", async () => {
    const phone = new RelayClient(bus.connect(), creds);
    expect((await phone.request("GET", "/api/bootstrap")).status).toBe(403);
    expect((await phone.request("GET", "/app")).status).toBe(403);
    expect((await phone.request("GET", "/api/../app")).status).toBe(403);
    // and the route itself refuses anything marked as relayed, even on loopback
    const direct = await fetch(`${baseUrl}/api/bootstrap`, { headers: { "x-loom-via": "relay" } });
    expect(direct.status).toBe(403);
    await phone.close();
  });

  it("a client with the wrong key gets nothing back", async () => {
    const intruder = new RelayClient(bus.connect(), { channel: creds.channel, key: newRelayCredentials().key });
    const r = await intruder.request("GET", "/api/health", { timeoutMs: 800 });
    expect(r.status).toBe(504);
    await intruder.close();
  });

  it("rotating the key locks out phones that paired with the old one", async () => {
    await post("/api/cloud/rotate");
    const stale = new RelayClient(bus.connect(), creds);
    expect(await stale.ping(800)).toBeNull();
    await stale.close();
    const fresh = readCloudSettings();
    expect(fresh.key).not.toBe(creds.key);
    const phone = new RelayClient(bus.connect(), { channel: fresh.channel!, key: fresh.key! });
    expect(await phone.ping()).not.toBeNull();
    await phone.close();
  });

  it("disables cleanly, and the pairing link drops the cloud part", async () => {
    const s = await post("/api/cloud/disable");
    expect(s).toMatchObject({ enabled: false, connected: false });
    const pair = await post("/api/pair/new");
    expect(String(pair.link)).not.toContain("relay=");
  });
});
