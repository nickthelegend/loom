/**
 * #431 — regressions for the round-3 audit of the model adapter, the brain,
 * team leases and memories, skill install and onboarding. One block per
 * finding, each failing on the code before its fix.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AcpAdapter } from "../src/adapters/acp.js";
import { ModelAdapter } from "../src/adapters/model.js";
import { Brain, type Memory } from "../src/core/brain.js";
import { applyExtraction } from "../src/core/brain-extract.js";
import { EventLog } from "../src/core/eventlog.js";
import { MAX_HOPS, applyWrite, runReadTool } from "../src/core/model-tools.js";
import { setProvider } from "../src/core/providers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { SkillInstallError, authorSkill, installSkillFromDir } from "../src/core/skill-install.js";
import { memoryHmac, newTeamKey, sealForTeam } from "../src/core/team-crypto.js";
import { MemoryHub } from "../src/core/team-hub.js";
import { heldZone, scopeOf } from "../src/core/team-leases.js";
import { writeLimits } from "../src/core/turn-gate.js";
import { Onboarding, type OnboardHost, type OnboardJob } from "../src/daemon/onboard.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { TeamBrain, shareable } from "../src/daemon/team-brain.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const prov = { agentId: "user", eventId: 0, ts: Date.now() };

async function openBrain(): Promise<{ brain: Brain; log: EventLog }> {
  const dir = path.join(tmpDir("r3-brain"), ".loom");
  fs.mkdirSync(dir, { recursive: true });
  const log = await EventLog.open(dir);
  return { brain: new Brain(log), log };
}

// ── 1. model tools and symlinks ────────────────────────────────────────────

describe("1. model tools don't follow links out of the project", () => {
  function linked() {
    const project = tmpDir("r3-proj");
    const outside = tmpDir("r3-outside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-VALUE\n");
    fs.symlinkSync(outside, path.join(project, "leak"));
    fs.mkdirSync(path.join(project, ".git"));
    fs.writeFileSync(path.join(project, ".git", "config"), "GIT-INTERNALS\n");
    fs.symlinkSync(path.join(project, ".git"), path.join(project, "gitlink"));
    fs.writeFileSync(path.join(project, "ok.txt"), "plain project file\n");
    fs.symlinkSync(path.join(project, "ok.txt"), path.join(project, "alias.txt"));
    return { project, outside };
  }

  it("refuses to read, search or write through a link that leaves the project or reaches .git", () => {
    const { project, outside } = linked();
    const read = runReadTool(project, { id: "1", name: "read_file", args: { path: "leak/secret.txt" } });
    expect(read.ok).toBe(false);
    expect(read.content).not.toContain("TOP-SECRET-VALUE");
    const git = runReadTool(project, { id: "2", name: "read_file", args: { path: "gitlink/config" } });
    expect(git.ok).toBe(false);
    expect(git.content).not.toContain("GIT-INTERNALS");
    const search = runReadTool(project, { id: "3", name: "search", args: { query: "TOP-SECRET" } });
    expect(search.content).not.toContain("TOP-SECRET-VALUE");
    const write = applyWrite(project, { id: "4", name: "write_file", args: { path: "leak/planted.txt", content: "x" } });
    expect(write.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, "planted.txt"))).toBe(false);
    // a dangling link would create its target wherever it points
    fs.symlinkSync(path.join(outside, "made-by-model.txt"), path.join(project, "dangle"));
    expect(applyWrite(project, { id: "5", name: "write_file", args: { path: "dangle", content: "x" } }).ok).toBe(false);
    expect(fs.existsSync(path.join(outside, "made-by-model.txt"))).toBe(false);
  });

  it("still reads, searches and writes normally inside the project, links within it included", () => {
    const { project } = linked();
    expect(runReadTool(project, { id: "1", name: "read_file", args: { path: "alias.txt" } }).content).toContain("plain project file");
    expect(runReadTool(project, { id: "2", name: "search", args: { query: "plain project" } }).content).toMatch(/^ok\.txt:1:/m);
    expect(applyWrite(project, { id: "3", name: "write_file", args: { path: "src/new/file.ts", content: "x\n" } }).ok).toBe(true);
    expect(fs.readFileSync(path.join(project, "src", "new", "file.ts"), "utf8")).toBe("x\n");
  });
});

// ── 2. model adapter runs only what it offered ─────────────────────────────

let provider: http.Server | null = null;
afterEach(async () => {
  provider?.closeAllConnections?.();
  await new Promise<void>((r) => (provider ? provider.close(() => r()) : r()));
  provider = null;
});

/** A provider whose reply is whatever `reply` says for the n-th request. */
async function scriptedProvider(reply: (n: number, body: Record<string, unknown>) => unknown[]) {
  const seen: Array<Record<string, unknown>> = [];
  provider = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of reply(seen.length, body)) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => provider!.listen(0, "127.0.0.1", () => resolve((provider!.address() as net.AddressInfo).port)));
  const id = `r3-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "R3" });
  return { id, seen };
}

const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } }] } }],
});
const say = (text: string) => ({ choices: [{ delta: { content: text } }] });
const toolMessages = (seen: Array<Record<string, unknown>>) =>
  seen.flatMap((b) => (b.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content));

describe("2. a model agent runs only the tools it was offered", () => {
  it("with tools off, a returned read_file isn't run", async () => {
    process.env.LOOM_HOME = tmpDir("r3-home-model");
    const dir = tmpDir("r3-model-proj");
    fs.writeFileSync(path.join(dir, "secret.txt"), "PROJECT-SECRET\n");
    const { id, seen } = await scriptedProvider((n) => (n === 1 ? [toolCall("read_file", { path: "secret.txt" })] : [say("done")]));
    await new ModelAdapter("m", dir, { provider: id, model: "x", tools: false }).send({ text: "hi" });
    expect(JSON.stringify(seen)).not.toContain("PROJECT-SECRET");
    expect(toolMessages(seen).join("\n")).toMatch(/no tool called "read_file"/);
  });

  it("with write off, bypass doesn't let a returned write_file through", async () => {
    process.env.LOOM_HOME = tmpDir("r3-home-model");
    const dir = tmpDir("r3-model-proj");
    const { id } = await scriptedProvider((n) => (n === 1 ? [toolCall("write_file", { path: "PWNED.md", content: "x" })] : [say("done")]));
    await new ModelAdapter("m", dir, { provider: id, model: "x", tools: true, write: false, permissions: "bypass" }).send({ text: "hi" });
    expect(fs.existsSync(path.join(dir, "PWNED.md"))).toBe(false);
  });

  it("the hop limit holds when the model keeps calling tools it was no longer offered", async () => {
    process.env.LOOM_HOME = tmpDir("r3-home-model");
    const dir = tmpDir("r3-model-proj");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const { id, seen } = await scriptedProvider(() => [toolCall("read_file", { path: "a.txt" })]);
    const run = new ModelAdapter("m", dir, { provider: id, model: "x", tools: true }).send({ text: "hi" });
    const capped = await Promise.race([run.then(() => "finished"), new Promise((r) => setTimeout(() => r("looping"), 5000))]);
    expect(capped).toBe("finished");
    expect(seen.length).toBe(MAX_HOPS + 1);
    expect(seen.at(-1)!.tools).toBeUndefined();
  });
});

// ── 3. Stop reaches a turn waiting for a daemon slot ───────────────────────

describe("3. Stop cancels a turn that is waiting for a slot", () => {
  let daemon: LoomDaemon | null = null;
  afterEach(async () => {
    await daemon?.close();
    daemon = null;
  });

  it("the stopped prompt never runs once the slot frees up", async () => {
    process.env.LOOM_HOME = tmpDir("r3-home-gate");
    process.env.LOOM_NO_NOTIFY = "1";
    writeLimits({ maxTurns: 1, minFreePct: 0 });
    const was = process.env.LOOM_TURN_GATE;
    delete process.env.LOOM_TURN_GATE;
    try {
      daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
      const { host, port } = await daemon.listen();
      const token = readDaemonConfig()!.adminToken;
      const api = async (p: string, body?: unknown) => {
        const res = await fetch(`http://${host}:${port}${p}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return (await res.json()) as Record<string, unknown>;
      };
      const add = async (name: string, agent: string) => {
        const dir = makeProjectDir({ name, agents: [{ id: agent, kind: "echo", role: "executor" }] });
        return ((await api("/api/projects", { dir })).project as { id: string }).id;
      };
      const pa = await add("gate-a", "a");
      const pb = await add("gate-b", "b");
      const events = async (pid: string) =>
        ((await api(`/api/projects/${pid}/events?limit=200`)).events ?? []) as Array<{ kind: string; payload: Record<string, unknown> }>;

      await api(`/api/projects/${pa}/messages`, { text: "sleep:1500 one", agentId: "a" });
      await new Promise((r) => setTimeout(r, 150));
      await api(`/api/projects/${pb}/messages`, { text: "two", agentId: "b" });
      await waitUntil(async () => (await events(pb)).some((e) => e.kind === "status" && e.payload.state === "queued_for_slot"));

      expect(await api(`/api/projects/${pb}/interrupt`, { chat: "main" })).toEqual({ interrupted: "b" });
      await waitUntil(async () => (await events(pa)).some((e) => e.kind === "message" && String(e.payload.text).startsWith("echo(a)")));
      await new Promise((r) => setTimeout(r, 400));
      expect((await events(pb)).some((e) => e.kind === "message" && String(e.payload.text).startsWith("echo(b)"))).toBe(false);
    } finally {
      if (was !== undefined) process.env.LOOM_TURN_GATE = was;
    }
  }, 30_000);
});

