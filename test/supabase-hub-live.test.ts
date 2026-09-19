/**
 * The hosted Team Hub, live: two throwaway members on the real Supabase
 * project, running the Phase 1–5 flow through SupabaseHubClient — RLS, rule
 * functions and Realtime as they actually behave in production.
 *
 * Opt-in: LOOM_LIVE_SUPABASE=1 plus SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and
 * SUPABASE_SECRET_KEY (the repo's gitignored .env). The secret key is only
 * used for the admin API: creating the two users, and deleting everything
 * this run made in afterAll.
 */

import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HubEvent } from "../src/core/team-hub.js";
import { SupabaseHubClient } from "../src/hub/supabase-client.js";

const URL_ = process.env.SUPABASE_URL ?? "";
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const live = process.env.LOOM_LIVE_SUPABASE === "1" && Boolean(URL_ && PUB && SECRET);

interface Member {
  id: string;
  login: string;
  hub: SupabaseHubClient;
}

const tag = crypto.randomBytes(4).toString("hex");
let admin: SupabaseClient;
const userIds: string[] = [];
const teamIds: string[] = [];
let alice: Member;
let bob: Member;

async function member(name: string): Promise<Member> {
  const login = `loomtest-${tag}-${name}`;
  const email = `${login}@example.com`;
  const password = crypto.randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { user_name: login } });
  if (error || !data.user) throw error ?? new Error("createUser returned no user");
  userIds.push(data.user.id);
  const anon = createClient(URL_, PUB, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await anon.auth.signInWithPassword({ email, password });
  if (s.error || !s.data.session) throw s.error ?? new Error("no session");
  const hub = new SupabaseHubClient({
    supabaseUrl: URL_,
    publishableKey: PUB,
    session: {
      accessToken: s.data.session.access_token,
      refreshToken: s.data.session.refresh_token,
      expiresAt: (s.data.session.expires_at ?? 0) * 1000,
      userId: data.user.id,
    },
  });
  return { id: data.user.id, login, hub };
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  if (!live) return;
  admin = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  alice = await member("alice");
  bob = await member("bob");
}, 60_000);

afterAll(async () => {
  if (!live) return;
  await alice?.hub.close().catch(() => {});
  await bob?.hub.close().catch(() => {});
  // every team our users are in (not just the ones we noted), then the users
  if (userIds.length) {
    const { data } = await admin.from("team_members").select("team_id").in("user_id", userIds);
    for (const r of data ?? []) if (!teamIds.includes(r.team_id as string)) teamIds.push(r.team_id as string);
  }
  if (teamIds.length) {
    const { error } = await admin.from("teams").delete().in("id", teamIds);
    if (error) console.error("cleanup: couldn't delete test teams", error.message);
  }
  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error("cleanup: couldn't delete test user", id, error.message);
  }
  const left = await admin.from("teams").select("id").in("id", teamIds.length ? teamIds : ["00000000-0000-0000-0000-000000000000"]);
  console.log(`live cleanup: ${teamIds.length} team(s) and ${userIds.length} user(s) deleted; ${left.data?.length ?? "?"} team row(s) left`);
}, 60_000);

