/** Search every session, and the audit trail (approach credit: Nuphos). */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let base: string;
let admin: string;
let a: string;
let b: string;
const call = (token: string, p: string, init: RequestInit = {}) =>
  fetch(base + p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-views");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  client = new DaemonClient(cfg);
  base = `http://${cfg.host}:${cfg.port}`;
  admin = cfg.adminToken;
  a = (await client.addProject(makeProjectDir({ name: "alpha" }))).project.id;
  b = (await client.addProject(makeProjectDir({ name: "beta" }))).project.id;
  await client.send(a, "the zebra migration plan");
  await client.send(b, "zebra stripes in the beta config");
  await waitUntil(async () => (await client.searchAll("zebra")).hits.length >= 4, 20_000);
}, 60_000);
afterAll(async () => { await daemon.close(); });

describe("search every session", () => {
  it("finds a phrase in every project's chats, newest first, with where it is", async () => {
    const { hits } = await client.searchAll("zebra");
    expect(new Set(hits.map((h) => h.projectName))).toEqual(new Set(["alpha", "beta"]));
    expect(hits[0]!.at).toBeGreaterThanOrEqual(hits.at(-1)!.at);
    expect(hits.find((h) => h.projectName === "beta")).toMatchObject({ chat: "main", snippet: expect.stringContaining("zebra") });
  });

  it("a token scoped to one project searches only it; a guest can't search", async () => {
    const pair = await (await call(admin, "/api/pair/new", { method: "POST", body: JSON.stringify({ projects: [a] }) })).json() as { token: string };
    const claim = await (await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token }) })).json() as { clientToken: string };
    const scoped = await (await call(claim.clientToken, "/api/search?q=zebra")).json() as { hits: Array<{ projectName: string }> };
    expect(new Set(scoped.hits.map((h) => h.projectName))).toEqual(new Set(["alpha"]));
    const g = await (await call(admin, "/api/pair/new", { method: "POST", body: JSON.stringify({ guest: { project: a, chat: "main", role: "reply", name: "Ada" } }) })).json() as { link: string };
    const gc = await (await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(g.link.split("#")[1]).get("pair") }) })).json() as { clientToken: string };
    expect((await call(gc.clientToken, "/api/search?q=zebra")).status).toBe(403);
    expect((await call(gc.clientToken, "/api/audit")).status).toBe(403);
    // and the guest's message shows up in the audit trail under its name
    await call(gc.clientToken, `/api/projects/${a}/messages`, { method: "POST", body: JSON.stringify({ text: "Ada checking in" }) });
    await waitUntil(async () => (await client.audit()).entries.some((e) => e.who === "Ada" && e.what === "sent a message in a shared chat"), 20_000);
  }, 60_000);
});

describe("audit trail", () => {
  it("says who did what: messages from Slack, handoffs, and only the owner reads it", async () => {
    await client.send(b, "deploy the fix\n\n(from Bob on Slack)");
    await call(admin, `/api/projects/${b}/handoff`, { method: "POST", body: JSON.stringify({ to: "execbot" }) });
    await waitUntil(async () => {
      const { entries } = await client.audit();
      return entries.some((e) => e.who === "Bob" && e.what === "sent a message from Slack" && e.detail === "deploy the fix") &&
        entries.some((e) => e.projectName === "beta" && e.what === "baton → execbot");
    }, 20_000);
    const pair = await (await call(admin, "/api/pair/new", { method: "POST", body: "{}" })).json() as { token: string };
    const phone = await (await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token }) })).json() as { clientToken: string };
    expect((await call(phone.clientToken, "/api/audit")).status).toBe(403);
  }, 60_000);
});
