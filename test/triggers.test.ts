/**
 * Triggers (approach credit: Nuphos): a schedule or a webhook starts a turn on its own. Unit
 * checks of the cron, templating and signature rules, then a real daemon with echo agents.
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cronMatches, isDue, nextCron, parseCron, parseEvery, renderPrompt, verifyDelivery, type Trigger } from "../src/core/triggers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { TriggerRunner } from "../src/daemon/triggers.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

describe("schedules", () => {
  it("reads cron the way cron does", () => {
    const c = parseCron("*/15 9-17 * * 1-5");
    expect(cronMatches(c, new Date(2026, 9, 26, 9, 30))).toBe(true); // Monday 09:30
    expect(cronMatches(c, new Date(2026, 9, 26, 9, 31))).toBe(false);
    expect(cronMatches(c, new Date(2026, 9, 25, 9, 30))).toBe(false); // Sunday
    // day-of-month and day-of-week both set: either one
    const either = parseCron("0 0 1 * 0");
    expect(cronMatches(either, new Date(2026, 9, 1, 0, 0))).toBe(true); // the 1st (a Thursday)
    expect(cronMatches(either, new Date(2026, 9, 25, 0, 0))).toBe(true); // a Sunday
    expect(cronMatches(parseCron("@daily"), new Date(2026, 9, 26, 0, 0))).toBe(true);
    expect(cronMatches(parseCron("0 0 * * 7"), new Date(2026, 9, 25, 0, 0))).toBe(true); // 7 is Sunday too
    expect(nextCron(parseCron("30 8 * * *"), new Date(2026, 9, 26, 9, 0))).toEqual(new Date(2026, 9, 27, 8, 30));
    expect(() => parseCron("61 * * * *")).toThrow(/out of range for the minute field/);
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
    expect(parseEvery("30m")).toBe(30);
    expect(parseEvery("2h")).toBe(120);
    expect(() => parseEvery("soon")).toThrow(/isn't an interval/);
  });

  it("fires a cron once in its minute, and an interval once per interval", () => {
    const t: Trigger = { id: "t", name: "t", kind: "schedule", cron: "0 9 * * *", prompt: "p", enabled: true, createdAt: 0 };
    const nine = new Date(2026, 9, 26, 9, 0, 10);
    expect(isDue(t, nine)).toBe(true);
    expect(isDue({ ...t, lastFiredAt: nine.getTime() - 5_000 }, new Date(2026, 9, 26, 9, 0, 40))).toBe(false);
    expect(isDue({ ...t, enabled: false }, nine)).toBe(false);
    const every: Trigger = { ...t, cron: undefined, everyMin: 30, createdAt: 1_000_000 };
    expect(isDue(every, new Date(1_000_000 + 29 * 60_000))).toBe(false);
    expect(isDue(every, new Date(1_000_000 + 30 * 60_000))).toBe(true);
  });
});