describe.skipIf(!live)("hosted Team Hub, live (two members through SupabaseHubClient)", () => {
  let team = "";
  let aliceDev = "";
  let bobDev = "";
  const repo = `loomtest/${tag}`;
  const events: HubEvent[] = [];
  let unsub: (() => void) | null = null;
  const sealed = { v: 1, c: "c2VhbGVk" } as never;

  afterAll(() => unsub?.());

  it("signs in: me() reads the profile made from sign-up metadata", async () => {
    expect(await alice.hub.me()).toEqual({ id: alice.id, github: alice.login, name: alice.login });
  });

  it("creates a team, registers devices, and a single-use invite brings the teammate in", async () => {
    const t = await alice.hub.createTeam(`loomtest ${tag}`);
    team = t.id;
    teamIds.push(team);
    expect(t).toMatchObject({ name: `loomtest ${tag}`, keyVersion: 1 });
    expect(t.createdAt).toBeGreaterThan(Date.now() - 120_000);
    aliceDev = (await alice.hub.registerDevice({ label: "mac", sealPub: `sealA-${tag}`, signPub: `signA-${tag}` })).id;
    const bd = await bob.hub.registerDevice({ label: "mbp", sealPub: `sealB-${tag}`, signPub: `signB-${tag}` });
    bobDev = bd.id;
    expect(bd).toMatchObject({ userId: bob.id, label: "mbp", sealPub: `sealB-${tag}` });
    // the same signing key registers the same device
    expect((await bob.hub.registerDevice({ label: "mbp", sealPub: `sealB-${tag}`, signPub: `signB-${tag}` })).id).toBe(bobDev);

    await alice.hub.putKeyEnvelopes(team, 1, [{ deviceId: aliceDev, box: "boxA1" }]);
    const inv = await alice.hub.createInvite(team);
    expect(inv.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const joined = await bob.hub.redeemInvite(inv.invite);
    expect(joined).toMatchObject({ role: "member", team: { id: team, keyVersion: 1 } });
    await expect(bob.hub.redeemInvite(inv.invite)).rejects.toMatchObject({ name: "HubError", status: 403 });

    await bob.hub.putKeyEnvelopes(team, 1, [{ deviceId: bobDev, box: "boxB1" }]);
    expect(await bob.hub.keyEnvelopes(team, bobDev)).toEqual([{ version: 1, box: "boxB1" }]);
    expect(await alice.hub.keyEnvelopes(team, bobDev)).toEqual([]); // nobody reads another's envelope
    await expect(bob.hub.putKeyEnvelopes(team, 2, [{ deviceId: bobDev, box: "x" }])).rejects.toMatchObject({ status: 403 });

    const teams = await bob.hub.teams();
    expect(teams.find((x) => x.id === team)).toMatchObject({ role: "member", name: `loomtest ${tag}` });
    const members = await bob.hub.members(team);
    expect(members.map((m) => `${m.user.github}:${m.role}`)).toEqual([`${alice.login}:owner`, `${bob.login}:member`]);
    expect(members[1]!.devices.map((d) => d.id)).toEqual([bobDev]);
  });

  it("shares a repo, and a teammate's heartbeat and feed arrive live", async () => {
    unsub = await alice.hub.subscribe(team, (e) => events.push(e));
    await alice.hub.shareRepo(team, `https://github.com/${repo}.git`);
    expect(await bob.hub.repos(team)).toEqual([repo]);

    await bob.hub.heartbeat(team, {
      deviceId: bobDev, repo, agent: "codex#t1", kind: "codex", branch: "feat/x", touches: ["src/**"], state: "running", since: Date.now() - 1000, sealed,
    });
    const p = await waitFor("presence event", () => events.find((e) => e.type === "presence"));
    expect(p).toMatchObject({ type: "presence", teamId: team, presence: { userId: bob.id, github: bob.login, agent: "codex#t1", repo, branch: "feat/x", touches: ["src/**"], state: "running" } });
    const list = await alice.hub.presence(team);
    expect(list).toHaveLength(1);
    expect(list[0]!.ts).toBeGreaterThan(Date.now() - 60_000);

    const ev = await bob.hub.appendFeed(team, { type: "goal_started", repo, meta: { runId: "b1" }, sealed, deviceId: bobDev, dedupeKey: `start-${tag}` });
    expect(ev).toMatchObject({ type: "goal_started", teamId: team, userId: bob.id, github: bob.login, repo, dedupeKey: `start-${tag}` });
    expect(await bob.hub.appendFeed(team, { type: "goal_started", repo, meta: {}, dedupeKey: `start-${tag}` })).toBeNull();
    const heard = await waitFor("feed event", () => events.find((e) => e.type === "feed" && e.event.type === "goal_started"));
    expect(heard).toMatchObject({ event: { id: ev!.id, github: bob.login, meta: { runId: "b1" } } });
    const feed = await alice.hub.feed(team);
    expect(feed.map((e) => e.type)).toEqual(["member_joined", "repo_shared", "goal_started"]);
    expect(await alice.hub.feed(team, { since: feed[1]!.id })).toHaveLength(1);
    await expect(alice.hub.appendFeed(team, { type: "member_left", meta: {} })).rejects.toMatchObject({ status: 400 });

    await bob.hub.clearPresence(team, { deviceId: bobDev, agent: "codex#t1", repo });
    await waitFor("presence_gone", () => events.find((e) => e.type === "presence_gone"));
    expect(await alice.hub.presence(team)).toEqual([]);
  }, 60_000);

  it("leases: overlap is advisory, a held hard zone refuses, extend widens, release frees (D29, D31, D33, D36)", async () => {
    const zones = ["db/migrations/**"];
    const a = await alice.hub.claimLease(team, {
      deviceId: aliceDev, repo, runId: "a1", taskId: "t1", globs: ["src/auth/**"], files: ["src/auth/session.ts"], prefixes: ["src/auth/"], hardZones: zones, sealed,
    });
    expect(a.lease).toMatchObject({ runId: "a1", github: alice.login, state: "active", stale: false });
    const b = await bob.hub.claimLease(team, {
      deviceId: bobDev, repo, runId: "b1", taskId: "t1", globs: ["src/auth/session.ts"], files: ["src/auth/session.ts"], prefixes: ["src/auth/session.ts"], hardZones: zones,
    });
    expect(b.lease).toBeTruthy();
    expect(b.overlaps).toEqual([{ lease: expect.objectContaining({ id: a.lease!.id, github: alice.login }), paths: ["src/auth/session.ts"] }]);

    const z = await alice.hub.claimLease(team, {
      deviceId: aliceDev, repo, runId: "a2", taskId: "t1", globs: ["db/migrations/**"], files: [], prefixes: ["db/migrations/"], hardZones: zones,
    });
    const refused = await bob.hub.claimLease(team, {
      deviceId: bobDev, repo, runId: "b2", taskId: "t1", globs: ["db/**"], files: [], prefixes: ["db/"], hardZones: zones,
    });
    expect(refused.lease).toBeNull();
    expect(refused.blockedBy).toMatchObject({ zone: "db/migrations/**", lease: { id: z.lease!.id, github: alice.login } });

    // widening into the held zone refuses; into free ground it lands
    const blocked = await bob.hub.extendLease(team, b.lease!.id, { globs: ["db/**"], files: [], prefixes: ["db/"] }, zones);
    expect(blocked.lease).toBeNull();
    expect(blocked.blockedBy?.zone).toBe("db/migrations/**");
    const wide = await bob.hub.extendLease(team, b.lease!.id, { globs: ["src/api/**"], files: ["src/api/server.ts"], prefixes: ["src/api/"] }, zones);
    expect(wide.lease).toMatchObject({ id: b.lease!.id, globs: ["src/auth/session.ts", "src/api/**"], prefixes: ["src/auth/session.ts", "src/api/"] });
    expect(wide.overlaps).toEqual([]);
    await expect(alice.hub.extendLease(team, b.lease!.id, { globs: ["x/**"], files: [], prefixes: ["x/"] }, zones)).rejects.toMatchObject({ status: 403 });
    await waitFor("the widened lease, live", () =>
      events.find((e) => e.type === "lease" && e.lease.id === b.lease!.id && e.lease.globs.includes("src/api/**")),
    );

    expect(await alice.hub.renewLeases(team, aliceDev)).toBe(2);
    expect(await alice.hub.setRunLeaseState(team, "a1", "landing")).toBe(1);
    expect((await alice.hub.leases(team, repo)).find((l) => l.runId === "a1")?.state).toBe("landing");
    expect(await bob.hub.releaseLeases(team, "a2", "not mine")).toBe(0);
    expect(await alice.hub.releaseLeases(team, "a2", "PR merged")).toBe(1);
    await waitFor("lease_gone", () => events.find((e) => e.type === "lease_gone" && e.leaseIds.includes(z.lease!.id)));
    expect((await bob.hub.claimLease(team, { deviceId: bobDev, repo, runId: "b2", taskId: "t1", globs: ["db/**"], files: [], prefixes: ["db/"], hardZones: zones })).lease).toBeTruthy();
    expect((await alice.hub.leases(team)).map((l) => l.runId).sort()).toEqual(["a1", "b1", "b2"]);
  }, 60_000);

  it("team memories: a twin confirms, resolution supersedes and keeps the loser (D41, D47)", async () => {
    const first = await alice.hub.publishMemory(team, { id: `m1-${tag}`, repo, hmac: `v1:zod-${tag}`, sealed, deviceId: aliceDev });
    expect(first).toMatchObject({ merged: false, memory: { id: `m1-${tag}`, author: alice.login, state: "live", confirmedBy: [alice.login] } });
    const twin = await bob.hub.publishMemory(team, { id: `m9-${tag}`, repo, hmac: `v1:zod-${tag}`, sealed, deviceId: bobDev });
    expect(twin).toMatchObject({ merged: true, memory: { id: `m1-${tag}`, confirmedBy: [alice.login, bob.login] } });
    await expect(bob.hub.forgetTeamMemory(team, `m1-${tag}`, "no")).rejects.toMatchObject({ status: 403 });
    await expect(bob.hub.resolveMemories(team, `m1-${tag}`, "nope-nope", "x")).rejects.toMatchObject({ status: 404 });

    await bob.hub.publishMemory(team, { id: `m2-${tag}`, repo, hmac: `v1:valibot-${tag}`, sealed, deviceId: bobDev, supersedes: `m1-${tag}` });
    const loser = await alice.hub.resolveMemories(team, `m2-${tag}`, `m1-${tag}`, "moved to valibot");
    expect(loser).toMatchObject({ id: `m1-${tag}`, state: "superseded", supersededBy: `m2-${tag}`, resolvedBy: alice.login, resolvedReason: "moved to valibot" });
    const liveMems = await bob.hub.teamMemories(team, repo);
    expect(liveMems.map((m) => m.id)).toEqual([`m2-${tag}`]);
    expect(liveMems[0]!.confirmedBy).toEqual([bob.login, alice.login]);
    expect((await bob.hub.teamMemories(team, repo, { history: true })).map((m) => `${m.id}:${m.state}`).sort()).toEqual([
      `m1-${tag}:superseded`,
      `m2-${tag}:live`,
    ]);
    const upd = await bob.hub.updateTeamMemory(team, `m2-${tag}`, { hmac: `v2:valibot-${tag}`, sealed });
    expect(upd.hmac).toBe(`v2:valibot-${tag}`);
    await waitFor("memory events", () => events.find((e) => e.type === "memory" && e.memory.id === `m1-${tag}` && e.memory.state === "superseded"));
    expect(events.some((e) => e.type === "feed" && e.event.type === "memory_resolved")).toBe(true);
  }, 60_000);

  it("runners and jobs: register, target, claim, heartbeat, finish, cancel, revoke — heard live (D67–D74)", async () => {
    const bobRunner = (await bob.hub.registerDevice({ label: "box", sealPub: `sealBR-${tag}`, signPub: `signBR-${tag}` })).id;
    const r = await bob.hub.registerRunner({ deviceId: bobRunner, kinds: ["codex", "claude", "codex"], shared: false, capacity: 20 });
    expect(r).toMatchObject({ deviceId: bobRunner, userId: bob.id, github: bob.login, label: "box", kinds: ["codex", "claude"], shared: false, capacity: 8 });
    expect(r.lastSeen).toBeGreaterThan(Date.now() - 120_000);
    await expect(alice.hub.registerRunner({ deviceId: bobRunner, kinds: [], shared: true })).rejects.toMatchObject({ status: 403 });
    expect((await alice.hub.runners(team)).map((x) => x.deviceId)).toEqual([bobRunner]);

    // a personal runner: alice can't aim at it, and it won't take her goals
    await expect(alice.hub.createJob(team, { repo, kind: "start", sealed, deviceId: aliceDev, target: bobRunner })).rejects.toMatchObject({ status: 403 });
    const hers = await alice.hub.createJob(team, { repo, kind: "start", sealed, deviceId: aliceDev });
    expect(hers).toMatchObject({ teamId: team, repo, kind: "start", userId: alice.id, github: alice.login, state: "queued", sealed });
    expect(hers.target).toBeUndefined();
    expect(hers.runnerId).toBeUndefined();
    expect(await bob.hub.claimJob(team, bobRunner)).toBeNull();
    await expect(bob.hub.createJob(team, { repo, kind: "deploy" as never, sealed, deviceId: bobDev })).rejects.toMatchObject({ status: 400 });

    const his = await bob.hub.createJob(team, { repo, kind: "land", sealed, deviceId: bobDev, target: bobRunner });
    const got = await bob.hub.claimJob(team, bobRunner);
    expect(got).toMatchObject({ id: his.id, state: "claimed", runnerId: bobRunner, runnerGithub: bob.login, target: bobRunner });
    expect(got!.heartbeatAt).toBeGreaterThan(Date.now() - 120_000);
    await expect(alice.hub.heartbeatJob(team, his.id, aliceDev)).rejects.toMatchObject({ status: 409 });
    const beat = await bob.hub.heartbeatJob(team, his.id, bobRunner, { v: 1, c: "cHJvZ3Jlc3M" } as never);
    expect(beat.progress).toEqual({ v: 1, c: "cHJvZ3Jlc3M" });
    const done = await bob.hub.finishJob(team, his.id, bobRunner, { state: "done", result: sealed });
    expect(done).toMatchObject({ state: "done", result: sealed });
    expect(done.error).toBeUndefined();
    await expect(bob.hub.finishJob(team, his.id, bobRunner, { state: "done" })).rejects.toMatchObject({ status: 409 });
    const heard = await waitFor("job done, live", () =>
      events.find((e) => e.type === "job" && e.job.id === his.id && e.job.state === "done"),
    );
    expect(heard).toMatchObject({ type: "job", teamId: team, job: { runnerGithub: bob.login, github: bob.login, kind: "land" } });
    expect(typeof (heard as { job: { updatedAt: number } }).job.updatedAt).toBe("number");

    // a shared runner takes a teammate's goal; only its author cancels it
    await bob.hub.registerRunner({ deviceId: bobRunner, kinds: ["codex"], shared: true });
    expect((await bob.hub.claimJob(team, bobRunner))!.id).toBe(hers.id);
    await expect(bob.hub.cancelJob(team, hers.id)).rejects.toMatchObject({ status: 403 });
    expect((await alice.hub.cancelJob(team, hers.id)).state).toBe("cancelled");
    await expect(bob.hub.heartbeatJob(team, hers.id, bobRunner)).rejects.toMatchObject({ status: 409 });
    expect(await alice.hub.jobs(team, { active: true })).toEqual([]);
    expect((await alice.hub.jobs(team)).map((j) => `${j.kind}:${j.state}`)).toEqual(["start:cancelled", "land:done"]);
    await waitFor("job cancelled, live", () => events.find((e) => e.type === "job" && e.job.id === hers.id && e.job.state === "cancelled"));

    for (const t of ["goal_moved", "deploy_started", "deploy_succeeded", "deploy_failed"] as const) {
      expect(await bob.hub.appendFeed(team, { type: t, repo, meta: { n: 1 } })).toMatchObject({ type: t });
    }

    await expect(alice.hub.revokeDevice(bobRunner)).rejects.toMatchObject({ status: 403 });
    await bob.hub.revokeDevice(bobRunner);
    expect(await alice.hub.runners(team)).toEqual([]);
    expect((await alice.hub.members(team)).find((m) => m.user.id === bob.id)!.devices.map((d) => d.id)).toEqual([bobDev]);
  }, 60_000);

  it("a member can leave; a non-member can't read or subscribe", async () => {
    await bob.hub.removeMember(team, bob.id);
    await expect(bob.hub.members(team)).rejects.toMatchObject({ status: 403 });
    await expect(bob.hub.subscribe(team, () => {})).rejects.toMatchObject({ status: 403 });
    expect(await bob.hub.feed(team)).toEqual([]); // RLS: nothing to see
    await waitFor("member_left, live", () => events.find((e) => e.type === "feed" && e.event.type === "member_left"));
  }, 60_000);
});
