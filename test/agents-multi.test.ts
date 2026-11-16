import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let projectId: string;
let projectDir: string;
let token: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-agents-multi");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  client = new DaemonClient(cfg);
  token = cfg.adminToken;
  projectDir = makeProjectDir();
  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => { await daemon.close(); });

function add(body: Record<string, unknown>) {
  return fetch(`${client.baseUrl}/api/projects/${projectId}/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("adding a fleet", () => {
  it("persists three named sessions pinned to a model and preserves options", async () => {
    const res = await add({ kind: "echo", as: "opus", model: "claude-opus-5-5", count: 3, role: "worker", options: { model: "old", tools: true } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = ["opus", "opus-2", "opus-3"].map((id) => ({
      id, kind: "echo", role: "worker", options: { model: "claude-opus-5-5", tools: true },
    }));
    expect(body).toEqual({ ...expected[0], agents: expected });
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, ".loom", "config.json"), "utf8"));
    expect(config.agents).toEqual(expect.arrayContaining(expected));
  });

  it("defaults to one agent and keeps the old top-level config fields", async () => {
    const res = await add({ kind: "echo", id: "solo", options: { model: "existing-option" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = { id: "solo", kind: "echo", role: "echo", options: { model: "existing-option" } };
    expect(body).toEqual({ ...expected, agents: [expected] });
  });

  it("uses the next free named suffix and gives id precedence over as", async () => {
    await client.addAgent(projectId, "echo", { as: "fleet-2" });
    const res = await add({ kind: "echo", id: "fleet", as: "ignored", count: 3 });
    expect(res.status).toBe(200);
    expect((await res.json()).agents.map((a: { id: string }) => a.id)).toEqual(["fleet", "fleet-3", "fleet-4"]);
  });

  it("accepts eight unnamed sessions through the client", async () => {
    const added = await client.addAgent(projectId, "echo", { count: 8, model: "test-model" });
    expect(added.agents.map((a) => a.id)).toEqual(["echo", "echo-2", "echo-3", "echo-4", "echo-5", "echo-6", "echo-7", "echo-8"]);
    expect(added.agents.every((a) => a.options?.model === "test-model")).toBe(true);
  });

  it.each([0, -1, 9, 1.5, "3", null, true])("rejects count %j without changing the roster", async (count) => {
    const before = readProjectConfig(projectDir)!.agents;
    const res = await add({ kind: "echo", count });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/count.*integer.*1.*8/);
    expect(readProjectConfig(projectDir)!.agents).toEqual(before);
  });

  it("rejects unknown kinds and non-string models", async () => {
    const before = readProjectConfig(projectDir)!.agents;
    const unknown = await add({ kind: "not-an-agent", count: 3 });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/unknown agent kind/);
    const model = await add({ kind: "echo", model: 42, count: 3 });
    expect(model.status).toBe(400);
    expect((await model.json()).error).toBe("model must be a string");
    expect(readProjectConfig(projectDir)!.agents).toEqual(before);
  });

  it("lists models by kind before adding an instance", async () => {
    const empty = (await client.addProject(makeProjectDir({ agents: [] }))).project.id;
    const res = await fetch(`${client.baseUrl}/api/projects/${empty}/agents/models?kind=echo`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "echo", count: 0, models: [], source: "none" });
    const unknown = await fetch(`${client.baseUrl}/api/projects/${empty}/agents/models?kind=missing`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.status).toBe(400);
  });
});
