/**
 * Agent Teams, Phase 1 — a crew works a goal: the Lead plans, you approve,
 * builders build in the goal's worktree, the reviewer and tester gate each
 * card, and the branch is yours to apply.
 *
 * Teammates are a scripted adapter answering per teammate (the model is the
 * only thing faked); the worktree, commits, board cards, threads and the
 * channel are all real.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerAgentKind } from "../src/adapters/index.js";
import { AdapterBase } from "../src/adapters/base.js";
import { parseCrewReply, protocolFor } from "../src/core/crew-protocol.js";
import { teammatesFromTemplate } from "../src/core/crew.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { SendInput } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const loom = (actions: unknown[]) => "Sure.\n```loom\n" + JSON.stringify({ actions }) + "\n```";

/** What each teammate says, by teammate id: a function of its turn. */
type Script = (input: SendInput, dir: string, n: number) => string | { text: string; ask?: string } | { silent: true };
let scripts: Record<string, Script> = {};
const turns: Array<{ teammate: string; text: string; briefing: string; instance: string }> = [];

class CrewBot extends AdapterBase {
  private n = 0;
  private stopped = false;
  async available() { return true; }
  async start() {}
  async stop() {}
  async interrupt() { this.stopped = true; }
  async diff() { return ""; }
  async send(input: SendInput): Promise<void> {
    this._busy = true;
    const teammate = this.id.split(".")[0]!.split("-").slice(2).join("-"); // crew-<crew>-<teammate>.<agent>
    turns.push({ teammate, text: input.text, briefing: input.briefing ?? "", instance: this.id });
    const out = (scripts[teammate] ?? (() => loom([{ type: "done", summary: "ok" }])))(input, this.projectDir, this.n++);
    if (typeof out === "object" && "silent" in out) {
      // a model that never answers: nothing until interrupted
      this.stopped = false;
      while (!this.stopped) await new Promise((r) => setTimeout(r, 10));
      this.emit({ kind: "run_complete", payload: {} });
      this._busy = false;
      return;
    }
    const reply = typeof out === "string" ? { text: out } : out;
    if (reply.ask) this.emit({ kind: "needs_input", payload: { question: reply.ask } });
    else if (reply.text.startsWith("fail:")) this.emit({ kind: "error", payload: { message: reply.text.slice(5) } });
    else this.emit({ kind: "message", payload: { text: reply.text } });
    this.emit({ kind: "run_complete", payload: {} });
    this._busy = false;
  }
}
registerAgentKind("crewbot", (cfg, dir) => new CrewBot(cfg.id, "crewbot", dir));

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; scripts = {}; turns.length = 0; });

async function project(crew = true) {
  const dir = tmpDir("crew");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  writeProjectConfig(dir, {
    name: "crewapp",
    agents: [{ id: "big", kind: "crewbot" }, { id: "small", kind: "crewbot" }],
    brain: { extractor: "off" },
  });
  rt = await ProjectRuntime.open({ id: `crew-${path.basename(dir)}`, name: "crewapp", dir });
  const view = crew
    ? rt.crews.create({
        name: "Ship",
        teammates: [
          { id: "lead", agent: "big", role: "lead" },
          { id: "builder", agent: "small", role: "builder" },
          { id: "reviewer", agent: "big", role: "reviewer" },
          { id: "tester", agent: "small", role: "tester" },
        ],
      })
    : null;
  return { dir, rt, crew: view };
}

const write = (dir: string, file: string, body: string) => fs.writeFileSync(path.join(dir, file), body);

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-crew");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("crew protocol", () => {
  it("lets each role take only its own actions", () => {
    const reply = loom([{ type: "plan", cards: [{ title: "a" }] }, { type: "review", verdict: "lgtm", notes: "fine" }]);
    expect(parseCrewReply(reply, "lead")).toMatchObject({ found: true, allowed: [{ type: "plan" }], refused: [{ type: "review" }] });
    expect(parseCrewReply(reply, "reviewer").allowed).toEqual([{ type: "review", verdict: "approve", notes: "fine" }]);
    expect(parseCrewReply("no block here", "builder").found).toBe(false);
    expect(protocolFor("tester")).toContain('"type":"test"');
    expect(protocolFor("tester")).not.toContain('"type":"plan"');
  });

  it("fills a template from the roster, with a reviewer off the builders' vendor", () => {
    const tms = teammatesFromTemplate("ship", [{ id: "cx", kind: "codex" }, { id: "oc", kind: "opencode" }, { id: "cc", kind: "claude-code" }]);
    expect(tms.map((t) => [t.id, t.agent])).toEqual([
      ["lead", "cc"], ["builder-1", "cx"], ["builder-2", "oc"], ["reviewer", "cc"], ["tester", "oc"],
    ]);
  });
});

