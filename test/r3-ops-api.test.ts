import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { readDaemonConfig, readProjectConfig, writeProjectConfig, readProjectState, writeProjectState } from "../src/core/registry.js";
import { writeCrashReport } from "../src/core/crash-report.js";
import { BackupScheduler } from "../src/core/backup-schedule.js";
import { LOG_MAX_BYTES } from "../src/core/ops.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, admin: string, phone: string, scoped: string, guest: string, id: string, other: string, dir: string;
const request = (route: string, token = admin, method = "GET", body?: unknown) => fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function pair(projects?: string[], isGuest = false) {
  const pairing = daemon["auth"].newPairingToken(projects, isGuest ? { guest: { project: id, chat: "main", role: "view", name: "guest", expiresAt: Date.now() + 60_000 } } : {});
  const r = await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairing.token, name: "test phone" }) });
  return (await r.json() as { clientToken: string }).clientToken;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-api-home");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen();
  base = `http://${address.host}:${address.port}`;
  admin = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ name: "r3 project" });
  id = (await client.addProject(dir)).project.id;
  other = (await client.addProject(makeProjectDir({ name: "other" }))).project.id;
  phone = await pair(); scoped = await pair([id]); guest = await pair([id], true);
});
afterAll(async () => { await daemon.close(); });

describe("R3 operations access", () => {
  it("refuses anonymous, scoped and guest machine controls; accepts an ordinary paired phone", async () => {
    expect((await request("/api/ops", "bad-token")).status).toBe(401);
    for (const token of [scoped, guest]) {
      for (const [route, method, body] of [["/api/ops", "GET"], ["/api/ops/du", "GET"], ["/api/ops/backups", "PUT", { every: "1d", keep: 7 }], ["/api/ops/backups", "DELETE"], ["/api/ops/crashes/crash-1-x.json", "GET"]] as const) {
        expect((await request(route, token, method, body)).status).toBe(403);
      }
      expect((await request("/metrics", token)).status).toBe(403);
    }
    expect((await request("/metrics", phone)).status).toBe(403);
    expect((await request("/api/ops", phone)).status).toBe(200);
    expect((await request("/api/ops/backups", phone, "PUT", { every: "1d", keep: 7 })).status).toBe(200);
    expect((await request("/api/ops", phone)).ok).toBe(true);
    expect((await request("/api/ops/backups", phone, "PUT", { every: "0d", keep: 0 })).status).toBe(400);
    expect((await request("/api/ops/backups", phone, "DELETE")).status).toBe(200);
  });
  it("keeps project operations inside the existing scope wall", async () => {
    for (const suffix of ["ops", "du"]) {
      expect((await request(`/api/projects/${id}/${suffix}`, scoped)).status).toBe(200);
      expect((await request(`/api/projects/${other}/${suffix}`, scoped)).status).toBe(403);
      expect((await request(`/api/projects/${id}/${suffix}`, guest)).status).toBe(403);
    }
    for (const [suffix, method, body] of [["doctor/fix", "POST", {}], ["worktrees/policy", "PUT", { days: 7, keep: 3 }], ["worktrees/prune", "POST", { dryRun: true }]] as const) {
      expect((await request(`/api/projects/${id}/${suffix}`, scoped, method, body)).status).toBe(200);
      expect((await request(`/api/projects/${other}/${suffix}`, scoped, method, body)).status).toBe(403);
      expect((await request(`/api/projects/${id}/${suffix}`, guest, method, body)).status).toBe(403);
    }
    expect((await request(`/api/projects/${id}/worktrees/policy`, phone, "PUT", { days: -1, keep: 2 })).status).toBe(400);
    expect((await request(`/api/projects/${id}/worktrees/prune`, phone, "POST", { dryRun: "false" })).status).toBe(400);
  });
});

describe("R3 fixes and diagnostics", () => {
  it("reports applied repairs through the project API and leaves a fresh diagnosis", async () => {
    const config = readProjectConfig(dir)!;
    config.defaultAgent = "missing";
    writeProjectConfig(dir, config);
    writeProjectState(dir, { ...readProjectState(dir), holder: "missing" });
    const r = await request(`/api/projects/${id}/doctor/fix`, phone, "POST", {});
    const result = await r.json() as { fixed: string[]; summary: { failures: number } };
    expect(r.status).toBe(200);
    expect(result.fixed.some(s => s.includes("defaultAgent"))).toBe(true);
    expect(result.summary.failures).toBe(0);
    expect(readProjectConfig(dir)?.defaultAgent).toBeUndefined();
  });
  it("rotates a live daemon log without a restart and exposes redacted crash reports", async () => {
    const file = path.join(process.env.LOOM_HOME!, "daemon.log");
    fs.writeFileSync(file, Buffer.alloc(LOG_MAX_BYTES + 100));
    await waitUntil(() => fs.statSync(file).size === 0);
    const report = writeCrashReport("test", new Error(`Bearer ${admin}`));
    const ops = await (await request("/api/ops", phone)).json() as { crashes: string[]; log: { cap: number; rotatedBytes: number } };
    expect(ops.log).toMatchObject({ cap: LOG_MAX_BYTES, rotatedBytes: LOG_MAX_BYTES });
    expect(ops.crashes).toContain(path.basename(report));
    const r = await request(`/api/ops/crashes/${path.basename(report)}`, phone);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(admin);
    expect((await request("/api/ops/crashes/not-a-report", phone)).status).toBe(400);
  });
});

