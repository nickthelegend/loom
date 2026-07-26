/**
 * The whole product, end to end, over one real daemon.
 *
 * The rest of the suite tests parts. This tests the path a person actually
 * walks: add a project, talk to an agent, pass the baton, run a route, write a
 * decision and read it back out of the brain, then open every panel the
 * Observatory opens and check the daemon answers each one.
 *
 * It exists because every failure found the day before a demo was of this
 * shape — not a broken function, but a surface nothing had driven end to end:
 * an endpoint the UI called that no test called, a model id the docs
 * recommended that the CLI rejects, an adapter check still probing a component
 * that had been withdrawn. Unit tests were green through all of it.
 *
 * Echo agents on purpose. This asserts Loom's wiring, and a real CLI would make
 * it slow, non-deterministic, and dependent on who is signed in on the machine
 * running it. Whether the real adapters work is a different question, asked by
 * `npm run verify:adapters`, which drives each one for real.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent, ProjectStatus } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const events = async (): Promise<LoomEvent[]> => (await client.events(projectId, 0, 500)).events;
const status = async (): Promise<ProjectStatus> => (await client.project(projectId)).project;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  token = cfg.adminToken;
  client = new DaemonClient(cfg);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-e2e-"));
  writeProjectConfig(dir, {
    name: "e2e-demo",
    agents: [
      { id: "plannerbot", kind: "echo", role: "planner" },
      { id: "execbot", kind: "echo", role: "executor" },
      { id: "reviewbot", kind: "echo", role: "reviewer" },
    ],
    routes: { ship: ["plannerbot", "execbot", "reviewbot"] },
    brain: { extractor: "off" },
  });
  const added = await client.addProject(dir);
  projectId = added.project.id;
}, 60_000);

afterAll(async () => {
  await daemon.close();
});

describe("end to end · the thread", () => {
  it("runs an agent turn to completion", async () => {
    await client.send(projectId, "plan the feature");
    await waitUntil(async () => (await events()).some((e) => e.kind === "run_complete"));
  });

  it("moves the baton, and says who holds it", async () => {
    await client.handoff(projectId, "execbot");
    expect((await status()).holder).toBe("execbot");
  });
});

describe("end to end · routing", () => {
  it("runs a named pipeline to completion and reports its final state", async () => {
    await client.startRoute(projectId, "ship dark mode", "ship");
    await waitUntil(async () => (await events()).some((e) => e.kind === "route_completed"), {
      timeoutMs: 90_000,
    });
    expect((await client.routeState(projectId)).route?.status).toBe("completed");
  });
});

describe("end to end · the brain", () => {
  it("folds a decision into the shared memory the next agent is handed", async () => {
    await client.decision(projectId, "we chose sqlite for the event log");
    const { memory } = await client.memory(projectId);
    // The projection is what actually reaches a model, so assert on that rather
    // than on the row that was written.
    expect(JSON.stringify(memory)).toContain("sqlite");
    expect(memory.projectName).toBe("e2e-demo");
  });
});

describe("end to end · the Observatory's endpoints", () => {
  // Every panel the Observatory opens, in one place. A 404 here is a view that
  // renders an empty state forever and never says why.
  const PANELS = [
    "metrics",
    "decisions",
    "snapshots",
    "budgets",
    "insights/spans?hours=24",
    "insights/burn?hours=24&buckets=12",
    "insights/health",
    "insights/logs?limit=50",
    "insights/metrics",
    "triage/execbot",
    "skills",
    "skills/catalog",
    "mcps",
  ];

  it.each(PANELS)("GET /%s answers", async (panel) => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/${panel}`, { headers: H() });
    expect(r.status, `${panel} returned ${r.status}`).toBe(200);
  });

  it("serves the MCP catalog", async () => {
    const r = await fetch(`${baseUrl}/api/mcp/catalog`, { headers: H() });
    expect(r.status).toBe(200);
  });
});

describe("end to end · self-heal", () => {
  it("pauses the agent an alert names, and lets it back in when it resolves", async () => {
    const post = (status: "firing" | "resolved") =>
      fetch(`${baseUrl}/api/webhooks/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          alerts: [{ status, labels: { alertname: "TurnErrors", agent: "reviewbot" }, annotations: {} }],
        }),
      });

    expect((await post("firing")).ok).toBe(true);
    expect((await status()).quarantine?.reviewbot).toBeTruthy();

    expect((await post("resolved")).ok).toBe(true);
    expect((await status()).quarantine?.reviewbot).toBeFalsy();
  });

  it("takes a daily budget for an agent", async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/budgets/execbot`, {
      method: "PUT",
      headers: H(),
      body: JSON.stringify({ usdPerDay: 5 }),
    });
    expect(r.status).toBe(200);
  });
});

describe("end to end · the phone", () => {
  it("pairs, can read, and is still not an admin", async () => {
    const { token: pairToken } = await client.newPairingToken();
    const claim = await fetch(`${baseUrl}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: pairToken, name: "phone" }),
    });
    expect(claim.ok).toBe(true);
    const { clientToken } = (await claim.json()) as { clientToken: string };

    const read = await fetch(`${baseUrl}/api/projects`, {
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(read.ok).toBe(true);

    // The whole point of a client token: it reads, it doesn't administer.
    const mint = await fetch(`${baseUrl}/api/pair/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(mint.status).toBe(403);
  });
});

describe("end to end · the shell", () => {
  it("serves the app with every placeholder substituted", async () => {
    const r = await fetch(`${baseUrl}/app`);
    expect(r.ok).toBe(true);
    const html = await r.text();
    // A `%%NAME%%` that reached the browser is a template the daemon forgot to
    // fill — it fails silently, as a feature that quietly does nothing.
    expect(html).not.toMatch(/%%[A-Z_]+%%/);
    expect(html).toContain('"observatory"');
  });
});
