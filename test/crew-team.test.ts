import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdapterBase } from "../src/adapters/base.js";
import { registerAgentKind } from "../src/adapters/index.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { parseCrewPolicy, stricterCrewPolicy, capCrewPermission } from "../src/core/crew-policy.js";
import type { CrewHost } from "../src/core/crew.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { Runner, DEFAULT_RUNNER, type JobPayload, type JobProgress } from "../src/daemon/runner.js";
import { newTeamKey, sealForTeam, openFromTeam } from "../src/core/team-crypto.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const block = (actions: unknown[]) => "```loom\n" + JSON.stringify({ actions }) + "\n```";
let release: (() => void) | undefined, entered = 0, requestTurns = 0;
class CrewTeamBot extends AdapterBase {
  async available() { return true; } async start() {} async stop() { release?.(); } async interrupt() { release?.(); } async diff() { return ""; }
  async send(input: SendInput) {
    this._busy = true;
    let text = block([{ type: "done", summary: "checked" }]);
    if (input.text.startsWith("Your owner approved")) { requestTurns++; text = "read-only inspection complete"; }
    else if (this.id.includes("-lead.")) {
      if (input.text.startsWith("New goal")) text = block([{ type: "plan", cards: [{ title: "Change shared file", touches: ["shared.txt"] }] }]);
    } else if (this.id.includes("-builder.")) {
      entered++;
      if (entered === 1) await new Promise<void>(resolve => { release = resolve; });
      fs.appendFileSync(path.join(this.projectDir, "shared.txt"), "crew change\n");
      this.emit({ kind: "file_edit", payload: { path: "shared.txt" } });
    } else if (this.id.includes("-reviewer.")) text = block([{ type: "review", verdict: "approve", notes: "shared.txt:1 checked" }]);
    else if (this.id.includes("-tester.")) text = block([{ type: "test", result: "pass", log: "checked" }]);
    this.emit({ kind: "message", payload: { text } }); this.emit({ kind: "run_complete", payload: {} }); this._busy = false;
  }
}
registerAgentKind("crew-team-bot", (cfg, dir) => new CrewTeamBot(cfg.id, "crew-team-bot", dir));
let hub: Awaited<ReturnType<typeof startHubServer>>, team: string, origin: string;
const members: Record<string, { rt: ProjectRuntime; link: TeamLink; crew: string }> = {};
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("crew-team-home"); process.env.LOOM_NO_NOTIFY = "1";
  hub = await startHubServer({ port: 0, secret: "crew-test" });
  const seed = tmpDir("crew-team-seed"); origin = tmpDir("crew-team-origin");
  git(seed, "init", "-q", "-b", "main"); fs.writeFileSync(path.join(seed, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(seed, "shared.txt"), "seed\n");
  fs.writeFileSync(path.join(seed, "loom.team.json"), JSON.stringify({ crews: { maxPerMember: 3, reviewerMustDifferFromBuilders: false, planApproval: "optional" } }));
  git(seed, "add", "-A"); git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  git(origin, "init", "-q", "--bare", "-b", "main"); git(seed, "push", "-q", origin, "main");
  for (const who of ["alice", "bob"]) {
    const dir = tmpDir(`crew-${who}`); git(path.dirname(dir), "clone", "-q", origin, dir);
    git(dir, "config", "loom.repo", "acme/app"); git(dir, "config", "user.name", who); git(dir, "config", "user.email", `${who}@t`);
    git(dir, "remote", "set-head", "origin", "main");
    writeProjectConfig(dir, { name: who, agents: [{ id: "bot", kind: "crew-team-bot" }], brain: { extractor: "off" } });
    const rt = await ProjectRuntime.open({ id: `crew-team-${who}`, name: who, dir });
    const link = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmpDir(`crew-${who}-state`), "team.json") });
    link.attachRuntime(rt);
    if (who === "alice") { await link.signIn(hub.url, { github: who, secret: "crew-test" }); team = (await link.createTeam("Crew team")).id; await link.share(rt, team); }
    else { await link.join((await members.alice!.link.invite(team)).link, { github: who, secret: "crew-test" }); await link.share(rt, team); }
    const crew = rt.crews.create({ name: "Ship", planApproval: false, teammates: ["lead", "builder", "reviewer", "tester"].map(id => ({ id, agent: "bot", role: id as "lead" | "builder" | "reviewer" | "tester" })) }).id;
    members[who] = { rt, link, crew };
  }
}, 60000);
afterAll(async () => { release?.(); for (const m of Object.values(members)) { await m.link.stop(); await m.rt.close(); } await hub?.close(); });
describe("crews across two real team members", () => {
  it("holds overlapping writes atomically, reports crew presence without transcripts, and starts after release", async () => {
    const a = members.alice!, b = members.bob!;
    const first = await a.rt.crews.goal(a.crew, "Alice shared change"); await waitUntil(() => entered === 1);
    await a.link.beat(); await waitUntil(() => (b.link.status() as any).teams[0].presence.some((p: any) => p.intent?.crew === a.crew));
    const presence = (b.link.status() as any).teams[0].presence.find((p: any) => p.intent?.crew === a.crew);
    expect(presence.intent).not.toHaveProperty("text"); expect(presence.intent).not.toHaveProperty("transcript");
    const second = await b.rt.crews.goal(b.crew, "Bob shared change");
    await waitUntil(() => ["waiting_human", "waiting_team"].includes(second.status)); expect(entered).toBe(1);
    expect(second.cards[0]!.teamHold).toBeTruthy(); release!();
    await waitUntil(() => first.status === "completed" && !a.rt.crews.get(a.crew).busy);
    await a.rt.crews.apply(a.crew);
    await waitUntil(async () => !(await hub.hub.client(hub.hub.signIn("alice").token).leases(team)).some(l => l.runId === a.rt.crews.coordination(a.crew)!.id));
    await waitUntil(() => !b.rt.crews.get(b.crew).busy);
    b.rt.crews.decideOverlap(b.crew, second.cards[0]!.id, "narrow", ["shared.txt"]);
    await waitUntil(() => second.status === "completed"); expect(entered).toBe(2);
    await b.rt.crews.apply(b.crew);
  }, 60000);
  it("requires the target owner to accept and durably delivers a read-only request once", async () => {
    const a = members.alice!, b = members.bob!;
    const sent = await a.link.requestCrew(a.rt, { owner: "bob", crew: b.crew, teammate: "reviewer", text: "Inspect shared.txt and report." });
    await expect(a.link.answerCrewRequest(a.rt, sent.requestId, true)).rejects.toThrow(/owner/);
    expect(requestTurns).toBe(0);
    await b.link.answerCrewRequest(b.rt, sent.requestId, true);
    await waitUntil(() => b.rt.crews.get(b.crew).state.inbox?.some(r => r.id === sent.requestId && r.status === "delivered"));
    await b.link.answerCrewRequest(b.rt, sent.requestId, true); expect(requestTurns).toBe(1);
    await waitUntil(() => !b.rt.crews.get(b.crew).busy);
  });
  it("recovers a queued owner-approved request after a budget blocks admission without replaying a delivered turn", async () => {
    const a = members.alice!, b = members.bob!;
    await waitUntil(() => !b.rt.crews.get(b.crew).busy);
    const host = (b.rt.crews as unknown as { host: CrewHost }).host;
    const admission = vi.spyOn(host.coordinator!()!, "canStart").mockReturnValue("daily budget reached");
    const before = requestTurns;
    const sent = await a.link.requestCrew(a.rt, { owner: "bob", crew: b.crew, teammate: "reviewer", text: "Inspect the unchanged checkout." });
    try {
      await expect(b.link.answerCrewRequest(b.rt, sent.requestId, true)).rejects.toThrow(/daily budget/);
      expect(requestTurns).toBe(before);
      expect(b.rt.crews.get(b.crew).state.inbox!.find(r => r.id === sent.requestId)!.status).toBe("queued");
      admission.mockReturnValue(null);
      await b.link.answerCrewRequest(b.rt, sent.requestId, true);
      await waitUntil(() => b.rt.crews.get(b.crew).state.inbox!.find(r => r.id === sent.requestId)!.status === "delivered");
      await b.link.answerCrewRequest(b.rt, sent.requestId, true); expect(requestTurns).toBe(before + 1);
      await waitUntil(() => !b.rt.crews.get(b.crew).busy);
    } finally { admission.mockRestore(); }
  });
  it("tightens permission and budget policy instead of widening reviewed limits", () => {
    const reviewed = parseCrewPolicy({ maxTeammates: 4, budgets: { perCrewDailyUsd: 20 }, roles: { builder: { permissions: "auto" } } });
    const local = parseCrewPolicy({ maxTeammates: 8, budgets: { perCrewDailyUsd: 50 }, roles: { builder: { permissions: "bypass" } } });
    const policy = stricterCrewPolicy(reviewed, local);
    expect(policy.maxTeammates).toBe(4); expect(policy.budgets.perCrewDailyUsd).toBe(20);
    expect(capCrewPermission(policy, "builder", "bypass")).toBe("auto"); expect(capCrewPermission(policy, "reviewer", "bypass")).toBe("ask");
  });
  it("hosts a crew in a fresh runner clone, accepts owner controls at capacity, and produces a PR without merging", async () => {
    const client = hub.hub.client(hub.hub.signIn("alice").token), key = newTeamKey(1);
    const device = (await client.registerDevice({ label: "crew runner", sealPub: "runner-seal", signPub: "runner-sign" })).id;
    await client.registerRunner({ deviceId: device, kinds: ["crew-team-bot"], shared: false });
    const user = await client.me(); let runnerRt: ProjectRuntime | undefined, deliveries = 0;
    const runner = new Runner({ hub: () => client, deviceId: () => device, userId: () => user.id, github: () => "alice", teams: () => [team], keys: () => [key], feed: () => [], presence: () => [],
      kinds: async () => ["crew-team-bot"], cloneUrl: () => origin, statePath: () => "unused", config: () => ({ ...DEFAULT_RUNNER, enabled: true, isolation: "inline", capacity: 1 }),
      share: async () => {}, landing: () => { throw new Error("crew controls must not merge PRs"); },
      openProject: async (dir, name) => {
        runnerRt = await ProjectRuntime.open({ id: `runner-${path.basename(path.dirname(dir))}`, name, dir });
        vi.spyOn(runnerRt.crews, "deliver").mockImplementation(async id => {
          deliveries++; runnerRt!.crews.get(id).state.goal!.pr = { url: "https://github.com/acme/app/pull/42", at: Date.now() }; return { url: "https://github.com/acme/app/pull/42" };
        }); return runnerRt;
      }, closeProject: async rt => rt.close() });
    const payload: JobPayload = { goal: "Runner shared change", crew: { id: "ship", name: "Runner crew", teammates: ["lead", "builder", "reviewer", "tester"].map(id => ({ id, agent: "bot", role: id as "lead" | "builder" | "reviewer" | "tester" })), agents: [{ id: "bot", kind: "crew-team-bot" }] } };
    const job = await client.createJob(team, { repo: "acme/app", kind: "start", target: device, deviceId: device, sealed: sealForTeam(key, payload) });
    try {
      await runner.tick();
      await waitUntil(async () => openFromTeam<JobProgress>([key], (await client.jobs(team)).find(j => j.id === job.id)!.progress)?.status === "awaiting_approval");
      const state = runnerRt!.crews.list()[0]!, runId = runnerRt!.crews.coordination(state.id)!.id;
      const action = await client.createJob(team, { repo: "acme/app", kind: "land", target: device, deviceId: device,
        sealed: sealForTeam(key, { runId, crewAction: { jobId: job.id, action: "approve" } } satisfies JobPayload) });
      await runner.tick();
      expect((await client.jobs(team)).find(j => j.id === action.id)!.state).toBe("done");
      await waitUntil(async () => { await runner.tick(); return (await client.jobs(team)).find(j => j.id === job.id)!.state === "done"; }, { timeoutMs: 30000 });
      expect(deliveries).toBe(1); expect(git(origin, "show", "main:shared.txt")).toBe("seed\n");
    } finally { await runner.stop(); await runnerRt?.close(); }
  }, 60000);
});