// ── 4. ACP stop settles what's pending ─────────────────────────────────────

describe("4. stopping an ACP agent settles its pending requests", () => {
  it("a send waiting on an agent that never answers rejects once stopped", async () => {
    process.env.LOOM_HOME = tmpDir("r3-home-acp");
    const mute = [process.execPath, "-e", "process.stdin.resume(); setInterval(() => {}, 1e6)"];
    const a = new AcpAdapter("mute", tmpDir("r3-acp"), { command: mute });
    a.onEvent(() => {});
    const sent = a.send({ text: "hello" });
    sent.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await a.stop();
    const outcome = await Promise.race([
      sent.then(() => "resolved", (e: Error) => `rejected: ${e.message}`),
      new Promise((r) => setTimeout(() => r("still pending"), 3000)),
    ]);
    expect(outcome).toMatch(/^rejected: .*stopped/);
    expect(a.busy()).toBe(false);
  });
});

// ── 5. external content stays untrusted through an UPDATE ──────────────────

describe("5. an UPDATE learned from outside content is untrusted", () => {
  it("marks the updated memory untrusted, so it stops being shareable", async () => {
    const { brain } = await openBrain();
    const { memory } = brain.add({ kind: "fact", text: "The payments API allows 100 requests per minute.", provenance: prov });
    expect(shareable(memory)).toBe(true);
    const turn = "The vendor page says: the payments API allows 5000 requests per minute now.";
    const res = applyExtraction(
      brain,
      [{ op: "UPDATE", id: "1", text: "The payments API allows 5000 requests per minute.", evidence: "the payments API allows 5000 requests per minute" }],
      turn,
      [{ intId: "1", memory }],
      { by: "codex", eventId: 1, untrusted: true },
    );
    expect(res.updated).toHaveLength(1);
    const after = brain.get(memory.id)!;
    expect(after.text).toContain("5000");
    expect(after.untrusted).toBe(true);
    expect(shareable(after)).toBe(false);
  });

  it("a trusted UPDATE never clears an existing untrusted flag", async () => {
    const { brain } = await openBrain();
    const { memory } = brain.add({ kind: "fact", text: "Rate limit is 100 per minute.", provenance: prov, untrusted: true });
    applyExtraction(brain, [{ op: "UPDATE", id: "1", text: "Rate limit is 200 per minute.", evidence: "rate limit is 200 per minute" }],
      "we measured: rate limit is 200 per minute", [{ intId: "1", memory }], { by: "codex", eventId: 1 });
    expect(brain.get(memory.id)!.untrusted).toBe(true);
  });
});

