/**
 * Per-project tokens (#26): pairing a phone for one project no longer hands
 * over the daemon.
 *
 * Scope is chosen by the admin who MINTS the pairing token, carried through the
 * claim, and enforced in one wall over every project route — matched by
 * resolved id, because a scope you could dodge by spelling the project's name
 * differently would be theatre. Clients paired before scoping existed carry no
 * scope and stay exactly as powerful as they were.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let admin: DaemonClient;
let baseUrl: string;
let adminToken: string;
let mineId: string;
let mineName: string;
let othersId: string;
let scopedToken: string;

const H = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  adminToken = readDaemonConfig()!.adminToken;
  admin = new DaemonClient(readDaemonConfig()!);
  const mine = await admin.addProject(makeProjectDir({ name: "mine" }));
  mineId = mine.project.id;
  mineName = "mine";
  othersId = (await admin.addProject(makeProjectDir({ name: "others" }))).project.id;

  // Mint scoped, claim as a device would.
  const mint = await fetch(`${baseUrl}/api/pair/new`, {
    method: "POST",
    headers: H(adminToken),
    body: JSON.stringify({ projects: [mineId] }),
  });
  expect(mint.status).toBe(200);
  const { token } = (await mint.json()) as { token: string };
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "scoped-phone" }),
  });
  scopedToken = ((await claim.json()) as { clientToken: string }).clientToken;
});

afterAll(async () => {
  await daemon.close();
});

describe("a scoped token", () => {
  it("reaches its own project", async () => {
    const r = await fetch(`${baseUrl}/api/projects/${mineId}`, { headers: H(scopedToken) });
    expect(r.status).toBe(200);
  });

  it("is refused on any other project, by id or by name", async () => {
    const byId = await fetch(`${baseUrl}/api/projects/${othersId}`, { headers: H(scopedToken) });
    expect(byId.status).toBe(403);
    const byName = await fetch(`${baseUrl}/api/projects/others`, { headers: H(scopedToken) });
    expect(byName.status).toBe(403);
  });

  it("cannot dodge the wall by spelling its own project differently", async () => {
    // The wall resolves names to ids before matching — the NAME of the scoped
    // project must work, since it resolves to the allowed id.
    const r = await fetch(`${baseUrl}/api/projects/${mineName}`, { headers: H(scopedToken) });
    expect(r.status).toBe(200);
  });

  it("sees only its world in the project list", async () => {
    const r = await fetch(`${baseUrl}/api/projects`, { headers: H(scopedToken) });
    const { projects } = (await r.json()) as { projects: Array<{ id: string }> };
    expect(projects.map((p) => p.id)).toEqual([mineId]);
  });

  it("cannot mint pairing tokens at all", async () => {
    const r = await fetch(`${baseUrl}/api/pair/new`, {
      method: "POST",
      headers: H(scopedToken),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403); // admin only, and a scoped client is never admin
  });
});

describe("everyone else", () => {
  it("admin is unrestricted", async () => {
    for (const id of [mineId, othersId]) {
      const r = await fetch(`${baseUrl}/api/projects/${id}`, { headers: H(adminToken) });
      expect(r.status).toBe(200);
    }
  });

  it("a client paired without scope keeps the run of the place", async () => {
    const mint = await fetch(`${baseUrl}/api/pair/new`, {
      method: "POST",
      headers: H(adminToken),
      body: JSON.stringify({}),
    });
    const { token } = (await mint.json()) as { token: string };
    const claim = await fetch(`${baseUrl}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "old-style" }),
    });
    const unscoped = ((await claim.json()) as { clientToken: string }).clientToken;
    for (const id of [mineId, othersId]) {
      const r = await fetch(`${baseUrl}/api/projects/${id}`, { headers: H(unscoped) });
      expect(r.status).toBe(200);
    }
  });

  it("minting with an unknown project in scope is a loud 400, not a dud token", async () => {
    const r = await fetch(`${baseUrl}/api/pair/new`, {
      method: "POST",
      headers: H(adminToken),
      body: JSON.stringify({ projects: ["no-such-project"] }),
    });
    expect(r.status).toBe(400);
  });
});

/**
 * The small-surface routes shipped alongside scoping: version, HEAD health,
 * rename, thread search, board-task listing. One suite because they share the
 * daemon fixture, one test each because they share nothing else.
 */
describe("small surfaces", () => {
  it("HEAD /api/health answers bodylessly", async () => {
    const r = await fetch(`${baseUrl}/api/health`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });

  it("GET /api/version names the build", async () => {
    const r = await fetch(`${baseUrl}/api/version`, { headers: H(adminToken) });
    const v = (await r.json()) as { rev: string; node: string; uptimeSec: number };
    expect(v.rev).toBeTruthy();
    expect(v.node).toContain("v");
    expect(v.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("renames the label and only the label", async () => {
    const r = await fetch(`${baseUrl}/api/projects/${mineId}`, {
      method: "PATCH",
      headers: H(adminToken),
      body: JSON.stringify({ name: "mine-renamed" }),
    });
    expect(r.status).toBe(200);
    const g = await fetch(`${baseUrl}/api/projects/${mineId}`, { headers: H(adminToken) });
    const { project } = (await g.json()) as { project: { id: string; name: string } };
    expect(project.name).toBe("mine-renamed");
    expect(project.id).toBe(mineId); // the id never moves
  });

  it("searches the thread", async () => {
    await fetch(`${baseUrl}/api/projects/${mineId}/messages`, {
      method: "POST",
      headers: H(adminToken),
      body: JSON.stringify({ text: "the xyzzy incident of tuesday" }),
    });
    const r = await fetch(
      `${baseUrl}/api/projects/${mineId}/events/search?q=xyzzy`,
      { headers: H(adminToken) },
    );
    const { hits } = (await r.json()) as { hits: Array<{ payload: { text?: string } }> };
    expect(hits.some((h) => String(h.payload.text).includes("xyzzy"))).toBe(true);
  });

  it("lists the cards you wrote", async () => {
    await fetch(`${baseUrl}/api/projects/${mineId}/board/tasks`, {
      method: "POST",
      headers: H(adminToken),
      body: JSON.stringify({ title: "listable card" }),
    });
    const r = await fetch(`${baseUrl}/api/projects/${mineId}/board/tasks`, {
      headers: H(adminToken),
    });
    const { tasks } = (await r.json()) as { tasks: Array<{ title: string }> };
    expect(tasks.some((t) => t.title === "listable card")).toBe(true);
  });
});
