/**
 * Phase 6 (D79–D82), the pure parts of the landing train and the hub rules it
 * rides on: lanes from a PR's diff, how Land routes, the next step of a turn,
 * and a lane's slot as a lease that only one goal holds at a time.
 */

import { describe, expect, it } from "vitest";

import { MemoryHub } from "../src/core/team-hub.js";
import {
  hasMergeQueue,
  laneClaim,
  landingRoute,
  landRunId,
  lanesFor,
  parseLanes,
  queuedReason,
  summarizeChecks,
  trainStep,
} from "../src/core/team-landing.js";
import { OPEN_POLICY, parsePolicy, stricter } from "../src/core/team-policy.js";

describe("lanes (D81)", () => {
  const lanes = { web: ["web/**"], api: ["api/**", "db/**"] };

  it("a goal needs every lane its diff touches, sorted; none matching (or none configured) is main", () => {
    expect(lanesFor(["web/app.ts"], lanes)).toEqual(["web"]);
    expect(lanesFor(["db/schema.sql", "web/x.ts"], lanes)).toEqual(["api", "web"]);
    expect(lanesFor(["README.md"], lanes)).toEqual(["main"]);
    expect(lanesFor(["web/app.ts"], {})).toEqual(["main"]);
    expect(lanesFor([], lanes)).toEqual(["main"]);
  });

  it("parses loom.team.json's landing.lanes leniently", () => {
    expect(parseLanes({ web: ["web/**"], "bad name!": ["x/**"], empty: [], one: "docs/**", toolongtoolongtoolongtoolong: ["a/**"] })).toEqual({
      web: ["web/**"],
      one: ["docs/**"],
    });
    expect(parseLanes(null)).toEqual({});
    expect(parseLanes(["web"])).toEqual({});
    expect(parsePolicy({ landing: { lanes: { api: ["./api/**"] } } }).landing.lanes).toEqual({ api: ["api/**"] });
    expect(OPEN_POLICY.landing.lanes).toEqual({});
  });

  it("only the reviewed policy splits lanes: a local copy can't loosen the train", () => {
    const base = parsePolicy({ landing: { lanes: { web: ["web/**"] } } });
    const local = parsePolicy({ landing: { lanes: { a: ["a/**"], b: ["b/**"] } } });
    expect(stricter(base, local).landing.lanes).toEqual({ web: ["web/**"] });
    expect(stricter(parsePolicy({}), local).landing.lanes).toEqual({});
  });

  it("a lane's slot is its own path and its own hard zone, under the goal's land run id", () => {
    expect(laneClaim("api")).toEqual({
      globs: [".loom/landing/api"],
      files: [".loom/landing/api"],
      prefixes: [".loom/landing/api"],
      hardZones: [".loom/landing/api"],
      taskId: "land:api",
    });
    expect(landRunId("o1")).toBe("o1:land");
    expect(queuedReason("bob", "api")).toBe("waiting behind bob's goal in lane api");
  });
});

describe("routing Land (D80)", () => {
  it("merge queue → queue; no queue on a team → train; no team, or a stack → auto", () => {
    expect(hasMergeQueue([{ type: "merge_queue" }])).toBe(true);
    expect(hasMergeQueue(null)).toBe(false);
    expect(landingRoute({ rules: [{ type: "merge_queue" }], team: true, stack: false })).toBe("queue");
    expect(landingRoute({ rules: [{ type: "required_status_checks" }], team: true, stack: false })).toBe("train");
    expect(landingRoute({ rules: null, team: true, stack: false })).toBe("train"); // unreadable rules: no queue seen
    expect(landingRoute({ rules: [], team: false, stack: false })).toBe("auto");
    expect(landingRoute({ rules: [], team: true, stack: true })).toBe("auto");
  });
});

describe("a turn's next step (D82)", () => {
  const green = summarizeChecks([{ name: "test", bucket: "pass" }]);
  const pending = summarizeChecks([{ name: "test", bucket: "pending" }]);
  const base = { holding: true, turnSha: "b", headSha: "b", checks: green, rows: 1, reviewing: false, sinceTurnMs: 5_000, settleMs: 60_000 };

  it("claim, then refresh on a new turn or a moved head, wait on running checks, merge when green", () => {
    expect(trainStep({ ...base, holding: false })).toBe("claim");
    expect(trainStep({ ...base, turnSha: undefined })).toBe("refresh");
    expect(trainStep({ ...base, headSha: "c" })).toBe("refresh");
    expect(trainStep({ ...base, checks: pending })).toBe("wait");
    expect(trainStep({ ...base, reviewing: true })).toBe("wait");
    expect(trainStep(base)).toBe("merge");
  });

  it("no checks right after a push is 'not yet', until the settle window says 'no CI'", () => {
    const none = summarizeChecks([]);
    expect(trainStep({ ...base, checks: none, rows: 0 })).toBe("wait");
    expect(trainStep({ ...base, checks: none, rows: 0, sinceTurnMs: 61_000 })).toBe("merge");
  });
});

