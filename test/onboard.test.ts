/**
 * One link: Alice invites Bob to her project; Bob opens the link and ends up
 * on the team, with the repo cloned, opened in Loom with his own agents,
 * shared, and Alice's crew set up from them.
 *
 * Real `loom hub` over HTTP + WebSocket, real Team Links, real git. Only
 * GitHub is faked: `gh` (collaborator grant, repo invitations) and the clone,
 * which comes from a local origin and fails like a private repo until Alice's
 * Loom has granted access.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inviteFragment, inviteLink, previewInvite } from "../src/core/invite-link.js";
import { unpackInvite } from "../src/core/team-crypto.js";
import { registerProject, writeProjectConfig } from "../src/core/registry.js";
import { fillCrew, inviteTeammate, Onboarding } from "../src/daemon/onboard.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import type { ProjectInfo } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-onboard");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("invite links", () => {
  it("are https, and every older or local form reads the same", () => {
    const link = inviteLink("abc_-123", {});
    expect(link).toBe("https://nickthelegend.github.io/loom/join/#abc_-123");
    expect(inviteLink("x", { LOOM_JOIN_URL: "https://acme.dev/join" })).toBe("https://acme.dev/join#x");
    for (const l of [link, "loom://team/join#abc_-123", "http://localhost:7420/app#join=abc_-123", "abc_-123", ` '${link}' `]) {
      expect(inviteFragment(l)).toBe("abc_-123");
    }
    expect(previewInvite("junk")).toBeNull();
  });

  it("a crew blueprint is filled from the joiner's own agents, by kind first", () => {
    const tms = fillCrew(
      [{ id: "lead", role: "lead", kind: "claude-code" }, { id: "builder", role: "builder", kind: "codex" }, { id: "odd", role: "wizard" }],
      [{ id: "cx", kind: "codex" }, { id: "oc", kind: "opencode" }],
    );
    expect(tms).toEqual([
      { id: "lead", agent: "cx", role: "lead" },
      { id: "builder", agent: "cx", role: "builder" },
      { id: "odd", agent: "cx", role: "builder" },
    ]);
    expect(fillCrew([{ id: "a", role: "builder" }], [])).toBeNull();
  });
});

describe("one link, end to end", () => {
  let hub: Awaited<ReturnType<typeof startHubServer>>;
  let origin: string;
  const close: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    hub = await startHubServer({ port: 0, secret: "s3cret" });
    origin = tmpDir("onboard-origin");
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "README.md"), "# app\n");
    fs.writeFileSync(path.join(origin, ".gitignore"), ".loom/\n");
    git(origin, "add", "-A");
    git(origin, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "seed");
  });
  afterAll(async () => {
    for (const c of close.reverse()) await c().catch(() => {});
    await hub.close();
  });

  it("Alice invites from her project; Bob's one link does the rest", async () => {
    // Alice: a clone of acme/app, a roster, a crew, signed in — but no team yet.
    const aliceDir = tmpDir("onboard-alice");
    git(path.dirname(aliceDir), "clone", "-q", origin, aliceDir);
    git(aliceDir, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    writeProjectConfig(aliceDir, {
      name: "app",
      agents: [{ id: "claude", kind: "claude-code", enabled: false }, { id: "worker", kind: "echo" }],
      brain: { extractor: "off" },
    });
    const aliceRt = await ProjectRuntime.open({ id: "onb-alice", name: "app", dir: aliceDir });
    close.push(() => aliceRt.close());
    aliceRt.crews.create({ name: "Ship", teammates: [{ id: "lead", agent: "worker", role: "lead" }, { id: "builder", agent: "worker", role: "builder", charter: "small diffs" }] });

    const granted: string[] = [];
    let grantedAt = 0;
    const aliceGh = async (args: string[]) => {
      if (args[1] === "repos/acme/app") return "true\n"; // can admin
      if (args.includes("PUT")) { granted.push(args[3]!.split("/").pop()!); grantedAt = Date.now(); return "{}"; }
      return "";
    };
    const alice = new TeamLink({ runtimes: () => [aliceRt], broadcast: () => {}, statePath: path.join(tmpDir("onb-alice-state"), "team.json"), gh: aliceGh });
    close.push(() => alice.stop());
    await alice.signIn(hub.url, { github: "alice", secret: "s3cret" });

    const invite = await inviteTeammate(alice, aliceRt, { gh: aliceGh });
    expect(invite.link).toMatch(/^https:\/\/nickthelegend\.github\.io\/loom\/join\/#/);
    expect(invite).toMatchObject({ repo: "acme/app", grant: true, team: { name: "app" } });
    expect(invite.message).toContain(invite.link);
    // the link is the whole onboarding: team, repo, who sent it, the crew (as roles and kinds, not Alice's agent ids)
    const frag = unpackInvite(inviteFragment(invite.link))!;
    expect(frag).toMatchObject({ team: "app", repo: "acme/app", from: "alice", project: "app" });
    expect(frag.crews).toEqual([{ name: "Ship", teammates: [
      { id: "lead", role: "lead", kind: "echo" }, { id: "builder", role: "builder", kind: "echo", charter: "small diffs" },
    ] }]);
    // inviting made the team and shared the repo
    expect(aliceRt.config.team).toMatchObject({ repo: "acme/app" });

    // Bob: nothing but Loom. The repo is private until Alice's Loom grants him.
    const bobHome = tmpDir("onboard-bob-projects");
    const bobRts: ProjectRuntime[] = [];
    const projects: ProjectInfo[] = [];
    let invitationAccepted = false;
    const bob = new TeamLink({ runtimes: () => bobRts, broadcast: () => {}, statePath: path.join(tmpDir("onb-bob-state"), "team.json") });
    close.push(() => bob.stop());
    const frames: Array<Record<string, unknown>> = [];
    const onboarding = new Onboarding({
      team: bob,
      projects: () => projects,
      addProject: async (dir, name) => {
        writeProjectConfig(dir, { name, agents: [{ id: "mine", kind: "echo" }], brain: { extractor: "off" } });
        const info = registerProject(dir, name);
        projects.push(info);
        return info;
      },
      runtime: async (id) => {
        const info = projects.find((p) => p.id === id)!;
        const rt = bobRts.find((r) => r.info.id === id) ?? (await ProjectRuntime.open(info));
        if (!bobRts.includes(rt)) { bobRts.push(rt); close.push(() => rt.close()); }
        return rt;
      },
      broadcast: (f) => frames.push(JSON.parse(JSON.stringify(f))),
      projectsHome: bobHome,
      clone: async (repo, dir) => {
        if (!invitationAccepted) throw new Error(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository) — not found`);
        git(path.dirname(dir), "clone", "-q", origin, dir);
        git(dir, "remote", "set-url", "origin", `https://github.com/${repo}.git`);
      },
      gh: async (args) => {
        if (args[1] === "user/repository_invitations") {
          // GitHub's invitation shows up a moment after the grant: Bob's join waits for it
          const ready = granted.includes("bob") && Date.now() - grantedAt > 300;
          return JSON.stringify(ready && !invitationAccepted ? [{ id: 7, repository: { full_name: "acme/app" } }] : []);
        }
        if (args.includes("PATCH") && args[3] === "user/repository_invitations/7") { invitationAccepted = true; return ""; }
        return "";
      },
      accessPollMs: 50,
      accessWaitMs: 10_000,
    });

    const preview = await onboarding.preview(invite.link);
    expect(preview).toMatchObject({ team: "app", repo: "acme/app", from: "alice", signedIn: false, member: false, crews: ["Ship"] });

    const job = await onboarding.join(invite.link, { github: "bob", secret: "s3cret" });
    expect(job.error).toBeUndefined();
    expect(job.state).toBe("done");
    expect(job.steps.map((s) => [s.id, s.state])).toEqual([
      ["signin", "done"], ["team", "done"], ["repo", "done"], ["project", "done"], ["share", "done"], ["crews", "done"],
    ]);
    // the repo waited on access, and Alice's Loom granted it on Bob's join
    expect(granted).toEqual(["bob"]);
    expect(frames.some((f) => (f.job as { steps: Array<{ id: string; state: string }> }).steps.some((s) => s.id === "repo" && s.state === "waiting"))).toBe(true);
    const clone = path.join(bobHome, "app");
    expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe("# app\n");
    expect(job.project).toMatchObject({ name: "app", dir: clone });
    // shared with the team, so they see each other's work
    const bobRt = bobRts[0]!;
    expect(bobRt.config.team).toMatchObject({ repo: "acme/app" });
    const st = bob.status() as { teams: Array<{ name: string; members: Array<{ github: string }> }> };
    expect(st.teams[0]!.members.map((m) => m.github).sort()).toEqual(["alice", "bob"]);
    // Alice's crew, with Bob's agents
    expect(job.crews).toEqual(["Ship"]);
    expect(bobRt.crews.list()[0]!.teammates).toEqual([
      { id: "lead", agent: "mine", role: "lead" }, { id: "builder", agent: "mine", role: "builder", charter: "small diffs" },
    ]);
    await waitUntil(() => (alice.status() as { teams: Array<{ members: unknown[] }> }).teams[0]!.members.length === 2);

    // opening the same link again is a no-op, not an error
    const again = await onboarding.join(invite.link);
    expect(again.state).toBe("done");
    expect(again.steps.find((s) => s.id === "team")!.state).toBe("skipped");
    expect(again.steps.find((s) => s.id === "repo")!.detail).toMatch(/^using /);
    expect(bobRt.crews.list()).toHaveLength(1);
  });

  it("a join while the inviter's Loom was off is granted when it comes back", async () => {
    const dir = tmpDir("onboard-dana");
    git(path.dirname(dir), "clone", "-q", origin, dir);
    git(dir, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    writeProjectConfig(dir, { name: "app-dana", agents: [{ id: "w", kind: "echo" }], brain: { extractor: "off" } });
    const rt = await ProjectRuntime.open({ id: "onb-dana", name: "app-dana", dir });
    close.push(() => rt.close());
    const granted: string[] = [];
    const gh = async (args: string[]) => {
      if (args[1] === "repos/acme/app") return "true";
      if (args.includes("PUT")) granted.push(args[3]!.split("/").pop()!);
      return "";
    };
    const statePath = path.join(tmpDir("onb-dana-state"), "team.json");
    const dana = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath, gh });
    await dana.signIn(hub.url, { github: "dana", secret: "s3cret" });
    await dana.connect();
    const { link } = await inviteTeammate(dana, rt, { gh });
    await dana.stop(); // dana's laptop sleeps
    const erin = new TeamLink({ runtimes: () => [], broadcast: () => {}, statePath: path.join(tmpDir("onb-erin-state"), "team.json") });
    close.push(() => erin.stop());
    await erin.join(link, { github: "erin", secret: "s3cret" });
    expect(granted).toEqual([]);
    // dana's Loom wakes up: same state file, a new link to the hub
    const back = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath, gh });
    close.push(() => back.stop());
    await back.connect();
    await waitUntil(() => granted.length > 0);
    expect(granted).toEqual(["erin"]);
    // the grant was spent: reconnecting again grants nothing more
    await back.stop();
    const again = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath, gh });
    close.push(() => again.stop());
    await again.connect();
    await new Promise((r) => setTimeout(r, 200));
    expect(granted).toEqual(["erin"]);
  });

  it("an invite needs a GitHub remote, then a signed-in hub, and says so", async () => {
    const dir = tmpDir("onboard-norepo");
    git(dir, "init", "-q");
    writeProjectConfig(dir, { name: "solo", agents: [{ id: "w", kind: "echo" }], brain: { extractor: "off" } });
    const rt = await ProjectRuntime.open({ id: "onb-solo", name: "solo", dir });
    close.push(() => rt.close());
    const link = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmpDir("onb-solo-state"), "team.json") });
    close.push(() => link.stop());
    // not on GitHub: said first, signed in or not — signing in wouldn't help
    await expect(inviteTeammate(link, rt)).rejects.toThrow(/GitHub `origin` remote/);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/solo.git"], { cwd: dir });
    await expect(inviteTeammate(link, rt)).rejects.toMatchObject({ code: "signin" });
  });
});
