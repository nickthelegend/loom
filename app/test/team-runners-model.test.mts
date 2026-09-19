/**
 * Runners' view model: job chips, which runner buttons a goal or job shows,
 * deploy chips, and where a tapped push notification leads. Plain node:
 *
 *   cd app && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LandingState, RunnerJob, TeamRunner, TeamRunners } from "../src/api.ts";
import {
  activeJobCount,
  continueConfirm,
  deployChip,
  deployUrl,
  holderJob,
  jobButtons,
  jobStateChip,
  jobTasks,
  movedLabel,
  notificationRoute,
  runButtons,
  runnerName,
  runnersTabVisible,
  shortSha,
  sortJobs,
  usableRunners,
} from "../src/team-runners-model.ts";
import { isRunDone, landingButtons } from "../src/team-landing-model.ts";

const runner = (deviceId: string, over: Partial<TeamRunner> = {}): TeamRunner => ({
  deviceId,
  github: "alice",
  label: deviceId,
  kinds: ["claude"],
  shared: false,
  lastSeen: 1000,
  mine: true,
  online: true,
  ...over,
});

const landing = (over: Partial<LandingState> = {}): LandingState => ({
  pr: 12,
  url: "https://github.com/o/r/pull/12",
  state: "green",
  fixAttempts: 0,
  flaky: [],
  reviews: 0,
  ...over,
});

const job = (id: string, over: Partial<RunnerJob> = {}): RunnerJob => ({
  id,
  kind: "continue",
  state: "claimed",
  github: "alice",
  goal: `goal ${id}`,
  runId: `run-${id}`,
  progress: {
    runId: `run-${id}`,
    goal: `goal ${id}`,
    status: "running",
    tasks: [
      { id: "t1", title: "a", agent: "claude", status: "done" },
      { id: "t2", title: "b", agent: "codex", status: "running" },
    ],
    costUsd: 0.4,
    landing: null,
    at: 5,
  },
  mine: true,
  ...over,
});

describe("jobStateChip", () => {
  it("colours each state; an unknown one gets a quiet chip", () => {
    assert.deepEqual(jobStateChip("claimed"), { label: "on runner", tone: "live" });
    assert.equal(jobStateChip("queued").tone, "dim");
    assert.equal(jobStateChip("done").tone, "ok");
    assert.equal(jobStateChip("failed").tone, "err");
    assert.deepEqual(jobStateChip("paused"), { label: "paused", tone: "dim" });
  });

  it("counts tasks done over total from the snapshot", () => {
    assert.deepEqual(jobTasks(job("a")), { done: 1, total: 2 });
    assert.equal(jobTasks(job("a", { progress: null })), null);
  });
});

describe("jobButtons", () => {
  it("a goal a runner holds offers Bring back; Land once its PR is up", () => {
    assert.deepEqual(jobButtons(job("a")), ["bring-back"]);
    const withPr = job("a");
    withPr.progress!.landing = landing();
    assert.deepEqual(jobButtons(withPr), ["land", "bring-back"]);
  });

  it("no Land for a merged, closed or already-landing PR", () => {
    for (const l of [landing({ state: "merged" }), landing({ state: "closed" }), landing({ state: "landing" }), landing({ landRequested: true })]) {
      const j = job("a");
      j.progress!.landing = l;
      assert.deepEqual(jobButtons(j), ["bring-back"]);
    }
    const j = job("a");
    j.progress!.landing = landing({ state: "needs_human", landRequested: true });
    assert.deepEqual(jobButtons(j), ["land", "bring-back"]);
  });

  it("nothing for a teammate's goal, a queued or finished job, a fix or return job", () => {
    assert.deepEqual(jobButtons(job("a", { mine: false })), []);
    assert.deepEqual(jobButtons(job("a", { state: "queued" })), []);
    assert.deepEqual(jobButtons(job("a", { state: "done" })), []);
    assert.deepEqual(jobButtons(job("a", { kind: "fix" })), []);
    assert.deepEqual(jobButtons(job("a", { kind: "return" })), []);
    assert.deepEqual(jobButtons(job("a", { kind: "start", runId: null, progress: null })), []);
  });

  it("a start job is found by the run id its snapshot learned", () => {
    const j = job("s", { kind: "start", runId: null });
    assert.equal(holderJob([j], "run-s")?.id, "s");
    assert.equal(holderJob([job("x", { state: "done" })], "run-x"), null);
  });
});

describe("runButtons", () => {
  const view = (over: Partial<TeamRunners> = {}): TeamRunners => ({ runners: [runner("box")], jobs: [], ...over });

  it("Continue on runner for a live goal when a runner can take it", () => {
    assert.deepEqual(runButtons({ id: "r", status: "running" }, view()), ["continue"]);
    assert.deepEqual(runButtons({ id: "r", status: "waiting_human" }, view()), ["continue"]);
    assert.deepEqual(runButtons({ id: "r", status: "running", moving: true }, view()), []);
    assert.deepEqual(runButtons({ id: "r", status: "completed" }, view()), []);
    assert.deepEqual(runButtons({ id: "r", status: "running" }, view({ runners: [] })), []);
    // a teammate's runner that isn't shared can't take it
    assert.deepEqual(runButtons({ id: "r", status: "running" }, view({ runners: [runner("b", { mine: false })] })), []);
    assert.deepEqual(runButtons({ id: "r", status: "running" }, null), []);
  });

  it("a moved goal: Bring back (and Land) from the job holding it", () => {
    const j = job("a");
    j.progress!.landing = landing();
    assert.deepEqual(runButtons({ id: "run-a", status: "moved" }, view({ jobs: [j] })), ["land", "bring-back"]);
    assert.deepEqual(runButtons({ id: "run-zzz", status: "moved" }, view({ jobs: [j] })), []);
  });

  it("the Landing tab lands a moved goal (the daemon hands it to the runner)", () => {
    assert.equal(isRunDone("moved"), true);
    assert.deepEqual(
      landingButtons({ status: "moved", landing: landing({ headSha: "abc" }) }),
      ["land", "review"],
    );
  });
});

describe("runners", () => {
  it("usable: yours and shared ones, online first", () => {
    const out = usableRunners([
      runner("off", { online: false, lastSeen: 9 }),
      runner("theirs", { mine: false }),
      runner("shared", { mine: false, shared: true, github: "bob" }),
      runner("on"),
    ]);
    assert.deepEqual(out.map((r) => r.deviceId), ["on", "shared", "off"]);
    assert.equal(runnerName(out[1]!), "shared (@bob)");
    assert.equal(runnerName(out[0]!), "on");
  });

  it("the confirm names the runner", () => {
    assert.equal(continueConfirm("box-1"), "Running tasks finish their turn (up to 2 min), then it continues on box-1.");
  });

  it("the tab shows with a team or anything to show", () => {
    assert.equal(runnersTabVisible({ shared: true, hidden: false, runners: 0, jobs: 0 }), true);
    assert.equal(runnersTabVisible({ shared: false, hidden: false, runners: 1, jobs: 0 }), true);
    assert.equal(runnersTabVisible({ shared: false, hidden: false, runners: 0, jobs: 0 }), false);
    assert.equal(runnersTabVisible({ shared: true, hidden: true, runners: 3, jobs: 0 }), false);
  });

  it("counts your live jobs; live ones sort first, newest first", () => {
    const jobs = [
      job("done", { state: "done", updatedAt: 100, progress: null }),
      job("old", { state: "queued", progress: null, createdAt: 1 }),
      job("new", {}),
      job("theirs", { mine: false }),
    ];
    assert.equal(activeJobCount({ runners: [], jobs }), 2);
    assert.deepEqual(sortJobs(jobs).map((j) => j.id), ["new", "theirs", "old", "done"]);
  });

  it("labels a moved run", () => {
    assert.equal(movedLabel({ status: "moved", movedTo: { where: "runner box-1", at: 1 } }), "moved to runner box-1");
    assert.equal(movedLabel({ status: "moved" }), "moved to another machine");
    assert.equal(movedLabel({ status: "running" }), null);
  });
});

describe("deploys", () => {
  it("chips, short shas, and only web links", () => {
    assert.deepEqual(deployChip("success"), { label: "deployed", tone: "ok" });
    assert.equal(deployChip("failure").tone, "err");
    assert.equal(deployChip("in_progress").label, "in progress");
    assert.equal(deployChip("weird").tone, "dim");
    assert.equal(shortSha("0123456789abcdef"), "0123456");
    assert.equal(deployUrl({ url: "https://app.example.com" }), "https://app.example.com");
    assert.equal(deployUrl({ url: "javascript:alert(1)" }), null);
    assert.equal(deployUrl({ url: null }), null);
  });
});

describe("notificationRoute", () => {
  it("an orchestra alert opens its goal", () => {
    assert.deepEqual(notificationRoute({ projectId: "p1", kind: "orchestra", runId: "r9" }), {
      projectId: "p1",
      tab: "orchestra",
      runId: "r9",
    });
    assert.deepEqual(notificationRoute({ projectId: "p1", kind: "orchestra" }), { projectId: "p1", tab: "orchestra" });
  });

  it("anything else opens the project's thread", () => {
    assert.deepEqual(notificationRoute({ projectId: "p1", kind: "needs_input" }), { projectId: "p1", tab: "thread" });
    assert.deepEqual(notificationRoute({ projectId: "p1", kind: "run_complete", runId: "" }), { projectId: "p1", tab: "thread" });
  });

  it("no project, no route", () => {
    assert.equal(notificationRoute(null), null);
    assert.equal(notificationRoute({}), null);
    assert.equal(notificationRoute({ projectId: 3 }), null);
    assert.equal(notificationRoute("p1"), null);
  });
});
