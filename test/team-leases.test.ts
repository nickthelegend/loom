/**
 * Phase 2 building blocks: what a lease covers (D28), hard zones (D10), and
 * the team policy file (D37–D39). Pure logic — the hub and daemons rely on it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { covered, globToRegExp, literalPrefix, overlap, scopeOf, zoneOf } from "../src/core/team-leases.js";
import { agentAllowed, cappedPermission, isProtected, loadPolicy, OPEN_POLICY, parsePolicy, stricter } from "../src/core/team-policy.js";
import { tmpDir } from "./helpers.js";

const TRACKED = [
  "src/auth/session.ts",
  "src/auth/session.test.ts",
  "src/auth/oauth.ts",
  "src/ui/button.tsx",
  "src/ui/button.test.tsx",
  "db/migrations/001_init.sql",
  "README.md",
];

describe("globs", () => {
  it("matches like a pathspec", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.test.ts").test("src/auth/session.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("top.test.ts")).toBe(true);
    expect(globToRegExp("src/{ui,auth}/*.ts").test("src/auth/oauth.ts")).toBe(true);
    expect(globToRegExp("src/auth").test("src/auth/oauth.ts")).toBe(true); // a bare dir means its contents
    expect(globToRegExp("src/auth").test("src/authz.ts")).toBe(false);
  });

  it("takes the literal directory before the first wildcard", () => {
    expect(literalPrefix("src/auth/**")).toBe("src/auth/");
    expect(literalPrefix("src/au*/x.ts")).toBe("src/");
    expect(literalPrefix("**/*.md")).toBe("");
    expect(literalPrefix("./README.md")).toBe("README.md");
  });
});

describe("overlap (D28)", () => {
  it("catches the hard case: **/*.test.ts vs src/auth/**, through real files", () => {
    const tests = scopeOf(["**/*.test.ts"], TRACKED);
    const auth = scopeOf(["src/auth/**"], TRACKED);
    expect(tests.files).toEqual(["src/auth/session.test.ts"]);
    expect(overlap(tests, auth)).toEqual(["src/auth/session.test.ts"]);
    expect(overlap(auth, tests)).toEqual(["src/auth/session.test.ts"]);
  });

  it("different files in different folders don't overlap", () => {
    expect(overlap(scopeOf(["src/ui/**"], TRACKED), scopeOf(["src/auth/**"], TRACKED))).toEqual([]);
  });

  it("two plans for the same not-yet-existing folder overlap by prefix", () => {
    const a = scopeOf(["src/billing/**"], TRACKED);
    const b = scopeOf(["src/billing/invoices/*.ts"], TRACKED);
    expect(a.files).toEqual([]);
    expect(overlap(a, b)).toEqual(["src/billing/invoices/"]);
  });

  it("a repo-wide wildcard only collides through files, never claims everything", () => {
    expect(overlap(scopeOf(["**/*.md"], TRACKED), scopeOf(["src/**"], TRACKED))).toEqual([]);
  });

  it("finds the hard zone a scope touches", () => {
    expect(zoneOf(scopeOf(["db/**"], TRACKED), ["db/migrations/**"])).toBe("db/migrations/**");
    expect(zoneOf(scopeOf(["db/migrations/002_new.sql"], TRACKED), ["db/migrations/**"])).toBe("db/migrations/**");
    expect(zoneOf(scopeOf(["src/**"], TRACKED), ["db/migrations/**"])).toBeNull();
  });

  it("tells drift from declared work (D33)", () => {
    expect(covered("src/auth/oauth.ts", ["src/auth/**"])).toBe(true);
    expect(covered("src/ui/button.tsx", ["src/auth/**"])).toBe(false);
  });
});