describe("R3 Prometheus counters", () => {
  it("exports real echo turns, costs, errors and paused queue depth", async () => {
    await client.send(id, "hello metrics", "plannerbot");
    await waitUntil(async () => !(await client.project(id)).project.agents.some(a => a.busy));
    await client.send(id, "fail: deliberate metric error", "plannerbot");
    await waitUntil(async () => !(await client.project(id)).project.agents.some(a => a.busy));
    await client.queuePause(id, true);
    await client.queueAdd(id, { text: "later", target: { kind: "agent", agentId: "plannerbot" } });
    const r = await request("/metrics");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("version=0.0.4");
    const text = await r.text();
    expect(text).toContain(`# TYPE loom_turns_total counter`);
    expect(text).toContain(`loom_turns_total{project="${id}"} 1\n`);
    expect(text).toContain(`loom_cost_usd_total{project="${id}"} 0.001\n`);
    expect(text).toContain(`loom_errors_total{project="${id}"} 1\n`);
    expect(text).toContain(`loom_queue_depth{project="${id}"} 1\n`);
    expect(text).not.toContain("deliberate metric error");
    const ops = await (await request(`/api/projects/${id}/ops`, phone)).json() as { metrics: unknown };
    expect(ops.metrics).toEqual({ turns: 1, costUsd: 0.001, errors: 1, queueDepth: 1 });
    await client.queueClear(id);
    await client.queuePause(id, false);
  });
});

describe("R3 stale-session recovery", () => {
  it("reports a genuinely busy echo session and revalidates age on one-click reap", async () => {
    expect((await request(`/api/projects/${id}/stale/plannerbot/reap`, phone, "POST", {})).status).toBe(409);
    await client.send(id, "sleep:55000", "plannerbot");
    await waitUntil(async () => (await client.project(id)).project.agents.some(a => a.id === "plannerbot" && a.busy));
    const rt = daemon["runtimes"].get(id)!;
    rt["turns"].busySince.set("plannerbot", Date.now() - ProjectRuntime.STALE_TURN_MS - 1000);
    const report = await (await request(`/api/projects/${id}/ops`, phone)).json() as { stale: Array<{ agentId: string }> };
    expect(report.stale.map(s => s.agentId)).toEqual(["plannerbot"]);
    expect((await request(`/api/projects/${id}/stale/plannerbot/reap`, guest, "POST", {})).status).toBe(403);
    expect((await request(`/api/projects/${id}/stale/plannerbot/reap`, scoped, "POST", {})).status).toBe(200);
    expect((await request(`/api/projects/${id}/stale/plannerbot/reap`, phone, "POST", {})).status).toBe(409);
    expect((await client.project(id)).project.holder).toBeNull();
    await client.send(id, "works after reap", "plannerbot");
    await waitUntil(async () => !(await client.project(id)).project.agents.some(a => a.busy));
  });
});

describe("R3 CLI against the isolated test daemon", () => {
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", path.resolve("src/cli/index.ts"), ...args], { env: { ...process.env }, timeout: 20_000 });
  it("shows per-project usage and saves/disables a schedule", async () => {
    const du = JSON.parse((await cli("du", "--json")).stdout);
    expect(du.projects.map((p: { project: string }) => p.project)).toContain(id);
    expect(JSON.parse((await cli("backup", "--every", "1d", "--keep", "7")).stdout).backup).toMatchObject({ every: "1d", keep: 7 });
    expect(JSON.parse((await cli("backup", "--off")).stdout).backup).toBeNull();
  });
});


describe("R3 daemon restart", () => {
  it("catches up one scheduled backup and retains metric history before opening runtimes", async () => {
    new BackupScheduler().configure("1d", 2, Date.now() - 2 * 86_400_000);
    await daemon.close();
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const addr = await daemon.listen(); base = `http://${addr.host}:${addr.port}`;
    client = new DaemonClient(readDaemonConfig()!);
    await waitUntil(async () => Boolean((await client.ops()).backup?.lastAt));
    const schedule = (await client.ops()).backup!;
    expect(schedule.lastAt).toBeGreaterThan(Date.now() - 60_000);
    expect(fs.existsSync(schedule.lastFile!)).toBe(true);
    expect(daemon["runtimes"].size).toBe(0);
    const metrics = await (await request("/metrics")).text();
    expect(metrics).toContain(`loom_turns_total{project="${id}"} 2\n`);
    expect(metrics).toContain(`loom_cost_usd_total{project="${id}"} 0.002\n`);
    expect(daemon["runtimes"].size).toBe(0);
    await client.disableBackup();
  });
});