describe("a lane's slot on the hub (D79): one holder per lane, no new hub API", () => {
  function team() {
    const hub = new MemoryHub();
    const a = hub.signIn("alice");
    const b = hub.signIn("bob");
    const A = hub.client(a.token);
    const B = hub.client(b.token);
    const t = hub.createTeam(a.user.id, "Acme");
    const inv = hub.createInvite(a.user.id, t.id);
    hub.redeemInvite(b.user.id, inv.invite);
    hub.shareRepo(a.user.id, t.id, "acme/app");
    const da = hub.registerDevice(a.user.id, { label: "a", sealPub: "sa", signPub: "ka" });
    const db = hub.registerDevice(b.user.id, { label: "b", sealPub: "sb", signPub: "kb" });
    return { hub, A, B, t, da, db };
  }
  const claim = (lane: string, run: string, device: string) => {
    const c = laneClaim(lane);
    return { globs: c.globs, files: c.files, prefixes: c.prefixes, hardZones: c.hardZones, taskId: c.taskId, runId: landRunId(run), deviceId: device, repo: "acme/app" };
  };

  it("a held lane refuses a second goal; another lane doesn't; releasing hands it on", async () => {
    const { A, B, t, da, db } = team();
    expect((await A.claimLease(t.id, claim("main", "o1", da.id))).lease).toBeTruthy();
    const refused = await B.claimLease(t.id, claim("main", "o2", db.id));
    expect(refused.lease).toBeNull();
    expect(refused.blockedBy).toMatchObject({ zone: ".loom/landing/main", lease: { github: "alice", runId: "o1:land" } });
    expect((await B.claimLease(t.id, claim("api", "o2", db.id))).lease).toBeTruthy(); // a different lane lands at once
    expect((await B.claimLease(t.id, claim("mainx", "o3", db.id))).lease).toBeTruthy(); // "mainx" isn't under "main"
    expect(await A.releaseLeases(t.id, "o1:land", "merged")).toBe(1);
    expect((await B.claimLease(t.id, claim("main", "o2", db.id))).lease).toBeTruthy();
  });

  it("the slot and the goal's task leases release separately (D36 untouched)", async () => {
    const { A, t, da } = team();
    await A.claimLease(t.id, { globs: ["src/**"], files: ["src/a.ts"], prefixes: ["src/"], hardZones: [], taskId: "t1", runId: "o1", deviceId: da.id, repo: "acme/app" });
    await A.claimLease(t.id, claim("main", "o1", da.id));
    expect(await A.releaseLeases(t.id, "o1:land", "merged")).toBe(1);
    expect((await A.leases(t.id)).map((l) => l.runId)).toEqual(["o1"]);
    expect(await A.releaseLeases(t.id, "o1", "PR merged")).toBe(1);
  });

  it("a slot held by the same member's other goal still queues this one", async () => {
    const { A, t, da } = team();
    expect((await A.claimLease(t.id, claim("main", "o1", da.id))).lease).toBeTruthy();
    expect((await A.claimLease(t.id, claim("main", "o2", da.id))).blockedBy?.lease.runId).toBe("o1:land");
  });
});

describe("webhook secrets on the reference hub (D83)", () => {
  it("owners only; stable until rotated; the receiver reads it without a session", async () => {
    const hub = new MemoryHub();
    const a = hub.signIn("alice");
    const b = hub.signIn("bob");
    const t = hub.createTeam(a.user.id, "Acme");
    hub.redeemInvite(b.user.id, hub.createInvite(a.user.id, t.id).invite);
    const s1 = (await hub.client(a.token).webhookSecret(t.id)).secret;
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect((await hub.client(a.token).webhookSecret(t.id)).secret).toBe(s1);
    await expect(hub.client(b.token).webhookSecret(t.id)).rejects.toThrow(/needs owner/);
    const s2 = (await hub.client(a.token).webhookSecret(t.id, true)).secret;
    expect(s2).not.toBe(s1);
    expect(hub.webhookSecretOf(t.id)).toBe(s2);
    expect(hub.webhookSecretOf("t_nope")).toBeNull();
  });
});
