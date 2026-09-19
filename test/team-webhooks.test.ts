/**
 * Phase 6 (D83): `loom hub` receives GitHub repo webhooks over real HTTP —
 * POST /github/webhook/:teamId, verified with the team's secret, mapped and
 * appended as system events for shared repos, heard by subscribers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signGithubBody } from "../src/core/github-events.js";
import type { HubEvent } from "../src/core/team-hub.js";
import { HttpHubClient, hubSignIn } from "../src/hub/client.js";
import { startHubServer } from "../src/hub/server.js";
import { waitUntil } from "./helpers.js";

let hub: Awaited<ReturnType<typeof startHubServer>>;
let alice: HttpHubClient;
let bob: HttpHubClient;
let teamId = "";
let secret = "";

const SHA = "b".repeat(40);
const checkRun = (repo: string, n: number, conclusion = "failure") =>
  JSON.stringify({
    action: "completed",
    repository: { full_name: repo },
    check_run: { name: "test", conclusion, head_sha: SHA, pull_requests: [{ number: n, head: { ref: "loom/orchestra/o9/main", sha: SHA } }] },
  });

async function deliver(team: string, event: string, body: string, sig?: string | null) {
  const res = await fetch(`${hub.url}/github/webhook/${team}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, ...(sig ? { "x-hub-signature-256": sig } : {}) },
    body,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  hub = await startHubServer({ port: 0, secret: "join" });
  const a = await hubSignIn(hub.url, "alice", { secret: "join" });
  const b = await hubSignIn(hub.url, "bob", { secret: "join" });
  alice = new HttpHubClient(hub.url, a.token);
  bob = new HttpHubClient(hub.url, b.token);
  teamId = (await alice.createTeam("Acme")).id;
  await bob.redeemInvite((await alice.createInvite(teamId)).invite);
  await alice.shareRepo(teamId, "acme/app");
});

afterAll(async () => {
  await hub.close();
});

describe("loom hub: POST /github/webhook/:teamId (D83)", () => {
  it("has no webhook until the owner asks for its secret; members can't", async () => {
    const body = checkRun("acme/app", 7);
    expect((await deliver(teamId, "check_run", body, await signGithubBody("x", body))).status).toBe(404);
    await expect(bob.webhookSecret(teamId)).rejects.toThrow(/needs owner/);
    secret = (await alice.webhookSecret(teamId)).secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await deliver("t_nope", "check_run", body, await signGithubBody(secret, body))).status).toBe(404);
  });

  it("refuses a missing, wrong or replayed-onto-another-body signature (401)", async () => {
    const body = checkRun("acme/app", 7);
    expect((await deliver(teamId, "check_run", body, null)).status).toBe(401);
    expect((await deliver(teamId, "check_run", body, await signGithubBody("not-the-secret", body))).status).toBe(401);
    const sig = await signGithubBody(secret, body);
    expect((await deliver(teamId, "check_run", checkRun("acme/app", 8), sig)).status).toBe(401);
    expect((await alice.feed(teamId)).some((e) => e.type === "check_failed")).toBe(false);
  });

  it("acks ping", async () => {
    const r = await deliver(teamId, "ping", '{"zen":"Keep it logically awesome."}', await signGithubBody(secret, '{"zen":"Keep it logically awesome."}'));
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("appends a verified delivery as a system event that subscribers hear; a redelivery or a poll of the same fact adds nothing", async () => {
    const heard: HubEvent[] = [];
    const unsub = await bob.subscribe(teamId, (e) => heard.push(e));
    await new Promise((r) => setTimeout(r, 100));
    const body = checkRun("Acme/App", 7);
    const sig = await signGithubBody(secret, body);
    const r = await deliver(teamId, "check_run", body, sig);
    expect(r).toMatchObject({ status: 202, body: { accepted: 1 } });
    await waitUntil(() => heard.some((e) => e.type === "feed" && e.event.type === "check_failed"));
    const ev = (await bob.feed(teamId)).find((e) => e.type === "check_failed")!;
    expect(ev).toMatchObject({ userId: null, github: null, repo: "acme/app", meta: { number: 7, checks: ["test"] } });
    // GitHub redelivers; a daemon's poll reports the same failure
    expect((await deliver(teamId, "check_run", body, sig)).body).toEqual({ accepted: 0 });
    expect(await bob.appendFeed(teamId, { repo: "acme/app", type: "check_failed", meta: {}, dedupeKey: ev.dedupeKey! })).toBeNull();
    unsub();
  });

  it("drops events for repos the team doesn't share", async () => {
    const body = checkRun("acme/secret-thing", 3);
    expect((await deliver(teamId, "check_run", body, await signGithubBody(secret, body))).body).toEqual({ accepted: 0 });
  });

  it("rotating the secret retires the old one", async () => {
    const old = secret;
    secret = (await alice.webhookSecret(teamId, true)).secret;
    const body = checkRun("acme/app", 11);
    expect((await deliver(teamId, "check_run", body, await signGithubBody(old, body))).status).toBe(401);
    expect((await deliver(teamId, "check_run", body, await signGithubBody(secret, body))).status).toBe(202);
  });
});
