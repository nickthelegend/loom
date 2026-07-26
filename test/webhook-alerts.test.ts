/**
 * Self-healing: an alert firing for an agent posts to the webhook, and Loom
 * forces the baton off that agent onto a fallback. Metric → intervention.
 *
 * The payload is the Alertmanager shape — `{status, alerts: [{status, labels}]}`
 * — which is what SigNoz, Prometheus/Alertmanager and Grafana all send, so the
 * route is named for the payload rather than for any one vendor.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  delete process.env.LOOM_WEBHOOK_SECRET;
  process.env.LOOM_HEAL_DISABLED = "1"; // the background recheck loop is exercised in its own test
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(makeProjectDir({ name: "heal" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
  delete process.env.LOOM_HEAL_DISABLED;
});

describe("firing alert -> baton intervention", () => {
  // These cases share one daemon, and each one begins by handing the baton to a
  // specific agent. A quarantine left behind by the previous case used to be
  // harmless because nothing enforced it; now that a paused agent is genuinely
  // refused, the leak has to be cleaned up or the *next* test fails on setup.
  beforeEach(async () => {
    const q = (await client.project(projectId)).project.quarantine ?? {};
    for (const agentId of Object.keys(q)) {
      await fetch(`${baseUrl}/api/webhooks/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "resolved",
          alerts: [{ status: "resolved", labels: { alertname: "cleanup", "loom.project": "heal", "gen_ai.agent.id": agentId } }],
        }),
      });
    }
    await waitUntil(async () => Object.keys((await client.project(projectId)).project.quarantine ?? {}).length === 0, { timeoutMs: 6000 });
  });

  it("forces the baton off the failing agent onto a fallback", async () => {
    // give the failing agent the baton first (it starts unassigned)
    await client.handoff(projectId, "plannerbot");
    const holder0 = (await client.project(projectId)).project.holder;
    expect(holder0).toBe("plannerbot");

    const res = await fetch(`${baseUrl}/api/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "AgentErrorRateHigh", "loom.project": "heal", "gen_ai.agent.id": holder0 } }],
      }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; actions: Array<{ action?: string }> };
    expect(j.ok).toBe(true);
    expect(j.actions[0]?.action).toMatch(/baton handed to/);

    await waitUntil(async () => (await client.project(projectId)).project.holder !== holder0, { timeoutMs: 6000 });
    const after = (await client.project(projectId)).project.holder;
    expect(after).not.toBe(holder0);

    const { events } = await client.events(projectId, undefined, 100);
    expect(events.some((e) => e.kind === "handoff" && e.payload.to === after)).toBe(true);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "alert_intervention")).toBe(true);
  });

  it("retries the original agent when the alert resolves (pause → failover → restore)", async () => {
    await client.handoff(projectId, "plannerbot");
    expect((await client.project(projectId)).project.holder).toBe("plannerbot");

    const post = (status: string) =>
      fetch(`${baseUrl}/api/webhooks/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alerts: [{ status, labels: { alertname: "AgentErrorRateHigh", "loom.project": "heal", "gen_ai.agent.id": "plannerbot" } }] }),
      }).then((r) => r.json() as Promise<{ actions: Array<{ action?: string }> }>);

    // firing: plannerbot is quarantined and the baton fails over
    const fired = await post("firing");
    expect(fired.actions[0]?.action).toMatch(/quarantined; baton handed to/);
    await waitUntil(async () => (await client.project(projectId)).project.holder !== "plannerbot", { timeoutMs: 6000 });
    const failedOverTo = (await client.project(projectId)).project.holder;
    expect(failedOverTo).not.toBe("plannerbot");

    // resolved: the baton is handed back to plannerbot (retry)
    const resolved = await post("resolved");
    expect(resolved.actions[0]?.action).toMatch(/baton handed back to plannerbot/);
    await waitUntil(async () => (await client.project(projectId)).project.holder === "plannerbot", { timeoutMs: 6000 });
    expect((await client.project(projectId)).project.holder).toBe("plannerbot");

    const { events } = await client.events(projectId, undefined, 100);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "alert_recovery" && e.payload.retried === true)).toBe(true);
  });

  it("auto-returns the baton on the recheck loop when the agent stops erroring", async () => {
    // Enable the background loop with a fast recheck just for this test.
    process.env.LOOM_HEAL_RECHECK_MS = "60";
    process.env.LOOM_HEAL_MAX_RETRIES = "3";
    delete process.env.LOOM_HEAL_DISABLED;
    try {
      await client.handoff(projectId, "plannerbot");
      await fetch(`${baseUrl}/api/webhooks/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alerts: [{ status: "firing", labels: { alertname: "AgentErrorRateHigh", "loom.project": "heal", "gen_ai.agent.id": "plannerbot" } }] }),
      });
      // failover happened; the recheck loop (no new errors) then hands it back.
      await waitUntil(async () => (await client.project(projectId)).project.holder !== "plannerbot", { timeoutMs: 4000 });
      await waitUntil(async () => (await client.project(projectId)).project.holder === "plannerbot", { timeoutMs: 4000 });
      const { events } = await client.events(projectId, undefined, 100);
      expect(events.some((e) => e.kind === "status" && e.payload.state === "alert_recovery" && e.payload.via === "recheck")).toBe(true);
    } finally {
      delete process.env.LOOM_HEAL_RECHECK_MS;
      delete process.env.LOOM_HEAL_MAX_RETRIES;
      process.env.LOOM_HEAL_DISABLED = "1";
    }
  });

  // These two guard the bug that made the whole feature cosmetic: the webhook
  // wrote a quarantine into state and *nothing read it back*, so the paused
  // agent kept taking work and the pause was invisible to every client.
  it("refuses to hand the baton to an agent an alert has paused", async () => {
    await client.handoff(projectId, "plannerbot");
    await fetch(`${baseUrl}/api/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "AgentErrorRateHigh", "loom.project": "heal", "gen_ai.agent.id": "execbot" } }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/projects/${projectId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${readDaemonConfig()!.adminToken}` },
      body: JSON.stringify({ to: "execbot" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; agentId: string };
    expect(body.error).toBe("agent_quarantined");
    expect(body.agentId).toBe("execbot");

    // ...and it lets go once the alert resolves.
    await fetch(`${baseUrl}/api/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "resolved",
        alerts: [{ status: "resolved", labels: { alertname: "AgentErrorRateHigh", "loom.project": "heal", "gen_ai.agent.id": "execbot" } }],
      }),
    });
    await waitUntil(async () => !((await client.project(projectId)).project.quarantine ?? {})["execbot"], { timeoutMs: 6000 });
    const ok = await fetch(`${baseUrl}/api/projects/${projectId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${readDaemonConfig()!.adminToken}` },
      body: JSON.stringify({ to: "execbot" }),
    });
    expect(ok.status).toBe(200);
  });

  it("reports the pause in the project status, not only on disk", async () => {
    await fetch(`${baseUrl}/api/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "AgentLatencyHigh", "loom.project": "heal", "gen_ai.agent.id": "reviewbot" } }],
      }),
    });
    await waitUntil(async () => Boolean(((await client.project(projectId)).project.quarantine ?? {})["reviewbot"]), { timeoutMs: 6000 });
    const q = (await client.project(projectId)).project.quarantine ?? {};
    expect(q["reviewbot"]?.reason).toContain("AgentLatencyHigh");
  });

  it("a resolved alert for an agent that was never quarantined is a no-op", async () => {
    const r = await fetch(`${baseUrl}/api/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alerts: [{ status: "resolved", labels: { "loom.project": "heal", "gen_ai.agent.id": "reviewbot" } }] }),
    });
    const j = (await r.json()) as { actions: Array<{ action?: string }> };
    expect(j.actions[0]?.action).toMatch(/was not quarantined/);
  });

  it("enforces the shared-secret gate when configured", async () => {
    process.env.LOOM_WEBHOOK_SECRET = "s3cret";
    const res = await fetch(`${baseUrl}/api/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    delete process.env.LOOM_WEBHOOK_SECRET;
  });
});

/**
 * The webhook sits in front of the bearer wall so Alertmanager, which has no
 * Loom token, can post to it. That is fine while the daemon is on loopback and
 * only a local user can reach it. Bound past localhost with no secret set, the
 * same route lets anyone who can route a packet quarantine an agent and move the
 * baton, so it refuses instead — and names the variable to set rather than just
 * saying no.
 */
describe("webhook auth past loopback", () => {
  it("refuses an unsecured webhook when the daemon is not on loopback", async () => {
    process.env.LOOM_HOME = tmpDir("home-exposed");
    delete process.env.LOOM_WEBHOOK_SECRET;
    const d = new LoomDaemon({ host: "0.0.0.0", port: 0 });
    const { port } = await d.listen();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/webhooks/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alerts: [] }),
      });
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: string }).error).toContain("LOOM_WEBHOOK_SECRET");
    } finally {
      await d.close();
    }
  });
});
