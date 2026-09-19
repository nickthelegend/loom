/**
 * Loom Teams, Phase 3 — "one brain", end to end.
 *
 * Two members (alice, bob), each a real ProjectRuntime + Team Link with their
 * own clone of one repo, meeting on a real `loom hub`. Origin is a real bare
 * repo; `gh` is a stub on PATH (it only has to answer `pr list` / `pr create`).
 *
 * Proves: durable memories reach teammates sealed, labelled as proposals, and
 * untrusted/private/task memories never leave (D13, D42, D43); the same lesson
 * learned twice is one confirmed memory (D41); a correction waits in both
 * inboxes and resolution keeps the loser (D40, D47); promotion writes canon to
 * AGENTS.md on a rolling `loom/canon` PR with `@AGENTS.md` in CLAUDE.md, and
 * once merged every briefing leads with it (D44–D46); the live team context
 * names a teammate's open PR on the same files (D48).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemoryKind } from "../src/core/brain.js";
import { parseCanon } from "../src/core/team-canon.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

let hub: Awaited<ReturnType<typeof startHubServer>>;
let origin: string;
let seed: string;
let teamId: string;
let oldPath: string | undefined;
const M: Record<string, { rt: ProjectRuntime; link: TeamLink; dir: string }> = {};

async function member(who: "alice" | "bob") {
  const dir = tmpDir(`p3-${who}`);
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "config", "loom.repo", "acme/app");
  git(dir, "config", "user.email", `${who}@t`);
  git(dir, "config", "user.name", who);
  writeProjectConfig(dir, { name: `app-${who}`, agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } });
  const rt = await ProjectRuntime.open({ id: `p3-${who}`, name: `app-${who}`, dir });
  const link = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmpDir(`p3state-${who}`), "team.json") });
  link.attachRuntime(rt);
  M[who] = { rt, link, dir };
}

const tb = (who: string) => M[who]!.link.brainFor(M[who]!.rt);
const learn = (who: string, text: string, kind: MemoryKind = "decision", extra: Record<string, unknown> = {}) =>
  M[who]!.rt.brain.add({ kind, text, provenance: { agentId: "echo", eventId: 0, ts: Date.now() }, confidence: 1, ...extra }).memory;
const brief = (who: string, query: string) =>
  (M[who]!.rt as unknown as { brainBrief(o: { query: string; limit: number }): string }).brainBrief({ query, limit: 12 });
const teamView = (who: string, id: string) => tb(who).memories({ history: true }).find((m) => m.id === id);

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-p3");
  process.env.LOOM_NO_NOTIFY = "1";
  // a `gh` that knows one thing: there's no open canon PR, and creating one works
  const bin = tmpDir("p3-bin");
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\ncase "$*" in\n  *"pr list"*) echo "[]" ;;\n  *"pr create"*) echo "https://github.com/acme/app/pull/42" ;;\n  *) exit 1 ;;\nesac\n',
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  hub = await startHubServer({ port: 0, secret: "p3" });
  seed = tmpDir("p3-seed");
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "AGENTS.md"), "# Agents\n\nRun `npm test` before pushing.\n");
  fs.writeFileSync(path.join(seed, "CLAUDE.md"), "# Claude\n\nBe terse.\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-qm", "seed");
  origin = tmpDir("p3-origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

  await member("alice");
  await member("bob");
  await M.alice!.link.signIn(hub.url, { github: "alice", secret: "p3" });
  teamId = (await M.alice!.link.createTeam("Acme")).id;
  await M.alice!.link.share(M.alice!.rt, teamId);
  await M.bob!.link.join((await M.alice!.link.invite(teamId)).link, { github: "bob", secret: "p3" });
  for (const who of ["alice", "bob"]) git(M[who]!.dir, "remote", "set-head", "origin", "main");
  await tb("alice").sync();
  await tb("bob").sync();
}, 60_000);

afterAll(async () => {
  process.env.PATH = oldPath;
  for (const m of Object.values(M)) {
    await m.link.stop();
    await m.rt.close();
  }
  await hub.close();
});

describe("Phase 3: one brain", () => {
  it("durable memories reach teammates sealed and labelled; untrusted, private and task ones stay home", async () => {
    const shared = learn("alice", "Session cookies must be SameSite=Lax because of the OAuth redirect.", "constraint");
    const untrusted = learn("alice", "The payments API allows 1000 requests per minute.", "fact", { untrusted: true });
    const priv = learn("alice", "I prefer tabs over spaces in scratch files.", "convention", { private: true });
    const task = learn("alice", "Currently wiring the login form.", "task");
    await tb("alice").sync();
    await waitUntil(() => Boolean(teamView("bob", shared.id)));
    for (const m of [untrusted, priv, task]) expect(teamView("bob", m.id)).toBeUndefined();

    // the hub holds ciphertext only
    const raw = await hub.hub.client(hub.hub.signIn("bob").token).teamMemories(teamId, "acme/app");
    expect(JSON.stringify(raw)).not.toContain("SameSite");

    expect(teamView("bob", shared.id)).toMatchObject({ tier: "proposed", author: "alice", mine: false });
    expect(brief("bob", "session cookies SameSite")).toContain("_(proposed by alice — not yet confirmed)_");
    // alice's own briefing sees it as hers, unlabelled
    expect(brief("alice", "session cookies SameSite")).toMatch(/SameSite=Lax because of the OAuth redirect\.\n|SameSite=Lax because of the OAuth redirect\.$/);
    // and her untrusted memory waits in her inbox
    expect(tb("alice").inbox().some((i) => i.type === "untrusted" && i.a.id === untrusted.id)).toBe(true);
  });

  it("the same lesson learned by both is one memory, confirmed (D41), and up for canon", async () => {
    const a = learn("alice", "We validate every request body with zod.", "convention");
    await tb("alice").sync();
    await waitUntil(() => Boolean(teamView("bob", a.id)));
    learn("bob", "we validate every request body with  zod.", "convention"); // same words, different spacing and case
    await tb("bob").sync();
    await waitUntil(() => teamView("alice", a.id)?.confirmedBy.length === 2);
    expect(teamView("alice", a.id)).toMatchObject({ tier: "confirmed", confirmedBy: ["alice", "bob"] });
    expect(brief("bob", "validate request body zod")).toContain("_(confirmed by 2 teammates)_");
    expect(brief("bob", "validate request body zod").match(/validate every request body/gi)).toHaveLength(1);
    expect(tb("bob").inbox().some((i) => i.type === "promote" && i.a.id === a.id)).toBe(true);
  });

  it("a correction waits in both inboxes; resolving keeps the loser, linked (D40, D47)", async () => {
    const orig = learn("alice", "Background jobs run on BullMQ with Redis.", "decision");
    await tb("alice").sync();
    await waitUntil(() => Boolean(teamView("bob", orig.id)));
    const fix = await tb("bob").correct(orig.id, "Background jobs moved from BullMQ to pg-boss on Postgres.");
    expect(fix.supersedes).toBe(orig.id);
    await waitUntil(() => tb("alice").inbox().some((i) => i.type === "correction" && [i.a.id, i.b?.id].includes(orig.id)));
    expect(tb("bob").inbox().some((i) => i.type === "correction")).toBe(true);

    await tb("alice").resolve(fix.id, orig.id, "we moved to pg-boss");
    await waitUntil(() => teamView("bob", orig.id)?.state === "superseded");
    expect(teamView("bob", orig.id)).toMatchObject({ supersededBy: fix.id, resolvedBy: "alice", resolvedReason: "we moved to pg-boss" });
    // gone from both briefings — including alice's, though her local copy remains
    expect(M.alice!.rt.brain.get(orig.id)).toBeTruthy();
    for (const who of ["alice", "bob"]) {
      const b = brief(who, "background jobs queue");
      expect(b).toContain("pg-boss");
      expect(b).not.toContain("run on BullMQ with Redis");
    }
    expect(tb("alice").inbox().some((i) => i.type === "correction")).toBe(false);
    // and the resolution is on the team feed
    await waitUntil(() => (M.bob!.link.status() as { teams: Array<{ feed: Array<{ type: string }> }> }).teams[0]!.feed.some((e) => e.type === "memory_resolved"));
  });

  it("an author's edit updates the team copy; a local forget withdraws it (D40)", async () => {
    const m = learn("alice", "The API listens on port 3000.", "fact");
    await tb("alice").sync();
    await waitUntil(() => Boolean(teamView("bob", m.id)));
    M.alice!.rt.brain.update(m.id, { text: "The API listens on port 8080." }, "user");
    await tb("alice").sync();
    await waitUntil(() => teamView("bob", m.id)?.text === "The API listens on port 8080.");
    M.alice!.rt.brain.forget(m.id, "wrong", "user");
    await tb("alice").sync();
    await waitUntil(() => teamView("bob", m.id)?.state === "forgotten");
  });

  it("near-duplicates and contradictions across people land in the inbox; trusting shares (D41, D43, D49)", async () => {
    const a = learn("alice", "Deploys go out every Tuesday afternoon after standup.", "convention");
    const b = learn("bob", "Deploys go out every Tuesday afternoon, after standup!", "convention");
    const c = learn("alice", "We use semicolons at the end of every TypeScript statement.", "convention");
    const d = learn("bob", "We do not use semicolons at the end of TypeScript statements.", "convention");
    await tb("alice").sync();
    await tb("bob").sync();
    await waitUntil(() => Boolean(teamView("alice", b.id) && teamView("alice", d.id)));
    const inbox = tb("alice").inbox();
    const pair = (i: { a: { id: string }; b?: { id: string } }) => [i.a.id, i.b?.id].sort().join();
    expect(inbox.find((i) => i.type === "duplicate" && pair(i) === [a.id, b.id].sort().join())).toBeTruthy();
    expect(inbox.find((i) => i.type === "contradiction" && pair(i) === [c.id, d.id].sort().join())).toBeTruthy();
    // merging keeps one; the other leaves both briefings
    await tb("alice").resolve(a.id, b.id, "duplicate");
    await waitUntil(() => teamView("bob", b.id)?.state === "superseded");
    expect(brief("bob", "deploys tuesday standup").match(/Deploys go out every Tuesday/g)).toHaveLength(1);

    // untrusted until a human says otherwise, then it goes out
    const u = tb("alice").inbox().find((i) => i.type === "untrusted")!;
    M.alice!.rt.brain.update(u.a.id, { untrusted: false }, "user");
    await tb("alice").sync();
    await waitUntil(() => Boolean(teamView("bob", u.a.id)));
  });

  it("promotion opens the rolling canon PR; once merged, canon leads every briefing (D44–D46)", async () => {
    const confirmed = tb("bob").inbox().find((i) => i.type === "promote")!;
    const out = await tb("bob").promote([confirmed.a.id]);
    expect(out).toMatchObject({ branch: "loom/canon", prUrl: "https://github.com/acme/app/pull/42", added: 1 });

    const onBranch = git(origin, "show", "loom/canon:AGENTS.md");
    expect(onBranch).toContain("Run `npm test` before pushing."); // the human part is untouched
    expect(parseCanon(onBranch)).toEqual([{ id: confirmed.a.id, kind: "convention", text: "We validate every request body with zod." }]);
    expect(git(origin, "show", "loom/canon:CLAUDE.md")).toMatch(/\n@AGENTS\.md\n$/);

    // a second promotion rolls onto the same branch, keeping the first
    const other = learn("bob", "Feature flags live in config/flags.ts.", "fact");
    const again = await tb("bob").promote([other.id]);
    expect(again.added).toBe(1);
    expect(parseCanon(git(origin, "show", "loom/canon:AGENTS.md")).map((e) => e.id)).toEqual([confirmed.a.id, other.id]);

    // the team reviews and merges the PR
    git(seed, "fetch", "-q", "origin");
    git(seed, "-c", "user.name=s", "-c", "user.email=s@s", "merge", "-q", "--ff-only", "origin/loom/canon");
    git(seed, "push", "-q", "origin", "main");
    for (const who of ["alice", "bob"]) git(M[who]!.dir, "fetch", "-q", "origin");
    await tb("alice").sync();
    expect(tb("alice").canonEntries().map((e) => e.id)).toEqual([confirmed.a.id, other.id]);
    const b = brief("alice", "validate request body zod");
    expect(b).toContain("We validate every request body with zod.  _(team canon)_");
    expect(b.match(/validate every request body/gi)).toHaveLength(1); // canon replaces the confirmed copy
    expect(tb("alice").inbox().some((i) => i.type === "promote" && i.a.id === confirmed.a.id)).toBe(false);
    // promoting what's already canon changes nothing
    expect((await tb("alice").promote([confirmed.a.id])).added).toBe(0);
    // and it's on the feed
    await waitUntil(() => (M.alice!.link.status() as { teams: Array<{ feed: Array<{ type: string }> }> }).teams[0]!.feed.some((e) => e.type === "canon_proposed"));
  });

  it("the live team context names a teammate's open PR on the same files (D48)", async () => {
    const aliceHub = hub.hub.client(hub.hub.signIn("alice").token);
    await aliceHub.appendFeed(teamId, {
      repo: "acme/app",
      type: "pr_opened",
      meta: { number: 7, author: "alice", branch: "feat/login", files: ["src/auth/session.ts", "src/auth/login.ts"] },
      dedupeKey: "gh:acme/app#7:opened",
    });
    await waitUntil(() => tb("bob").context(["src/auth/session.ts"]).includes("PR #7"));
    const ctx = tb("bob").context(["src/auth/session.ts"]);
    expect(ctx).toContain("open PR #7 by alice also changes src/auth/session.ts");
    expect(ctx.length).toBeLessThanOrEqual(1500);
    expect(tb("bob").context(["README.md"])).toBe("");
    expect(tb("alice").context(["src/auth/session.ts"])).toBe(""); // her own PR isn't news to her
  });
});