// ── 6. export/import keeps privacy, trust and expiry ───────────────────────

describe("6. a brain round trip keeps private, untrusted and expiry", () => {
  it("re-imports private and untrusted as they were, and leaves expired memories behind", async () => {
    const { brain } = await openBrain();
    brain.add({ kind: "fact", text: "My home lab runs on 10.0.0.5.", provenance: prov, private: true });
    brain.add({ kind: "fact", text: "A blog post says the SDK retries 3 times.", provenance: prov, untrusted: true });
    brain.add({ kind: "task", text: "Currently migrating the login form.", provenance: prov, expiresAt: Date.now() - 1000 });
    brain.add({ kind: "task", text: "Wire the logout button next.", provenance: prov, expiresAt: Date.now() + 3_600_000 });
    const doc = JSON.parse(JSON.stringify(brain.export("p")));

    const { brain: other } = await openBrain();
    other.import(doc, prov);
    const all = other.all();
    const byText = (t: string) => all.find((m) => m.text.includes(t));
    expect(byText("home lab")!.private).toBe(true);
    expect(byText("blog post")!.untrusted).toBe(true);
    expect(shareable(byText("home lab")!)).toBe(false);
    expect(shareable(byText("blog post")!)).toBe(false);
    expect(byText("migrating the login form")).toBeUndefined();
    expect(byText("logout button")!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("an import of an already-expired entry from a hand-made file doesn't resurrect it", async () => {
    const { brain } = await openBrain();
    const out = brain.import({ format: "loom-brain", version: 1, project: "p", exportedAt: 0,
      memories: [{ kind: "task", text: "Old task.", expiresAt: 1 }, { kind: "fact", text: "Kept fact.", private: "yes" as unknown as boolean }] }, prov);
    expect(out.added).toBe(1);
    expect(brain.all().map((m) => [m.text, m.private])).toEqual([["Kept fact.", true]]);
  });
});

// ── 7, 8. team memories: withdrawal, restore, and confirmations ────────────

async function hubSetup() {
  const hub = new MemoryHub();
  const a = hub.client(hub.signIn("alice").token);
  const b = hub.client(hub.signIn("bob").token);
  const team = await a.createTeam("acme");
  await b.redeemInvite((await a.createInvite(team.id)).invite);
  await a.shareRepo(team.id, "acme/app");
  const da = await a.registerDevice({ label: "a", sealPub: "s", signPub: "pa" });
  const db = await b.registerDevice({ label: "b", sealPub: "s", signPub: "pb" });
  const key = newTeamKey(1);
  return { hub, a, b, team, da, db, key };
}

describe("7. making a shared memory private withdraws it from the team, not from its author", () => {
  it("stays in the author's pool while private, and goes back to the team when restored", async () => {
    const { a, team, da, key } = await hubSetup();
    const { brain, log } = await openBrain();
    const rt = { brain, log, info: { dir: tmpDir("r3-tb") } } as unknown as ProjectRuntime;
    const tb = new TeamBrain(rt, {
      hub: () => a,
      deviceId: () => da.id,
      github: () => "alice",
      share: async () => ({ teamId: team.id, repo: "acme/app" }),
      keys: () => [key],
      feed: () => [],
      leases: () => [],
      exec: async () => "",
    });
    try {
      const { memory } = brain.add({ kind: "decision", text: "We deploy from the release branch only.", provenance: prov });
      const row = async () => (await a.teamMemories(team.id, "acme/app", { history: true })).find((m) => m.id === memory.id);
      await tb.sync();
      expect((await row())?.state).toBe("live");

      brain.update(memory.id, { private: true }, "user");
      await tb.sync();
      expect((await row())?.state).toBe("forgotten"); // withdrawn from the team…
      expect(tb.pool()!.some((m) => m.id === memory.id)).toBe(true); // …but still the author's own

      brain.update(memory.id, { private: false }, "user");
      await tb.sync();
      expect((await row())?.state).toBe("live"); // restored, so shared again
      expect(tb.pool()!.filter((m) => m.id === memory.id)).toHaveLength(1);
    } finally {
      tb.stop();
    }
  });
});

describe("8. an edited team memory starts its confirmations over", () => {
  it("an author's edit, or a re-publish with new words, drops the teammates who confirmed the old words", async () => {
    const { a, b, team, da, db, key } = await hubSetup();
    const m = (id: string, text: string, dev: string) => ({ id, repo: "acme/app", hmac: memoryHmac(key, text), sealed: sealForTeam(key, { text }), deviceId: dev });
    await a.publishMemory(team.id, m("mem1", "Use zod for validation.", da.id));
    expect((await b.publishMemory(team.id, m("mem9", "Use zod for validation.", db.id))).memory.confirmedBy).toEqual(["alice", "bob"]);
    const edited = await a.updateTeamMemory(team.id, "mem1", { hmac: memoryHmac(key, "Use valibot."), sealed: sealForTeam(key, { text: "Use valibot." }) });
    expect(edited.confirmedBy).toEqual(["alice"]);

    await a.publishMemory(team.id, m("mem2", "Tabs, not spaces.", da.id));
    await b.publishMemory(team.id, m("mem8", "Tabs, not spaces.", db.id));
    const again = await a.publishMemory(team.id, m("mem2", "Spaces, not tabs.", da.id));
    expect(again.memory.confirmedBy).toEqual(["alice"]);
    // the same words re-published keep their confirmations
    await b.publishMemory(team.id, m("mem7", "Spaces, not tabs.", db.id));
    expect((await a.publishMemory(team.id, m("mem2", "Spaces, not tabs.", da.id))).memory.confirmedBy).toEqual(["alice", "bob"]);
  });
});

// ── 9. every hard zone a claim touches is checked ──────────────────────────

const TRACKED = ["src/auth/session.ts", "src/auth/oauth.ts", "db/migrations/001_init.sql", "README.md"];

describe("9. a claim spanning two hard zones is refused when the second is held", () => {
  const zones = ["src/auth/**", "db/migrations/**"];

  it("the reference hub refuses it", async () => {
    const { a, b, team, da, db } = await hubSetup();
    const claim = (dev: string, runId: string, globs: string[]) => ({ deviceId: dev, repo: "acme/app", runId, taskId: "t1", hardZones: zones, ...scopeOf(globs, TRACKED) });
    expect((await a.claimLease(team.id, claim(da.id, "o1", ["db/migrations/**"]))).lease).toBeTruthy();
    const both = await b.claimLease(team.id, claim(db.id, "o2", ["src/auth/**", "db/migrations/**"]));
    expect(both.lease).toBeNull();
    expect(both.blockedBy).toMatchObject({ zone: "db/migrations/**", lease: { github: "alice" } });
  });

  it("the daemon's pre-check (heldZone) finds the held second zone", () => {
    const alice = { ...scopeOf(["db/migrations/**"], TRACKED), github: "alice" };
    const held = heldZone(scopeOf(["src/auth/**", "db/migrations/**"], TRACKED), zones, [alice]);
    expect(held).toMatchObject({ zone: "db/migrations/**", holder: { github: "alice" } });
    expect(heldZone(scopeOf(["src/auth/**"], TRACKED), zones, [alice])).toBeNull();
  });
});

// ── 10. skill install stays inside the project ─────────────────────────────

describe("10. installing a skill can't escape through a symlinked skills directory", () => {
  function skillSource(id: string) {
    const src = path.join(tmpDir("r3-skill-src"), id);
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), `---\nname: ${id}\ndescription: test skill\n---\n\nDo it.\n`);
    return src;
  }

  it("refuses to write or force-delete through skills -> elsewhere", () => {
    const project = tmpDir("r3-skill-proj");
    const outside = tmpDir("r3-skill-outside");
    fs.mkdirSync(path.join(outside, "deploy"));
    fs.writeFileSync(path.join(outside, "deploy", "precious.txt"), "keep me\n");
    fs.symlinkSync(outside, path.join(project, "skills"));
    expect(() => installSkillFromDir(skillSource("lint"), project)).toThrow(SkillInstallError);
    expect(fs.existsSync(path.join(outside, "lint"))).toBe(false);
    expect(() => installSkillFromDir(skillSource("deploy"), project, { force: true })).toThrow(/outside the project/);
    expect(fs.readFileSync(path.join(outside, "deploy", "precious.txt"), "utf8")).toBe("keep me\n");
    expect(() => authorSkill(project, { id: "new-one", name: "New", description: "d" })).toThrow(/outside the project/);
    expect(fs.existsSync(path.join(outside, "new-one"))).toBe(false);
  });

  it("still installs into a real skills directory", () => {
    const project = tmpDir("r3-skill-proj");
    const out = installSkillFromDir(skillSource("lint"), project);
    expect(fs.existsSync(path.join(project, "skills", "lint", "SKILL.md"))).toBe(true);
    expect(out.id).toBe("lint");
    expect(installSkillFromDir(skillSource("lint"), project, { force: true }).replaced).toBe(true);
  });
});

// ── 11. onboarding retries never delete what they didn't make ──────────────

describe("11. a failed clone retry leaves a directory it didn't create alone", () => {
  function onboarding(home: string, clone: OnboardHost["clone"]) {
    const host = {
      team: {} as OnboardHost["team"],
      projects: () => [],
      addProject: async () => { throw new Error("unused"); },
      runtime: async () => { throw new Error("unused"); },
      projectsHome: home,
      clone,
      gh: async () => "[]",
      accessWaitMs: 5000,
      accessPollMs: 20,
    } satisfies OnboardHost;
    const ob = new Onboarding(host);
    const job: OnboardJob = { id: "j", state: "running", team: null, repo: "acme/app", from: "alice", startedAt: 0,
      steps: [{ id: "repo", label: "repo", state: "running" }] };
    const repoDir = (ob as unknown as { repoDir(j: OnboardJob, inv: unknown, o: object): Promise<string> }).repoDir.bind(ob);
    return () => repoDir(job, { repo: "acme/app", from: "alice" }, {});
  }

  it("files that appear at the destination while it waits for access survive the next failure", async () => {
    const home = tmpDir("r3-onboard-home");
    const target = path.join(home, "app");
    let attempt = 0;
    const get = onboarding(home, async (_repo, dir) => {
      attempt++;
      if (attempt === 1) throw new Error("GraphQL: Could not resolve to a Repository (404 not found)");
      // meanwhile, something else put work at the destination
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "precious.txt"), "not Loom's\n");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "partial"), "half a clone");
      throw new Error("fatal: early EOF");
    });
    await expect(get()).rejects.toThrow(/couldn't clone acme\/app/);
    expect(fs.readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("not Loom's\n");
    // and the half-made clone was cleaned up
    expect(fs.readdirSync(home).filter((n) => n.includes("loom-clone"))).toEqual([]);
  });

  it("a clone that succeeds after the destination filled up lands beside it, not on it", async () => {
    const home = tmpDir("r3-onboard-home");
    const target = path.join(home, "app");
    let attempt = 0;
    const get = onboarding(home, async (_repo, dir) => {
      attempt++;
      if (attempt === 1) throw new Error("remote: Repository not found.");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "precious.txt"), "not Loom's\n");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
    });
    const dir = await get();
    expect(dir).toBe(`${target}-2`);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# app\n");
    expect(fs.readdirSync(target)).toEqual(["precious.txt"]);
  });
});

