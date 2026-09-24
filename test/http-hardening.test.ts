/**
 * The daemon's edges: what a malformed request, an unknown endpoint and a
 * pairing-code guesser get back, and the headers every response carries.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

describe("the daemon's edges", () => {
  let daemon: LoomDaemon;
  let base: string;
  let auth: Record<string, string>;
  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home-hardening");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const { host, port } = await daemon.listen();
    base = `http://${host}:${port}`;
    auth = { authorization: `Bearer ${readDaemonConfig()!.adminToken}` };
  });
  afterAll(async () => {
    await daemon?.close();
  });

  it("answers bad JSON, oversized bodies and unknown endpoints in JSON, with no stack", async () => {
    const bad = await fetch(`${base}/api/projects`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "that request body isn't valid JSON" });
    const big = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ x: "a".repeat(2_200_000) }),
    });
    expect(big.status).toBe(413);
    const none = await fetch(`${base}/api/definitely-not-here`, { headers: auth });
    expect(none.status).toBe(404);
    expect(none.headers.get("content-type")).toMatch(/json/);
  });

  it("sends the security headers, and only lets Loom frame the app", async () => {
    const r = await fetch(`${base}/app`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("x-powered-by")).toBeNull();
    const api = await fetch(`${base}/api/health`);
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("throttles pairing-code guesses", async () => {
    const claim = () =>
      fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "guess" }) });
    for (let i = 0; i < 10; i++) expect((await claim()).status).toBe(403);
    const blocked = await claim();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