describe("webhooks", () => {
  it("accepts GitHub's signature, the plain secret, and nothing else", () => {
    const body = Buffer.from('{"action":"opened"}');
    const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifyDelivery("s3cret", body, { "x-hub-signature-256": sig })).toBe(true);
    expect(verifyDelivery("s3cret", Buffer.from('{"action":"closed"}'), { "x-hub-signature-256": sig })).toBe(false);
    expect(verifyDelivery("s3cret", body, { "x-loom-secret": "s3cret" })).toBe(true);
    expect(verifyDelivery("s3cret", body, {}, "s3cret")).toBe(true);
    expect(verifyDelivery("s3cret", body, { "x-loom-secret": "nope" })).toBe(false);
    expect(verifyDelivery("s3cret", body, {})).toBe(false);
  });

  it("fills a prompt from the payload", () => {
    const body = { pull_request: { title: "Fix login", number: 7 } };
    expect(renderPrompt("Review #{{body.pull_request.number}}: {{payload.pull_request.title}} ({{event}}) {{trigger.name}}", body, "pull_request", { name: "PRs", firedAt: 0 }))
      .toBe("Review #7: Fix login (pull_request) PRs");
    expect(renderPrompt("{{body}}", { a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("triggers on a real daemon", () => {
  let daemon: LoomDaemon;
  let client: DaemonClient;
  let projectId: string;
  let dir: string;
  const replies = async (chat: string) =>
    (await client.events(projectId, 0, 500)).events.filter((e) => e.kind === "message" && (e as { chat?: string }).chat === chat && e.agentId).map((e) => String((e.payload as { text?: string }).text));

  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home-triggers");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    client = new DaemonClient(readDaemonConfig()!);
    dir = makeProjectDir({ name: "trig" });
    projectId = (await client.addProject(dir)).project.id;
  }, 60_000);
  afterAll(async () => { await daemon.close(); });

  it("a schedule runs in its own thread, and skips while its last run is still waiting", async () => {
    const { trigger } = await client.addTrigger(projectId, { kind: "schedule", every: "1h", prompt: "daily digest please", name: "digest" });
    expect(trigger.nextAt).toBeGreaterThan(Date.now());
    const { run } = await client.fireTrigger(projectId, trigger.id);
    expect(run).toMatchObject({ ok: true, note: "queued" });
    const { triggers } = await client.triggers(projectId);
    const chat = triggers.find((t) => t.id === trigger.id)!.chat as string;
    expect(chat).toBeTruthy();
    await waitUntil(async () => (await replies(chat)).some((t) => t.includes("daily digest please")), 20_000);
    // the ticker fires it when it's due
    const runner = new TriggerRunner((id) => (daemon as unknown as { runtime(id: string): Promise<never> }).runtime(id));
    const { readTriggers, writeTriggers } = await import("../src/core/triggers.js");
    const data = readTriggers(dir);
    data.triggers.find((t) => t.id === trigger.id)!.lastFiredAt = Date.now() - 2 * 3_600_000;
    writeTriggers(dir, data);
    await runner.tick();
    expect((await client.triggers(projectId)).runs[0]).toMatchObject({ trigger: trigger.id, ok: true });
  }, 60_000);

  it("a webhook proves itself with its secret, fills its prompt, and runs a delivery once", async () => {
    const out = await client.addTrigger(projectId, { kind: "webhook", prompt: "CI failed on {{body.branch}} ({{event}})", name: "ci", minIntervalSec: 0 });
    expect(out.secret).toBeTruthy();
    expect(JSON.stringify((await client.triggers(projectId)).triggers)).not.toContain(out.secret!); // shown once
    const url = client.baseUrl + out.path!;
    const body = JSON.stringify({ branch: "main" });
    const sig = "sha256=" + crypto.createHmac("sha256", out.secret!).update(body).digest("hex");
    const post = (headers: Record<string, string>, b = body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: b });
    expect((await post({ "x-hub-signature-256": "sha256=00" })).status).toBe(401);
    expect((await fetch(client.baseUrl + "/api/webhooks/trigger/trg_nope", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404);
    const ok = await post({ "x-hub-signature-256": sig, "x-github-event": "workflow_run", "x-github-delivery": "d-1" });
    expect(await ok.json()).toEqual({ ok: true, note: "queued" });
    const again = await post({ "x-hub-signature-256": sig, "x-github-event": "workflow_run", "x-github-delivery": "d-1" });
    expect(await again.json()).toMatchObject({ ok: false, note: "skipped: already delivered" });
    const chat = (await client.triggers(projectId)).triggers.find((t) => t.id === out.trigger.id)!.chat as string;
    await waitUntil(async () => (await replies(chat)).some((t) => t.includes("CI failed on main (workflow_run)")), 20_000);
  }, 60_000);

  it("only the owner adds a trigger; a bad schedule says why", async () => {
    const pair = await fetch(client.baseUrl + "/api/pair/new", { method: "POST", headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.json()) as { token: string };
    const claim = await fetch(client.baseUrl + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token, name: "phone" }) }).then((r) => r.json()) as { clientToken: string };
    const asPhone = await fetch(`${client.baseUrl}/api/projects/${projectId}/triggers`, { method: "POST", headers: { authorization: `Bearer ${claim.clientToken}`, "content-type": "application/json" }, body: JSON.stringify({ every: "1h", prompt: "x" }) });
    expect(asPhone.status).toBe(403);
    await expect(client.addTrigger(projectId, { kind: "schedule", cron: "99 * * * *", prompt: "x" })).rejects.toThrow(/out of range/);
    await expect(client.addTrigger(projectId, { kind: "schedule", prompt: "x" })).rejects.toThrow(/needs cron or every/);
  }, 30_000);
});