describe("team policy (D37–D39)", () => {
  it("parses leniently", () => {
    const p = parsePolicy({ hardZones: ["db/**"], permissions: { ceiling: "yolo" }, orchestra: { maxParallelPerMember: -2 } });
    expect(p.hardZones).toEqual(["db/**"]);
    expect(p.permissions.ceiling).toBe("bypass"); // bad value → open
    expect(p.orchestra.maxParallelPerMember).toBeNull();
    expect(parsePolicy(null)).toEqual(OPEN_POLICY);
  });

  it("a local copy can only tighten", () => {
    const base = parsePolicy({ permissions: { ceiling: "auto" }, agents: { allow: ["codex", "claude-code"] }, orchestra: { maxParallelPerMember: 6 } });
    const loose = parsePolicy({ permissions: { ceiling: "bypass" }, agents: { allow: ["codex", "grok-code"] }, orchestra: { maxParallelPerMember: 50 } });
    const eff = stricter(base, loose);
    expect(eff.permissions.ceiling).toBe("auto");
    expect(eff.agents.allow).toEqual(["codex"]);
    expect(eff.orchestra.maxParallelPerMember).toBe(6);
  });

  it("caps permissions and enforces bypass-only-with-a-plan", () => {
    const p = parsePolicy({ permissions: { ceiling: "bypass", bypassRequiresPlan: true } });
    expect(cappedPermission(p, "bypass", false)).toBe("auto");
    expect(cappedPermission(p, "bypass", true)).toBe("bypass");
    expect(cappedPermission(parsePolicy({ permissions: { ceiling: "ask" } }), "auto", true)).toBe("ask");
    expect(agentAllowed(parsePolicy({ agents: { allow: ["codex"] } }), "grok-code")).toBe(false);
    expect(isProtected(parsePolicy({ delivery: { protected: ["main", "release/*"] } }), "release/1.2")).toBe(true);
  });

  it("reads the reviewed copy from origin's default branch; a local edit can't loosen it", async () => {
    const origin = tmpDir("policy-origin");
    const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "loom.team.json"), JSON.stringify({ permissions: { ceiling: "auto" }, hardZones: ["db/**"] }));
    git(origin, "add", "-A");
    git(origin, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "policy");
    const clone = tmpDir("policy-clone");
    git(path.dirname(clone), "clone", "-q", origin, clone);
    // someone edits their working copy to allow bypass — it doesn't take
    fs.writeFileSync(path.join(clone, "loom.team.json"), JSON.stringify({ permissions: { ceiling: "bypass" }, hardZones: [] }));
    const eff = await loadPolicy(clone);
    expect(eff.source).toBe("origin");
    expect(eff.permissions.ceiling).toBe("auto");
    expect(eff.hardZones).toEqual(["db/**"]);
    // no policy anywhere → open
    expect((await loadPolicy(tmpDir("policy-none"))).source).toBe("none");
  });
});

