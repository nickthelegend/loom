/**
 * Providers over HTTP: the key goes in, and never comes back out.
 *
 * This is the surface a paired phone or a browser on the tailnet can reach, so
 * the rule is absolute — no route returns a key, and the file it lands in is
 * readable only by the person who owns it.
 */

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { providersFile } from "../src/core/providers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let base: string;
let token: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-prov-api");
  process.env.LOOM_NO_NOTIFY = "1";
  // The environment beats the stored file — correctly — so a developer who
  // really has one of these keys would otherwise be testing their own key.
  for (const k of Object.keys(process.env)) if (k.endsWith("_API_KEY")) delete process.env[k];
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  base = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
});

afterAll(async () => {
  await daemon.close();
});

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
};

describe("providers over the wire", () => {
  it("lists what's known before anything is configured", async () => {
    const { body } = await api("/api/providers");
    const ids = (body.providers as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("agentrouter");
  });

  it("takes a key, stores it 0600, and never hands it back", async () => {
    const secret = "sk-supersecret-value-1234";
    const put = await api("/api/providers/openrouter", {
      method: "POST",
      body: JSON.stringify({ key: secret }),
    });
    expect(put.status).toBe(200);

    const row = (put.body.providers as Array<Record<string, unknown>>).find((p) => p.id === "openrouter")!;
    expect(row.configured).toBe(true);
    expect(row.hint).toBe("…1234");

    // Not in this response, and not in any other.
    expect(JSON.stringify(put.body)).not.toContain(secret);
    const listed = await api("/api/providers");
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    // It is on disk, readable by nobody else.
    expect(fs.readFileSync(providersFile(), "utf8")).toContain(secret);
    expect(fs.statSync(providersFile()).mode & 0o777).toBe(0o600);
  });

  it("refuses a provider it has never heard of, unless given a base URL", async () => {
    const bad = await api("/api/providers/nowhere", { method: "POST", body: JSON.stringify({ key: "k" }) });
    expect(bad.status).toBe(400);
    const good = await api("/api/providers/mine", {
      method: "POST",
      body: JSON.stringify({ key: "k", baseUrl: "http://127.0.0.1:9", label: "Mine" }),
    });
    expect(good.status).toBe(200);
  });

  it("forgets one when asked", async () => {
    const gone = await api("/api/providers/mine", { method: "DELETE" });
    expect(gone.body.forgotten).toBe(true);
    const again = await api("/api/providers/mine", { method: "DELETE" });
    expect(again.body.forgotten).toBe(false);
  });

  it("needs the token, like everything else", async () => {
    const res = await fetch(`${base}/api/providers`);
    expect(res.status).toBe(401);
  });

  it("reports a provider that can't be reached as an error, not as no models", async () => {
    await api("/api/providers/dead", {
      method: "POST",
      body: JSON.stringify({ key: "k", baseUrl: "http://127.0.0.1:1" }),
    });
    const { body } = await api("/api/models?provider=dead");
    expect(body.models).toEqual([]);
    expect(String(body.errors[0].error)).toMatch(/couldn't reach/);
  });
});
