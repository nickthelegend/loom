import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon, base: string, token: string, project: string, one: string, two: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("crew-memory-home");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  const config = readDaemonConfig()!; token = config.adminToken;
  const client = new DaemonClient(config);
  project = (await client.addProject(makeProjectDir())).project.id;
  one = (await client.createCrew(project, { name: "One", template: "fix" })).crew.id;
  two = (await client.createCrew(project, { name: "Two", template: "fix" })).crew.id;
});
afterAll(async () => { await daemon?.close(); });
async function request(method: string, route: string, body?: object) {
  const response = await fetch(`${base}/api/projects/${project}${route}`, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
describe("crew memory and refresh routes", () => {
  it("keeps crew memories out of other crews and project retrieval until explicitly promoted", async () => {
    const added = await request("POST", `/crews/${one}/memory`, { text: "crew-only sapphire protocol" });
    expect(added.status).toBe(200);
    const memory = added.body.memory;
    expect((await request("GET", `/crews/${one}/memory`)).body.memories).toHaveLength(1);
    expect((await request("GET", `/crews/${two}/memory`)).body.memories).toEqual([]);
    expect((await request("GET", "/brain/search?q=sapphire")).body.hits).toEqual([]);
    expect((await request("POST", `/crews/${two}/memory/${memory.id}/promote`)).status).toBe(400);
    expect((await request("POST", `/crews/${one}/memory/${memory.id}/promote`)).status).toBe(200);
    expect((await request("GET", "/brain/search?q=sapphire")).body.hits.map((h: any) => h.memory.id)).toContain(memory.id);
  });
  it("validates memory inputs and reports unavailable native refresh", async () => {
    expect((await request("POST", `/crews/${one}/memory`, { text: "" })).status).toBe(400);
    expect((await request("POST", `/crews/missing/memory`, { text: "x" })).status).toBe(400);
    expect((await request("POST", `/crews/${one}/refresh`, { to: "builder" })).body.error).toMatch(/continuity/);
  });
});