describe("hub leases (MemoryHub)", async () => {
  const { MemoryHub, LEASE_TTL_MS } = await import("../src/core/team-hub.js");
  async function setup() {
    let t = 5_000_000;
    const hub = new MemoryHub(() => t);
    const a = hub.client(hub.signIn("alice").token);
    const b = hub.client(hub.signIn("bob").token);
    const team = await a.createTeam("acme");
    await b.redeemInvite((await a.createInvite(team.id)).invite);
    await a.shareRepo(team.id, "acme/app");
    const da = await a.registerDevice({ label: "a", sealPub: "s", signPub: "pa" });
    const db = await b.registerDevice({ label: "b", sealPub: "s", signPub: "pb" });
    const claim = (dev: string, runId: string, taskId: string, globs: string[], hardZones: string[] = []) => ({
      deviceId: dev, repo: "acme/app", runId, taskId, hardZones, ...scopeOf(globs, TRACKED),
    });
    return { hub, a, b, team, da, db, claim, advance: (ms: number) => (t += ms) };
  }

  it("grants, reports overlaps with who holds what, and re-claims idempotently", async () => {
    const { a, b, team, da, db, claim } = await setup();
    const first = await a.claimLease(team.id, claim(da.id, "o1", "t1", ["src/auth/**"]));
    expect(first.lease?.github).toBe("alice");
    expect(first.overlaps).toEqual([]);
    const second = await b.claimLease(team.id, claim(db.id, "o2", "t1", ["**/*.test.ts"]));
    expect(second.lease).toBeTruthy(); // advisory: granted…
    expect(second.overlaps.map((o) => [o.lease.github, o.paths])).toEqual([["alice", ["src/auth/session.test.ts"]]]); // …with the collision named
    await a.claimLease(team.id, claim(da.id, "o1", "t1", ["src/auth/oauth.ts"]));
    expect((await a.leases(team.id)).filter((l) => l.github === "alice")).toHaveLength(1);
    // a goal never collides with itself
    const own = await a.claimLease(team.id, claim(da.id, "o1", "t2", ["src/auth/**"]));
    expect(own.overlaps.map((o) => o.lease.runId)).toEqual(["o2"]); // bob's, never alice's own o1
  });

  it("refuses a claim into a held hard zone, and lets it through once released (D31, D36)", async () => {
    const { a, b, team, da, db, claim } = await setup();
    const zones = ["db/migrations/**"];
    await a.claimLease(team.id, claim(da.id, "o1", "t1", ["db/migrations/002_add.sql"], zones));
    const refused = await b.claimLease(team.id, claim(db.id, "o2", "t1", ["db/**"], zones));
    expect(refused.lease).toBeNull();
    expect(refused.blockedBy).toMatchObject({ zone: "db/migrations/**", lease: { github: "alice" } });
    expect(await b.releaseLeases(team.id, "o1", "not mine")).toBe(0); // only the owner releases
    expect(await a.releaseLeases(team.id, "o1", "PR #4 merged")).toBe(1);
    expect((await b.claimLease(team.id, claim(db.id, "o2", "t1", ["db/**"], zones))).lease).toBeTruthy();
    expect((await a.feed(team.id)).at(-1)).toMatchObject({ type: "lease_released", meta: { runId: "o1", reason: "PR #4 merged" } });
  });

  it("a sleeping laptop's leases go stale and stop blocking; renewing brings them back (D12)", async () => {
    const { a, b, team, da, db, claim, advance } = await setup();
    const zones = ["db/migrations/**"];
    await a.claimLease(team.id, claim(da.id, "o1", "t1", ["db/migrations/**"], zones));
    advance(LEASE_TTL_MS + 1);
    expect((await b.leases(team.id))[0]!.stale).toBe(true);
    expect((await b.claimLease(team.id, claim(db.id, "o2", "t1", ["db/**"], zones))).lease).toBeTruthy();
    await b.releaseLeases(team.id, "o2", "done");
    expect(await a.renewLeases(team.id, da.id)).toBe(1);
    expect((await b.claimLease(team.id, claim(db.id, "o2", "t1", ["db/**"], zones))).blockedBy).toBeTruthy();
  });

  it("drift widens a lease, reports new collisions, and refuses someone else's hard zone (D33)", async () => {
    const { a, b, team, da, db, claim } = await setup();
    await b.claimLease(team.id, claim(db.id, "o2", "t1", ["src/ui/**"]));
    await b.claimLease(team.id, claim(db.id, "o2", "t2", ["db/migrations/**"], ["db/migrations/**"]));
    const mine = (await a.claimLease(team.id, claim(da.id, "o1", "t1", ["src/auth/**"]))).lease!;
    const drift = await a.extendLease(team.id, mine.id, scopeOf(["src/ui/button.tsx"], TRACKED), ["db/migrations/**"]);
    expect(drift.lease?.files).toContain("src/ui/button.tsx");
    expect(drift.overlaps.map((o) => o.lease.github)).toEqual(["bob"]);
    const zoned = await a.extendLease(team.id, mine.id, scopeOf(["db/migrations/001_init.sql"], TRACKED), ["db/migrations/**"]);
    expect(zoned.lease).toBeNull();
    expect(zoned.blockedBy?.zone).toBe("db/migrations/**");
    await expect(b.extendLease(team.id, mine.id, scopeOf(["x"], TRACKED), [])).rejects.toThrow(/isn't yours/);
  });

  it("marks a goal's leases as landing once its tasks are done", async () => {
    const { a, team, da, claim } = await setup();
    await a.claimLease(team.id, claim(da.id, "o1", "t1", ["src/auth/**"]));
    expect(await a.setRunLeaseState(team.id, "o1", "landing")).toBe(1);
    expect((await a.leases(team.id))[0]!.state).toBe("landing");
  });
});
