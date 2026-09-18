/**
 * Loom Teams, Phase 1 — "see each other".
 *
 * Three layers, each against the real thing below it:
 *   1. the cryptography (team key, sealed boxes, signatures, invites)
 *   2. the hub's rules (MemoryHub — the reference every hub implements)
 *   3. two members end to end: two Team Links, each with its own clone of one
 *      GitHub repo, meeting on a real `loom hub` server over HTTP + WebSocket —
 *      invite, join, share, presence (sealed intent decrypted), the goal feed,
 *      and removal with forward key rotation.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalJson,
  newDeviceKeys,
  newTeamKey,
  openFromTeam,
  openTeamKey,
  packInvite,
  sealForTeam,
  sealTeamKey,
  signPayload,
  unpackInvite,
  verifyPayload,
} from "../src/core/team-crypto.js";
import { HubError, MemoryHub, normalizeRepo, PRESENCE_TTL_MS } from "../src/core/team-hub.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { githubFeedEvents, TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { tmpDir, waitUntil } from "./helpers.js";

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-team");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("team crypto", () => {
  it("seals content to the team; other keys and tampering read as null", () => {
    const k1 = newTeamKey(1);
    const sealed = sealForTeam(k1, { goal: "add oauth" });
    expect(sealed.v).toBe(1);
    expect(JSON.stringify(sealed)).not.toContain("oauth");
    expect(openFromTeam([k1], sealed)).toEqual({ goal: "add oauth" });
    expect(openFromTeam([newTeamKey(1)], sealed)).toBeNull();
    expect(openFromTeam([newTeamKey(2)], sealed)).toBeNull(); // no key of that version
    const flipped = { ...sealed, c: sealed.c.slice(0, -2) + (sealed.c.endsWith("A") ? "BB" : "AA") };
    expect(openFromTeam([k1], flipped)).toBeNull();
  });

  it("seals a team key to one device only", () => {
    const alice = newDeviceKeys();
    const bob = newDeviceKeys();
    const key = newTeamKey(3);
    const box = sealTeamKey(alice.sealPub, key);
    expect(openTeamKey(alice, box)).toEqual(key);
    expect(openTeamKey(bob, box)).toBeNull();
  });

  it("signs canonical JSON, so key order doesn't matter and tampering does", () => {
    const d = newDeviceKeys();
    const sig = signPayload(d, { b: 1, a: [2, { d: 3, c: 4 }] });
    expect(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(verifyPayload(d.signPub, { a: [2, { c: 4, d: 3 }], b: 1 }, sig)).toBe(true);
    expect(verifyPayload(d.signPub, { a: [2, { c: 4, d: 3 }], b: 2 }, sig)).toBe(false);
    expect(verifyPayload(newDeviceKeys().signPub, { b: 1, a: [2, { d: 3, c: 4 }] }, sig)).toBe(false);
  });

  it("round-trips an invite fragment and rejects junk", () => {
    const f = { invite: "abc", key: newTeamKey(1), hub: "http://127.0.0.1:7430" };
    expect(unpackInvite(packInvite(f))).toEqual(f);
    expect(unpackInvite("not-an-invite")).toBeNull();
  });
});

describe("hub rules (MemoryHub)", () => {
  function setup() {
    let t = 1_000_000;
    const hub = new MemoryHub(() => t);
    const a = hub.client(hub.signIn("alice").token);
    const b = hub.client(hub.signIn("bob").token);
    return { hub, a, b, advance: (ms: number) => (t += ms) };
  }

  it("normalizes repos and rejects non-GitHub ones", () => {
    expect(normalizeRepo("git@github.com:Acme/App.git")).toBe("acme/app");
    expect(normalizeRepo("https://github.com/acme/app/")).toBe("acme/app");
    expect(() => normalizeRepo("not a repo")).toThrow(HubError);
  });

  it("invites are single-use and expire; members can't do owner things", async () => {
    const { a, b, advance } = setup();
    const team = await a.createTeam("acme");
    const { invite } = await a.createInvite(team.id, 60_000);
    await b.redeemInvite(invite);
    await expect(b.redeemInvite(invite)).rejects.toThrow(/used/);
    const late = await a.createInvite(team.id, 60_000);
    advance(61_000);
    await expect(b.redeemInvite(late.invite)).rejects.toThrow(/expired/);
    const alice = (await a.me()).id;
    await expect(b.removeMember(team.id, alice)).rejects.toThrow(/owner/);
    await expect(a.removeMember(team.id, alice)).rejects.toThrow(/last owner/);
  });

  it("presence needs a shared repo, a registered device, and expires", async () => {
    const { a, b, advance } = setup();
    const team = await a.createTeam("acme");
    await b.redeemInvite((await a.createInvite(team.id)).invite);
    const dev = await b.registerDevice({ label: "laptop", sealPub: "s", signPub: "p" });
    const beat = { deviceId: dev.id, repo: "acme/app", agent: "codex", kind: "codex", touches: ["src/**"], state: "running" as const, since: 0 };
    await expect(b.heartbeat(team.id, beat)).rejects.toThrow(/isn't shared/);
    await a.shareRepo(team.id, "acme/app");
    await expect(a.heartbeat(team.id, beat)).rejects.toThrow(/isn't yours/);
    await b.heartbeat(team.id, beat);
    expect((await a.presence(team.id)).map((p) => [p.github, p.agent, p.touches])).toEqual([["bob", "codex", ["src/**"]]]);
    advance(PRESENCE_TTL_MS + 1);
    expect(await a.presence(team.id)).toEqual([]);
  });

  it("key versions only move forward, rotation is an owner act", async () => {
    const { a, b } = setup();
    const team = await a.createTeam("acme");
    await b.redeemInvite((await a.createInvite(team.id)).invite);
    const da = await a.registerDevice({ label: "a", sealPub: "s1", signPub: "p1" });
    const db = await b.registerDevice({ label: "b", sealPub: "s2", signPub: "p2" });
    await b.putKeyEnvelopes(team.id, 1, [{ deviceId: db.id, box: "x" }]); // re-seal current: any member
    await expect(b.putKeyEnvelopes(team.id, 2, [{ deviceId: db.id, box: "y" }])).rejects.toThrow(/owner/);
    await a.putKeyEnvelopes(team.id, 2, [{ deviceId: da.id, box: "z" }, { deviceId: db.id, box: "w" }]);
    await expect(a.putKeyEnvelopes(team.id, 1, [{ deviceId: da.id, box: "old" }])).rejects.toThrow(/stale/);
    expect((await b.keyEnvelopes(team.id, db.id)).map((e) => e.version)).toEqual([1, 2]);
    await expect(a.keyEnvelopes(team.id, db.id)).rejects.toThrow(/isn't yours/);
  });

  it("dedupes feed events, and a removed member stops hearing the team", async () => {
    const { a, b } = setup();
    const team = await a.createTeam("acme");
    await b.redeemInvite((await a.createInvite(team.id)).invite);
    const heard: string[] = [];
    await b.subscribe(team.id, (e) => heard.push(e.type === "feed" ? e.event.type : e.type));
    expect(await a.appendFeed(team.id, { type: "pr_opened", meta: { n: 1 }, dedupeKey: "gh:1" })).toBeTruthy();
    expect(await a.appendFeed(team.id, { type: "pr_opened", meta: { n: 1 }, dedupeKey: "gh:1" })).toBeNull();
    await a.removeMember(team.id, (await b.me()).id);
    await a.appendFeed(team.id, { type: "pr_merged", meta: { n: 1 } });
    // they hear their own removal — so their daemon can drop the team — and nothing after
    expect(heard).toEqual(["pr_opened", "member_left"]);
    await expect(b.feed(team.id)).rejects.toThrow(/not a member/);
  });
});

describe("GitHub fallback feed", () => {
  it("turns a gh pr row into idempotent PR and check events", () => {
    const evs = githubFeedEvents("acme/app", {
      number: 7, state: "OPEN", headRefName: "loom/orchestra/o1/main", url: "u", author: { login: "alice" },
      statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
    });
    expect(evs.map((e) => e.type)).toEqual(["pr_opened", "check_failed"]);
    expect(evs[1]!.meta).toMatchObject({ number: 7, loom: true, checks: ["test"] });
    expect(evs.every((e) => e.dedupeKey?.startsWith("gh:acme/app#7"))).toBe(true);
  });
});

describe("two members, one repo, a real hub", () => {
  let hub: Awaited<ReturnType<typeof startHubServer>>;
  let origin: string;
  const members: Array<{ link: TeamLink; rt: ProjectRuntime; dir: string }> = [];
  const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

  async function member(name: string) {
    const dir = tmpDir(`team-${name}`);
    git(path.dirname(dir), "clone", "-q", origin, dir);
    git(dir, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    git(dir, "config", "user.email", `${name}@t`);
    git(dir, "config", "user.name", name);
    writeProjectConfig(dir, {
      name: `app-${name}`,
      agents: [{ id: "alpha", kind: "echo", role: "worker" }, { id: "conductor", kind: "echo", role: "o" }],
      brain: { extractor: "off" },
    });
    const rt = await ProjectRuntime.open({ id: `p-${name}`, name: `app-${name}`, dir });
    const frames: Array<Record<string, unknown>> = [];
    const link = new TeamLink({
      runtimes: () => [rt],
      broadcast: (f) => frames.push(f),
      statePath: path.join(tmpDir(`teamstate-${name}`), "team.json"),
    });
    const m = { link, rt, dir, frames };
    members.push(m);
    return m;
  }

  beforeAll(async () => {
    hub = await startHubServer({ port: 0, secret: "s3cret" });
    origin = tmpDir("team-origin");
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "README.md"), "# app\n");
    fs.writeFileSync(path.join(origin, ".gitignore"), ".loom/\n");
    git(origin, "add", "-A");
    git(origin, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "seed");
  });

  afterAll(async () => {
    for (const m of members) {
      await m.link.stop();
      await m.rt.close();
    }
    await hub.close();
  });

  it("invites made over HTTP last the default 24 hours, not the 1-minute floor", async () => {
    const { hubSignIn, HttpHubClient } = await import("../src/hub/client.js");
    const { token } = await hubSignIn(hub.url, "erin", { secret: "s3cret" });
    const c = new HttpHubClient(hub.url, token);
    const team = await c.createTeam("ttl");
    const { expiresAt } = await c.createInvite(team.id);
    expect(expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    expect(hub.hub.client(token)).toBeTruthy();
    const direct = await hub.hub.client(token).createInvite(team.id, null as unknown as number);
    expect(direct.expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
  });

  it("refuses sign-in without the hub's join secret", async () => {
    const m = await member("mallory");
    await expect(m.link.signIn(hub.url, { github: "mallory", secret: "nope" })).rejects.toThrow(/join secret/);
  });

  it("alice creates a team, invites bob, bob joins; both see each other's work, sealed", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    await alice.link.signIn(hub.url, { github: "alice", secret: "s3cret" });
    const team = await alice.link.createTeam("Acme");
    await alice.link.share(alice.rt, team.id);
    const { link } = await alice.link.invite(team.id);
    expect(link).toMatch(/^loom:\/\/team\/join#/);

    // bob's daemon signs in from the link's hub; the key comes from the fragment
    await bob.link.join(link, { github: "bob", secret: "s3cret" });
    let st = bob.link.status() as { teams: Array<{ name: string; repos: string[]; members: Array<{ github: string }> }> };
    expect(st.teams[0]!.name).toBe("Acme");
    expect(st.teams[0]!.members.map((m) => m.github).sort()).toEqual(["alice", "bob"]);
    // D8: bob never clicked Share — his clone's remote matches the team repo
    expect(st.teams[0]!.repos).toEqual(["acme/app"]);

    // alice runs an orchestra; bob sees its orchestrator and task, titles decrypted
    const run = await alice.rt.orchestra.start({ goal: "Add OAuth login", orchestrator: "conductor", workers: ["alpha"] });
    await alice.link.beat();
    await waitUntil(() => {
      const t = (bob.link.status() as { teams: Array<{ presence: Array<{ github: string; intent: { goal?: string } | null }> }> }).teams[0]!;
      return t.presence.some((p) => p.github === "alice" && p.intent?.goal === "Add OAuth login");
    });
    // the hub itself only ever held ciphertext for the goal
    const raw = await hub.hub.client(hub.hub.signIn("alice").token).presence(team.id);
    expect(JSON.stringify(raw)).not.toContain("OAuth");
    expect(raw[0]!.sealed?.c).toBeTruthy();

    // the goal also landed on the feed, with its title sealed
    await waitUntil(() => {
      const t = (bob.link.status() as { teams: Array<{ feed: Array<{ type: string; content: { goal?: string } | null }> }> }).teams[0]!;
      return t.feed.some((e) => e.type === "goal_started" && e.content?.goal === "Add OAuth login");
    });
    await alice.rt.orchestra.abort(run.id);

    // a session that ends disappears for teammates without waiting out the TTL
    await alice.link.beat();
    await waitUntil(() => {
      const t = (bob.link.status() as { teams: Array<{ presence: Array<{ github: string }> }> }).teams[0]!;
      return !t.presence.some((p) => p.github === "alice");
    });

    // removal rotates the key forward: alice keeps reading, bob can't read what's new
    const bobId = (st as unknown as { teams: Array<{ members: Array<{ id: string; github: string }> }> }).teams[0]!.members.find(
      (m) => m.github === "bob",
    )!.id;
    const rot = await alice.link.removeMember(bobId, team.id);
    expect(rot.keyVersion).toBe(2);
    const secret = sealForTeam((alice.link as unknown as { currentKey(t: string): ReturnType<typeof newTeamKey> }).currentKey(team.id), { goal: "after bob" });
    expect(secret.v).toBe(2);
    const bobKeys = (bob.link as unknown as { state: { teams: Record<string, { keys: Array<ReturnType<typeof newTeamKey>> } | undefined> } }).state.teams;
    expect(openFromTeam(bobKeys[team.id]?.keys ?? [], secret)).toBeNull();
    await waitUntil(() => (bob.link.status() as { teams: unknown[] }).teams.length === 0);
    st = alice.link.status() as typeof st;
    expect(st.teams[0]!.members.map((m) => m.github)).toEqual(["alice"]);
  });

  it("an explicit opt-out beats the remote auto-match", async () => {
    const carol = await member("carol");
    const alice = members.find((m) => m.dir.includes("alice"))!;
    await carol.link.join((await alice.link.invite()).link, { github: "carol", secret: "s3cret" });
    carol.link.unshare(carol.rt);
    await carol.rt.orchestra.start({ goal: "private work", orchestrator: "conductor", workers: ["alpha"] });
    expect(await carol.link.beat()).toBe(0);
    await carol.rt.orchestra.abort(carol.rt.orchestra.active()!.id);
  });
});

describe("the daemon's team routes and the `loom team` CLI", () => {
  it("signs in, creates, invites and shares through REST; the CLI prints it", async () => {
    const { LoomDaemon } = await import("../src/daemon/server.js");
    const { readDaemonConfig } = await import("../src/core/registry.js");
    const { DaemonClient } = await import("../src/daemon/client.js");
    const { execFile } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");

    process.env.LOOM_HOME = tmpDir("home-team-routes");
    const hub = await startHubServer({ port: 0, secret: "k" });
    const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    const client = new DaemonClient(readDaemonConfig()!);
    try {
      const dir = tmpDir("team-routes-proj");
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
      git("init", "-q");
      git("remote", "add", "origin", "https://github.com/acme/routes.git");
      writeProjectConfig(dir, { name: "routes", agents: [{ id: "alpha", kind: "echo", role: "w" }], brain: { extractor: "off" } });
      const pid = (await client.addProject(dir)).project.id;

      await expect(client.teamAction("signin", { hub: hub.url, github: "dana", secret: "wrong" })).rejects.toThrow(/join secret/);
      await client.teamAction("signin", { hub: hub.url, github: "dana", secret: "k" });
      const created = await client.teamAction("create", { name: "Routes" });
      expect(created.result).toMatchObject({ name: "Routes" });
      const inv = (await client.teamAction("invite")).result as { link: string };
      expect(inv.link).toMatch(/^loom:\/\/team\/join#/);
      expect(await client.shareProject(pid)).toEqual({ repo: "acme/routes", teamId: (created.result as { id: string }).id });

      const st = (await client.team()) as { github: string; teams: Array<{ repos: string[]; members: Array<{ github: string }> }> };
      expect(st.github).toBe("dana");
      expect(st.teams[0]!.repos).toEqual(["acme/routes"]);

      // the CLI renders the same view
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const out = await new Promise<string>((resolve) =>
        execFile(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "src", "cli", "index.ts"), "team"], {
          cwd: dir,
          env: { ...process.env, NO_COLOR: "1" },
        }, (_e, so, se) => resolve(so + se)),
      );
      expect(out).toContain("dana on");
      expect(out).toContain("Routes");
      expect(out).toContain("acme/routes");
    } finally {
      await daemon.close();
      await hub.close();
    }
  });
});
