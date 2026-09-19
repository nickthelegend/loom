/**
 * Loom Teams, Phase 5 — runners and the job queue on the hub (D67–D78).
 *
 * The same scenarios twice: against MemoryHub (the reference) and over a real
 * `loom hub` HTTP + WebSocket server through HttpHubClient. Both run on a
 * MemoryHub with an injectable clock, so a runner going quiet for ten minutes
 * (JOB_TTL_MS) is a clock move, not a wait.
 *
 * The hosted hub's SQL is tested on the same rules in test/supabase-sql.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JOB_TTL_MS, MemoryHub, type HubClient, type HubEvent, type Job } from "../src/core/team-hub.js";
import { HttpHubClient, hubSignIn } from "../src/hub/client.js";
import { startHubServer } from "../src/hub/server.js";

interface Setup {
  alice: HubClient;
  bob: HubClient;
  carol: HubClient;
  advance: (ms: number) => void;
  /** Resolves once a fresh subscription is known to be live. */
  settle: (c: HubClient, teamId: string, events: HubEvent[]) => Promise<void>;
  close: () => Promise<void>;
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function memorySetup(): Promise<Setup> {
  let clock = 1_000_000;
  const hub = new MemoryHub(() => clock);
  return {
    alice: hub.client(hub.signIn("alice").token),
    bob: hub.client(hub.signIn("bob").token),
    carol: hub.client(hub.signIn("carol").token),
    advance: (ms) => void (clock += ms),
    settle: async () => {},
    close: async () => {},
  };
}