// ── 8, 9 on the hosted hub's SQL ───────────────────────────────────────────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasPg = (() => {
  try {
    execFileSync("initdb", ["--version"], { stdio: "ignore" });
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPg)("8, 9 on Postgres (supabase/migrations)", () => {
  let dataDir = "", sockDir = "", port = 0;
  let pg: ChildProcess | null = null;
  const ALICE = "00000000-0000-4000-8000-00000000a11c";
  const BOB = "00000000-0000-4000-8000-000000000b0b";
  let team = "", aliceDev = "", bobDev = "";

  const psql = (sql: string, as?: string, user?: string): string =>
    execFileSync("psql", ["-h", sockDir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], {
      input: (as ? `set role ${as};\n${user ? `select set_config('request.jwt.claim.sub', '${user}', false);\n` : ""}` : "") + sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).split("\n").filter((l) => l !== "" && l !== user).join("\n").trim();
  const asUser = (user: string, sql: string) => psql(sql, "authenticated", user).split("\n").at(-1) ?? "";

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-r3pg-"));
    sockDir = fs.mkdtempSync(path.join("/tmp", "lr3-"));
    const env = { ...process.env, LC_ALL: "C", LANG: "C" };
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"], { stdio: "ignore", env });
    port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    pg = spawn("postgres", ["-D", dataDir, "-p", String(port), "-k", sockDir, "-c", "listen_addresses="], { stdio: "ignore", env });
    await waitUntil(() => { try { psql("select 1"); return true; } catch { return false; } }, { timeoutMs: 20_000, intervalMs: 200 });
    psql(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create schema extensions;
      create extension pgcrypto schema extensions;
      create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth, extensions to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    for (const m of fs.readdirSync(path.join(root, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
      psql(fs.readFileSync(path.join(root, "supabase", "migrations", m), "utf8"));
    }
    psql(`insert into auth.users (id, raw_user_meta_data, raw_app_meta_data) values
      ('${ALICE}', '{"user_name":"alice"}', '{"provider":"github"}'), ('${BOB}', '{"user_name":"bob"}', '{"provider":"github"}');`);
    team = asUser(ALICE, "select id from public.create_team('Acme');");
    aliceDev = asUser(ALICE, "select id from public.register_device('mac', 'sealA', 'signA');");
    bobDev = asUser(BOB, "select id from public.register_device('mbp', 'sealB', 'signB');");
    const invite = JSON.parse(asUser(ALICE, `select public.create_invite('${team}', 3600);`)).invite;
    asUser(BOB, `select public.redeem_invite('${invite}');`);
    asUser(ALICE, `select public.share_repo('${team}', 'acme/app');`);
  }, 60_000);

  afterAll(async () => {
    if (pg) {
      pg.kill("SIGINT");
      await new Promise((r) => pg!.once("exit", r));
    }
    for (const d of [dataDir, sockDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it("claim_lease and extend_lease check every hard zone the scope touches", () => {
    const claim = (user: string, dev: string, run: string, globs: string, prefixes: string) =>
      JSON.parse(asUser(user, `select public.claim_lease('${team}', '{"deviceId":"${dev}","repo":"acme/app","runId":"${run}","taskId":"t1","globs":${globs},"files":[],"prefixes":${prefixes},"hardZones":["src/auth/**","db/migrations/**"]}');`));
    expect(claim(ALICE, aliceDev, "z1", '["db/migrations/**"]', '["db/migrations/"]').lease).toBeTruthy();
    const both = claim(BOB, bobDev, "z2", '["src/auth/**","db/migrations/**"]', '["src/auth/","db/migrations/"]');
    expect(both.lease).toBeNull();
    expect(both.blockedBy.zone).toBe("db/migrations/**");
    // a lease of bob's in the free zone, widened into both: refused the same way
    const mine = claim(BOB, bobDev, "z3", '["src/auth/**"]', '["src/auth/"]').lease;
    const wider = JSON.parse(asUser(BOB, `select public.extend_lease('${team}', '${mine.id}', '{"globs":["src/auth/x/**","db/migrations/**"],"files":[],"prefixes":["src/auth/x/","db/migrations/"]}', '["src/auth/**","db/migrations/**"]');`));
    expect(wider.lease).toBeNull();
    expect(wider.blockedBy.zone).toBe("db/migrations/**");
  });

  it("update_team_memory and a re-publish with new words reset confirmed_by", () => {
    const pub = (user: string, dev: string, id: string, hmac: string) =>
      JSON.parse(asUser(user, `select public.publish_memory('${team}', '{"id":"${id}","repo":"acme/app","hmac":"${hmac}","sealed":{"v":1,"c":"x"},"deviceId":"${dev}"}');`));
    pub(ALICE, aliceDev, "mem1", "v1:zod");
    expect(pub(BOB, bobDev, "mem9", "v1:zod").memory.confirmed_by).toEqual(["alice", "bob"]);
    asUser(ALICE, `select public.update_team_memory('${team}', 'mem1', 'v1:valibot', '{"v":1,"c":"y"}');`);
    expect(asUser(ALICE, `select array_to_string(confirmed_by, ',') from public.team_memories where id = 'mem1';`)).toBe("alice");

    pub(ALICE, aliceDev, "mem2", "v1:tabs");
    pub(BOB, bobDev, "mem8", "v1:tabs");
    expect(pub(ALICE, aliceDev, "mem2", "v1:spaces").memory.confirmed_by).toEqual(["alice"]);
  });
});

export type _M = Memory;
