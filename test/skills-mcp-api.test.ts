/**
 * The composer's backend surface, over a real daemon: skills enable + injection,
 * MCP persistence, and that AUTO mode drives the dynamic router.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  const client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "composer" });
  projectId = (await client.addProject(projectDir)).project.id;
});
afterAll(async () => { await daemon.close(); });

describe("skills API", () => {
  it("lists the discovered skills and enables one, persisting to config.json", async () => {
    // Loom bundles no skills of its own, and the other roots are whatever this
    // machine has in ~/.claude — so put one in the project first. Otherwise the
    // suite asserts on somebody else's skill library and passes by luck.
    const src = path.join(tmpDir("listskill"), "listed-here");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: listed-here\ndescription: for the list\n---\n\nbody\n");
    await fetch(`${baseUrl}/api/projects/${projectId}/skills/install`, {
      method: "POST", headers: H(), body: JSON.stringify({ dir: src }),
    });

    const list = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills`, { headers: H() })).json()) as { skills: Array<{ id: string; enabled: boolean }> };
    expect(list.skills.length).toBeGreaterThan(0);
    const id = list.skills.find((s) => s.id === "listed-here")!.id;
    expect(list.skills.every((s) => s.enabled === false)).toBe(true); // off by default

    const put = await fetch(`${baseUrl}/api/projects/${projectId}/skills/${id}`, { method: "PUT", headers: H(), body: JSON.stringify({ enabled: true }) });
    expect(put.status).toBe(200);

    const after = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills`, { headers: H() })).json()) as { skills: Array<{ id: string; enabled: boolean }> };
    expect(after.skills.find((s) => s.id === id)!.enabled).toBe(true);
    expect(readProjectConfig(projectDir)!.skills?.[id]).toBe(true);
  });

  it("suggests a disabled skill from a keyword in the message", async () => {
    // Install the skill this asserts on rather than reaching for whatever the
    // machine happens to have in ~/.claude: a suggestion test that depends on
    // somebody else's skill library passes or fails for reasons that have
    // nothing to do with the suggester.
    const src = path.join(tmpDir("suggestskill"), "agent-triage");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: agent-triage\ndescription: root-cause a failing agent\n---\n\nbody\n");
    const installed = await fetch(`${baseUrl}/api/projects/${projectId}/skills/install`, {
      method: "POST", headers: H(), body: JSON.stringify({ dir: src }),
    });
    expect(installed.status).toBe(200);

    // Suggestions only surface skills that are OFF, so make sure it is off.
    await fetch(`${baseUrl}/api/projects/${projectId}/skills/agent-triage`, { method: "PUT", headers: H(), body: JSON.stringify({ enabled: false }) });
    const r = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills?suggest=${encodeURIComponent("why is my agent failing")}`, { headers: H() })).json()) as { suggestion: { id: string } | null };
    expect(r.suggestion?.id).toMatch(/triage/);
  });
});

describe("MCP API", () => {
  it("returns the built-ins and persists an upserted server", async () => {
    const list = (await (await fetch(`${baseUrl}/api/projects/${projectId}/mcps`, { headers: H() })).json()) as { mcps: Array<{ name: string; url?: string }> };
    expect(list.mcps.map((m) => m.name)).toEqual(expect.arrayContaining(["GitHub", "SigNoz", "Slack"]));

    const patch = await fetch(`${baseUrl}/api/projects/${projectId}/mcps`, { method: "PATCH", headers: H(), body: JSON.stringify({ mcp: { name: "SigNoz", url: "http://localhost:8000/mcp", enabledForSession: true } }) });
    expect(patch.status).toBe(200);

    const after = (await (await fetch(`${baseUrl}/api/projects/${projectId}/mcps`, { headers: H() })).json()) as { mcps: Array<{ name: string; url?: string }> };
    expect(after.mcps.find((m) => m.name === "SigNoz")!.url).toBe("http://localhost:8000/mcp");
    expect(readProjectConfig(projectDir)!.mcps?.some((m) => m.name === "SigNoz" && m.url)).toBe(true);
  });
});

describe("AUTO mode routing", () => {
  it("starting a route with spec 'auto' runs the dynamic router", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/route`, { method: "POST", headers: H(), body: JSON.stringify({ task: "add a health endpoint with tests", spec: "auto" }) });
    expect(res.status).toBe(200);
    const { route } = (await res.json()) as { route: { name?: string; mode?: string; status?: string } };
    expect(route.name).toBe("auto"); // the dynamic router, not a named pipeline
  });
});