async function httpSetup(): Promise<Setup> {
  let clock = 1_000_000;
  const server = await startHubServer({ port: 0, secret: "p5", hub: new MemoryHub(() => clock) });
  const client = async (github: string) => new HttpHubClient(server.url, (await hubSignIn(server.url, github, { secret: "p5" })).token);
  return {
    alice: await client("alice"),
    bob: await client("bob"),
    carol: await client("carol"),
    advance: (ms) => void (clock += ms),
    // the WebSocket registers its listener after the upgrade: post until one is heard
    settle: async (c, teamId, events) => {
      const deadline = Date.now() + 5_000;
      while (!events.some((e) => e.type === "feed" && e.event.meta.probe === true)) {
        if (Date.now() > deadline) throw new Error("the subscription never went live");
        await c.appendFeed(teamId, { type: "goal_moved", meta: { probe: true } });
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () => server.close(),
  };
}

const sealed = { v: 1, c: "c2VhbGVk" };

for (const [name, make] of [
  ["MemoryHub", memorySetup],
  ["loom hub over HTTP", httpSetup],
] as const) {
  describe(`runners and jobs — ${name}`, () => {
    let s: Setup;
    let team = "";
    let aliceDev = "";
    let bobDev = "";
    let aliceRunner = "";
    let bobRunner = "";
    const repo = "acme/app";
    const events: HubEvent[] = [];
    let unsub: (() => void) | null = null;
    const newJob = (c: HubClient, dev: string, extra: Partial<Parameters<HubClient["createJob"]>[1]> = {}) =>
      c.createJob(team, { repo, kind: "start", sealed, deviceId: dev, ...extra });
    /** Cancel whatever is still open, so each case starts from an empty queue. */
    const drain = async () => {
      for (const j of await s.alice.jobs(team, { active: true })) {
        await (j.userId === (await s.alice.me()).id ? s.alice : s.bob).cancelJob(team, j.id);
      }
    };

    beforeAll(async () => {
      s = await make();
      team = (await s.alice.createTeam("Acme")).id;
      aliceDev = (await s.alice.registerDevice({ label: "mac", sealPub: "sa", signPub: "ga" })).id;
      aliceRunner = (await s.alice.registerDevice({ label: "vps", sealPub: "sar", signPub: "gar" })).id;
      bobDev = (await s.bob.registerDevice({ label: "mbp", sealPub: "sb", signPub: "gb" })).id;
      bobRunner = (await s.bob.registerDevice({ label: "box", sealPub: "sbr", signPub: "gbr" })).id;
      await s.carol.registerDevice({ label: "c", sealPub: "sc", signPub: "gc" });
      const { invite } = await s.alice.createInvite(team);
      await s.bob.redeemInvite(invite);
      await s.alice.shareRepo(team, repo);
      unsub = await s.alice.subscribe(team, (e) => events.push(e));
      await s.settle(s.bob, team, events);
    });

    afterAll(async () => {
      unsub?.();
      await s?.close();
    });

    it("registers a runner on your own device, visible to teammates only", async () => {
      const r = await s.alice.registerRunner({ deviceId: aliceRunner, kinds: ["codex", "claude", "codex"], shared: false, capacity: 20 });
      expect(r).toMatchObject({ deviceId: aliceRunner, github: "alice", label: "vps", kinds: ["codex", "claude"], shared: false, capacity: 8 });
      await expect(s.bob.registerRunner({ deviceId: aliceRunner, kinds: [], shared: true })).rejects.toMatchObject({ status: 403 });
      expect((await s.bob.registerRunner({ deviceId: bobRunner, kinds: ["codex"], shared: false })).capacity).toBe(1);
      expect((await s.bob.runners(team)).map((x) => x.github).sort()).toEqual(["alice", "bob"]);
      await expect(s.carol.runners(team)).rejects.toMatchObject({ status: 403 });
    });

    it("refuses a job without a shared repo, your device, a real kind, a sealed payload or an allowed target", async () => {
      await expect(newJob(s.bob, bobDev, { repo: "acme/other" })).rejects.toMatchObject({ status: 403 });
      await expect(newJob(s.bob, aliceDev)).rejects.toMatchObject({ status: 403 });
      await expect(newJob(s.bob, bobDev, { kind: "deploy" as never })).rejects.toMatchObject({ status: 400 });
      await expect(newJob(s.bob, bobDev, { sealed: { v: 1, c: "" } })).rejects.toMatchObject({ status: 400 });
      await expect(newJob(s.carol, bobDev)).rejects.toMatchObject({ status: 403 });
      await expect(newJob(s.bob, bobDev, { target: aliceRunner })).rejects.toMatchObject({ status: 403 }); // personal runner
      await expect(newJob(s.bob, bobDev, { target: "nope" })).rejects.toMatchObject({ status: 404 });
      const j = await newJob(s.bob, bobDev, { kind: "land", target: bobRunner });
      expect(j).toMatchObject({ kind: "land", state: "queued", github: "bob", target: bobRunner, repo });
      expect(j.runnerId).toBeUndefined();
      await drain();
    });

    it("eligibility: own jobs, anyone's when shared, a targeted job only for its runner (D68)", async () => {
      const bobs = await newJob(s.bob, bobDev);
      expect(await s.alice.claimJob(team, aliceRunner)).toBeNull(); // personal runner, bob's goal
      await expect(s.alice.claimJob(team, bobRunner)).rejects.toMatchObject({ status: 403 });
      await expect(s.alice.claimJob(team, aliceDev)).rejects.toMatchObject({ status: 403 }); // not a runner
      await s.alice.registerRunner({ deviceId: aliceRunner, kinds: ["codex"], shared: true, capacity: 2 });
      const got = await s.alice.claimJob(team, aliceRunner);
      expect(got).toMatchObject({ id: bobs.id, state: "claimed", runnerId: aliceRunner, runnerGithub: "alice" });
      expect(got!.claimedAt).toBe(got!.heartbeatAt);

      const targeted = await newJob(s.bob, bobDev, { target: aliceRunner }); // allowed: now shared
      expect(await s.bob.claimJob(team, bobRunner)).toBeNull();
      expect((await s.alice.claimJob(team, aliceRunner))!.id).toBe(targeted.id);

      const first = await newJob(s.bob, bobDev);
      s.advance(1);
      await newJob(s.bob, bobDev);
      expect((await s.bob.claimJob(team, bobRunner))!.id).toBe(first.id); // oldest first
      await drain();
    });

    it("claims are atomic: two runners at once, one job, one winner", async () => {
      await s.bob.registerRunner({ deviceId: bobRunner, kinds: ["codex"], shared: true });
      const j = await newJob(s.alice, aliceDev);
      const got = await Promise.all([s.alice.claimJob(team, aliceRunner), s.bob.claimJob(team, bobRunner)]);
      expect(got.filter((x) => x?.id === j.id)).toHaveLength(1);
      expect(got.filter((x) => x === null)).toHaveLength(1);
      await drain();
    });

    it("only the holder heartbeats and finishes (409); a silent claim is claimable again (D12, D71)", async () => {
      const j = await newJob(s.alice, aliceDev);
      expect((await s.alice.claimJob(team, aliceRunner))!.id).toBe(j.id);
      await expect(s.bob.heartbeatJob(team, j.id, bobRunner)).rejects.toMatchObject({ status: 409 });
      await expect(s.bob.heartbeatJob(team, j.id, aliceRunner)).rejects.toMatchObject({ status: 403 });
      await expect(s.alice.heartbeatJob(team, "j_nope", aliceRunner)).rejects.toMatchObject({ status: 404 });
      s.advance(JOB_TTL_MS - 1);
      const beat = await s.alice.heartbeatJob(team, j.id, aliceRunner, { v: 1, c: "cHJvZ3Jlc3M" });
      expect(beat.progress).toEqual({ v: 1, c: "cHJvZ3Jlc3M" });
      s.advance(JOB_TTL_MS); // exactly the TTL: still held
      expect(await s.bob.claimJob(team, bobRunner)).toBeNull();
      s.advance(1); // one past: bob's shared runner takes it over
      const taken = await s.bob.claimJob(team, bobRunner);
      expect(taken).toMatchObject({ id: j.id, runnerId: bobRunner, runnerGithub: "bob", progress: { v: 1, c: "cHJvZ3Jlc3M" } });
      await expect(s.alice.heartbeatJob(team, j.id, aliceRunner)).rejects.toMatchObject({ status: 409 }); // lost it
      await expect(s.bob.finishJob(team, j.id, bobRunner, { state: "cancelled" as never })).rejects.toMatchObject({ status: 400 });
      const done = await s.bob.finishJob(team, j.id, bobRunner, { state: "done", result: { v: 1, c: "cmVzdWx0" } });
      expect(done).toMatchObject({ state: "done", result: { v: 1, c: "cmVzdWx0" } });
      expect(done.error).toBeUndefined();
      await expect(s.bob.finishJob(team, j.id, bobRunner, { state: "done" })).rejects.toMatchObject({ status: 409 });
      expect((await s.alice.cancelJob(team, j.id)).state).toBe("done"); // finished stays finished

      const f = await newJob(s.alice, aliceDev);
      await s.alice.claimJob(team, aliceRunner);
      const failed = await s.alice.finishJob(team, f.id, aliceRunner, { state: "failed", error: "x".repeat(600) });
      expect(failed.state).toBe("failed");
      expect(failed.error).toHaveLength(500);
    });

    it("only the author cancels; a cancelled job stops its runner", async () => {
      const j = await newJob(s.bob, bobDev);
      await expect(s.alice.cancelJob(team, j.id)).rejects.toMatchObject({ status: 403 });
      expect((await s.bob.claimJob(team, bobRunner))!.id).toBe(j.id);
      expect((await s.bob.cancelJob(team, j.id)).state).toBe("cancelled");
      await expect(s.bob.heartbeatJob(team, j.id, bobRunner)).rejects.toMatchObject({ status: 409 });
      expect(await s.alice.jobs(team, { active: true })).toEqual([]);
      const all = await s.alice.jobs(team);
      expect(all.length).toBeGreaterThan(5);
      expect(all.map((x) => x.createdAt)).toEqual([...all.map((x) => x.createdAt)].sort((a, b) => a - b));
      await expect(s.carol.jobs(team)).rejects.toMatchObject({ status: 403 });
    });

    it("job events reach subscribers, every state change", async () => {
      const j = await newJob(s.bob, bobDev);
      await s.bob.claimJob(team, bobRunner);
      await s.bob.heartbeatJob(team, j.id, bobRunner);
      await s.bob.finishJob(team, j.id, bobRunner, { state: "done" });
      const states = await waitFor("job events", () => {
        const seen = events.filter((e): e is Extract<HubEvent, { type: "job" }> => e.type === "job" && e.job.id === j.id).map((e) => e.job.state);
        return seen.length >= 4 && seen;
      });
      expect(states).toEqual(["queued", "claimed", "claimed", "done"]);
      const last = events.filter((e) => e.type === "job").pop() as { job: Job };
      expect(last.job).toMatchObject({ teamId: team, runnerGithub: "bob", sealed });
    });

    it("revoking a device removes it, its runner record and its envelopes — your own only (D74)", async () => {
      await s.bob.putKeyEnvelopes(team, 1, [{ deviceId: bobRunner, box: "br1" }]);
      await expect(s.alice.revokeDevice(bobRunner)).rejects.toMatchObject({ status: 403 });
      await s.bob.revokeDevice(bobRunner);
      expect((await s.alice.runners(team)).map((r) => r.deviceId)).toEqual([aliceRunner]);
      expect((await s.bob.members(team)).find((m) => m.user.github === "bob")!.devices.map((d) => d.id)).toEqual([bobDev]);
      await expect(s.bob.keyEnvelopes(team, bobRunner)).rejects.toMatchObject({ status: 403 }); // gone, envelopes and all
      await expect(s.bob.claimJob(team, bobRunner)).rejects.toMatchObject({ status: 403 });
      await expect(s.bob.revokeDevice(bobRunner)).rejects.toMatchObject({ status: 403 });
    });
  });
}