describe("a crew works a goal", () => {
  it("plans, waits for approval, builds, reviews (with one round of changes), tests and finishes", async () => {
    const { dir, rt, crew } = await project();
    scripts = {
      lead: (input) =>
        input.text.startsWith("New goal")
          ? loom([{ type: "plan", cards: [
              { title: "Add greeting", detail: "hello.txt says hello", touches: ["hello.txt"] },
              { title: "Add farewell", detail: "bye.txt", blockedBy: ["Add greeting"] },
            ] }])
          : loom([{ type: "done", summary: "Greeting and farewell, reviewed and tested." }]),
      builder: (input, wd) => {
        if (/Your card: Add greeting/.test(input.text)) write(wd, "hello.txt", "helo\n");
        if (/Back to you on "Add greeting"/.test(input.text)) write(wd, "hello.txt", "hello\n");
        if (/Your card: Add farewell/.test(input.text)) write(wd, "bye.txt", "bye\n");
        return loom([{ type: "done", summary: "made the file" }, { type: "post", to: "@tester", text: "it's a plain text file" }]);
      },
      reviewer: (input) =>
        /helo/.test(input.text) && !/\+hello/.test(input.text)
          ? loom([{ type: "review", verdict: "changes", notes: "hello.txt:1 typo — helo" }])
          : loom([{ type: "review", verdict: "approve", notes: "good" }]),
      tester: () => loom([{ type: "test", result: "pass", log: "2 passed" }]),
    };
    const goal = await rt.crews.goal(crew!.id, "Greet and say goodbye");
    expect(goal.branch).toBe(`loom/crew/ship/${goal.id}`);
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "awaiting_approval", { timeoutMs: 10_000 });
    const planned = rt.crews.get(crew!.id).state.goal!;
    expect(planned.cards.map((c) => c.title)).toEqual(["Add greeting", "Add farewell"]);
    expect(planned.cards[1]!.blockedBy).toEqual([planned.cards[0]!.id]);
    // the plan is on the board, as crew cards
    expect(rt.boardTasks().filter((t) => t.crew === "ship").map((t) => [t.title, t.stage])).toEqual([["Add greeting", "planned"], ["Add farewell", "planned"]]);
    // nobody builds before you OK it
    expect(turns.map((t) => t.teammate)).toEqual(["lead"]);
    // the Lead's briefing carries its role, the crew, and the protocol
    expect(turns[0]!.briefing).toMatch(/You are lead, the lead on Ship/);
    expect(turns[0]!.briefing).toContain('"type":"plan"');

    rt.crews.approve(crew!.id);
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "completed", { timeoutMs: 15_000 });
    const g = rt.crews.get(crew!.id).state.goal!;
    expect(g.summary).toBe("Greeting and farewell, reviewed and tested.");
    expect(g.cards.map((c) => [c.title, c.stage, c.rounds])).toEqual([["Add greeting", "done", 1], ["Add farewell", "done", 0]]);
    expect(turns.map((t) => t.teammate)).toEqual([
      "lead", "builder", "reviewer", "builder", "reviewer", "tester", "builder", "reviewer", "tester", "lead",
    ]);
    // the review went back to the same builder with the reviewer's notes
    expect(turns[3]!.text).toMatch(/hello\.txt:1 typo/);
    // a post to a teammate reaches them on their next turn
    expect(turns[5]!.briefing).toMatch(/builder \(builder\) says: it's a plain text file/);
    // the work is on the goal's branch, not yours, with crew trailers
    expect(fs.existsSync(path.join(dir, "hello.txt"))).toBe(false);
    expect(git(dir, "show", `${g.branch}:hello.txt`)).toBe("hello\n");
    expect(git(dir, "log", "--format=%B", "-n", "1", g.branch)).toMatch(/Loom-Crew: ship\nLoom-Goal: .+\nLoom-Card: .+\nLoom-Teammate: builder/);
    expect(rt.boardTasks().filter((t) => t.crew === "ship").every((t) => t.stage === "done")).toBe(true);
    // the channel tells the story
    const phases = rt.log.list({ kinds: ["crew"] }).map((e) => e.payload.phase);
    expect(phases).toEqual(expect.arrayContaining(["goal_started", "planned", "plan_approved", "claimed", "reviewed", "tested", "card_done", "completed"]));

    // apply merges the goal into the branch you're on
    const applied = await rt.crews.apply(crew!.id);
    expect(applied.into).toBe("main");
    expect(fs.readFileSync(path.join(dir, "bye.txt"), "utf8")).toBe("bye\n");
    expect(fs.existsSync(g.dir)).toBe(false);
  });

  it("a teammate's question waits in the channel and your answer carries the goal on", async () => {
    const { rt, crew } = await project();
    rt.crews.update(crew!.id, { planApproval: false });
    scripts = {
      lead: (input) => (input.text.startsWith("New goal") ? loom([{ type: "plan", cards: [{ title: "Make the file" }] }]) : loom([{ type: "done", summary: "done" }])),
      builder: (input, wd) => {
        if (!/The answer: (\S+)/.test(input.briefing ?? "")) return { text: "", ask: "Which file name?" };
        write(wd, /The answer: (\S+)/.exec(input.briefing!)![1]!, "x\n");
        return loom([{ type: "done", summary: "made it" }]);
      },
    };
    await rt.crews.goal(crew!.id, "Make a file");
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "waiting_human", { timeoutMs: 10_000 });
    expect(rt.crews.get(crew!.id).state.goal!.question).toMatchObject({ teammate: "builder", text: "Which file name?" });
    expect(await rt.crews.say(crew!.id, "out.txt")).toMatchObject({ routed: "answer" });
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "completed", { timeoutMs: 10_000 });
    const g = rt.crews.get(crew!.id).state.goal!;
    expect(git(rt.info.dir, "show", `${g.branch}:out.txt`)).toBe("x\n");
  });

  it("feedback on the plan sends the Lead back to planning; a failing test returns the card, then gives up", async () => {
    const { rt, crew } = await project();
    let planned = 0;
    scripts = {
      lead: (input) => {
        if (!input.text.startsWith("New goal")) return loom([{ type: "done", summary: "x" }]);
        planned++;
        return loom([{ type: "plan", cards: [{ title: planned === 1 ? "Too big" : "Small step" }] }]);
      },
      builder: (_i, wd, n) => { write(wd, `f${n}.txt`, "x\n"); return loom([{ type: "done", summary: "did" }]); },
      reviewer: () => loom([{ type: "review", verdict: "approve", notes: "" }]),
      tester: () => loom([{ type: "test", result: "fail", log: "1 failed: expected 2" }]),
    };
    await rt.crews.goal(crew!.id, "Do a thing");
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "awaiting_approval", { timeoutMs: 10_000 });
    expect(await rt.crews.say(crew!.id, "smaller please")).toMatchObject({ routed: "replan", to: "lead" });
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.cards[0]?.title === "Small step" && rt.crews.get(crew!.id).state.goal?.status === "awaiting_approval", { timeoutMs: 10_000 });
    expect(turns.filter((t) => t.teammate === "lead").at(-1)!.briefing).toMatch(/Feedback on your plan: smaller please/);
    rt.crews.approve(crew!.id);
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "failed", { timeoutMs: 15_000 });
    const card = rt.crews.get(crew!.id).state.goal!.cards[0]!;
    expect(card).toMatchObject({ stage: "failed", rounds: 2 });
    expect(card.error).toMatch(/tests still fail/);
    // the builder heard the failure each time
    expect(turns.filter((t) => t.teammate === "builder" && /The tests fail/.test(t.text))).toHaveLength(2);
  });

  // Timing-heavy (two runtimes, a resume): reliable alone, slow under the full parallel suite.
  it("stop interrupts the goal; a new runtime finds a mid-turn goal interrupted and resume carries on", { retry: 2, timeout: 90_000 }, async () => {
    const { dir, rt: first, crew } = await project();
    first.crews.update(crew!.id, { planApproval: false });
    scripts = { lead: () => loom([{ type: "plan", cards: [{ title: "One" }] }]) };
    await first.crews.goal(crew!.id, "Something");
    await waitUntil(() => first.crews.get(crew!.id).state.goal?.status !== "planning", { timeoutMs: 25_000 });
    await first.crews.stop(crew!.id).catch(() => {});
    expect(["stopped", "completed"]).toContain(first.crews.get(crew!.id).state.goal!.status);
    // a goal left "running" on disk reads as interrupted when Loom comes back
    const file = path.join(dir, ".loom", "crews", "ship.json");
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    st.goal.status = "running";
    st.goal.finishedAt = undefined;
    await first.close();
    fs.writeFileSync(file, JSON.stringify(st));
    rt = await ProjectRuntime.open({ id: `crew-${path.basename(dir)}`, name: "crewapp", dir });
    expect(rt.crews.get("ship").state.goal!.status).toBe("interrupted");
    scripts = { builder: (_i, wd) => { write(wd, "one.txt", "1\n"); return loom([{ type: "done", summary: "one" }]); } };
    rt.crews.resume("ship");
    await waitUntil(() => rt!.crews.get("ship").state.goal?.status === "completed", { timeoutMs: 25_000 });
  });

  it("a teammate that goes silent is interrupted and retried once; silent twice fails the card — never a free approval", async () => {
    const { rt, crew } = await project();
    rt.crews.update(crew!.id, { planApproval: false, stallMinutes: 0.005 }); // 300ms
    scripts = {
      lead: (input) => (input.text.startsWith("New goal") ? loom([{ type: "plan", cards: [{ title: "Card" }] }]) : loom([{ type: "done", summary: "x" }])),
      builder: (_i, wd, n) => (n === 0 ? { silent: true } : (write(wd, "a.txt", "a\n"), loom([{ type: "done", summary: "made a.txt" }]))),
      reviewer: () => ({ silent: true }),
    };
    await rt.crews.goal(crew!.id, "Something small");
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "failed", { timeoutMs: 15_000 });
    const g = rt.crews.get(crew!.id).state.goal!;
    // the builder's silent first try was retried, and the retry built it
    expect(turns.filter((t) => t.teammate === "builder")).toHaveLength(2);
    expect(turns.filter((t) => t.teammate === "builder")[1]!.briefing).toMatch(/produced nothing and was stopped/);
    expect(g.cards[0]!.commits).toHaveLength(1);
    // the reviewer was silent twice: the card fails, it is not approved
    expect(turns.filter((t) => t.teammate === "reviewer")).toHaveLength(2);
    expect(g.cards[0]).toMatchObject({ stage: "failed" });
    expect(g.cards[0]!.error).toMatch(/review didn't happen: reviewer went silent twice/);
    expect(turns.some((t) => t.teammate === "tester")).toBe(false);
    const stalls = rt.log.list({ kinds: ["crew"] }).filter((e) => e.payload.phase === "stalled").map((e) => [e.payload.teammate, e.payload.retrying]);
    expect(stalls).toEqual([["builder", true], ["reviewer", true], ["reviewer", false]]);
  });

  it("a turn that errors is tried once more before the card fails", async () => {
    const { rt, crew } = await project();
    rt.crews.update(crew!.id, { planApproval: false });
    let testerTurns = 0;
    scripts = {
      lead: (input) => (input.text.startsWith("New goal") ? loom([{ type: "plan", cards: [{ title: "Card" }] }]) : loom([{ type: "done", summary: "x" }])),
      builder: (_i, wd) => (write(wd, "b.txt", "b\n"), loom([{ type: "done", summary: "b" }])),
      reviewer: () => loom([{ type: "review", verdict: "approve", notes: "" }]),
      tester: () => (++testerTurns === 1 ? "fail:Invalid stream event" : loom([{ type: "test", result: "pass", log: "ok" }])),
    };
    await rt.crews.goal(crew!.id, "b");
    await waitUntil(() => ["completed", "failed"].includes(rt.crews.get(crew!.id).state.goal?.status ?? ""), { timeoutMs: 10_000 });
    expect(rt.crews.get(crew!.id).state.goal!.status).toBe("completed");
    expect(testerTurns).toBe(2);
    expect(rt.log.list({ kinds: ["crew"] }).some((e) => e.payload.phase === "retrying" && e.payload.teammate === "tester")).toBe(true);
  });

  it("swapping a failed teammate's agent and resuming seats a fresh instance, not the old one's session", async () => {
    const { rt, crew } = await project();
    rt.crews.update(crew!.id, { planApproval: false });
    scripts = {
      lead: (input) => (input.text.startsWith("New goal") ? loom([{ type: "plan", cards: [{ title: "Card" }] }]) : loom([{ type: "done", summary: "x" }])),
      builder: (_i, wd) => (write(wd, "c.txt", "c\n"), loom([{ type: "done", summary: "c" }])),
      reviewer: () => loom([{ type: "review", verdict: "approve", notes: "" }]),
      tester: (input) => (/crew-ship-tester\.small/.test(String(turns.at(-1)?.instance)) ? "fail:provider down" : loom([{ type: "test", result: "pass", log: "ok" }])),
    };
    await rt.crews.goal(crew!.id, "c");
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "failed", { timeoutMs: 10_000 });
    expect(rt.crews.get(crew!.id).state.goal!.cards[0]!.error).toMatch(/tests didn't run: provider down/);
    // put the other agent in the tester's seat, and carry on
    const tms = rt.crews.get(crew!.id).teammates.map((t) => (t.id === "tester" ? { ...t, agent: "big" } : t));
    rt.crews.update(crew!.id, { teammates: tms });
    rt.crews.resume(crew!.id);
    await waitUntil(() => rt.crews.get(crew!.id).state.goal?.status === "completed", { timeoutMs: 10_000 });
    const testers = [...new Set(turns.filter((t) => t.teammate === "tester").map((t) => t.instance))];
    expect(testers).toEqual(["crew-ship-tester.small", "crew-ship-tester.big"]);
  });

  it("with a test command, Loom runs the tests itself and the exit code decides — no tester agent needed", async () => {
    const { rt } = await project(false);
    const made = rt.crews.create({ name: "Cmd", teammates: [{ id: "lead", agent: "big", role: "lead" }, { id: "builder", agent: "small", role: "builder" }], planApproval: false, testCommand: "test -f done.txt && echo all-green" });
    scripts = {
      lead: (input) => (input.text.startsWith("New goal") ? loom([{ type: "plan", cards: [{ title: "Make done.txt" }] }]) : loom([{ type: "done", summary: "x" }])),
      // first try forgets the file; the failure output sends it back
      builder: (input, wd) => {
        if (/The tests fail \(loom: test -f done\.txt/.test(input.text)) write(wd, "done.txt", "ok\n");
        else write(wd, "other.txt", "x\n");
        return loom([{ type: "done", summary: "did" }]);
      },
    };
    await rt.crews.goal(made.id, "make it");
    await waitUntil(() => ["completed", "failed"].includes(rt.crews.get(made.id).state.goal?.status ?? ""), { timeoutMs: 10_000 });
    const g = rt.crews.get(made.id).state.goal!;
    expect(g.status).toBe("completed");
    expect(g.cards[0]).toMatchObject({ stage: "done", rounds: 1 });
    const tested = rt.log.list({ kinds: ["crew"] }).filter((e) => e.payload.phase === "tested").map((e) => [e.payload.teammate, e.payload.result]);
    expect(tested).toEqual([["loom", "fail"], ["loom", "pass"]]);
    expect(rt.log.list({ kinds: ["crew"] }).find((e) => e.payload.phase === "tested" && e.payload.result === "pass")!.payload.log).toContain("all-green");
  });

  it("refuses a crew that can't work, and a goal while one is running", async () => {
    const { rt } = await project(false);
    expect(() => rt.crews.create({ name: "x", teammates: [{ id: "r", agent: "big", role: "reviewer" }] })).toThrow(/does the work/);
    expect(() => rt.crews.create({ name: "x", teammates: [{ id: "a", agent: "ghost", role: "builder" }] })).toThrow(/roster/);
    const made = rt.crews.create({ name: "Fixers", template: "fix" });
    expect(made.teammates.map((t) => t.role)).toEqual(["lead", "builder", "tester"]);
    scripts = { lead: () => ({ text: "", ask: "hmm?" }) };
    await rt.crews.goal(made.id, "one");
    await expect(rt.crews.goal(made.id, "two")).rejects.toThrow(/already on a goal/);
  });
});
