/**
 * The board's judgement: what a pull request is actually waiting on, and which
 * column that puts it in. This is the whole feature — a card that says
 * "Ready to merge" when CI is red is worse than no board at all.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnFor, prState, type BoardState } from "../src/daemon/board.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

/** gh's real shape, trimmed to what prState reads. */
const pr = (over: Record<string, unknown> = {}) =>
  ({
    number: 1,
    title: "t",
    state: "OPEN",
    updatedAt: "2026-07-16T00:00:00Z",
    url: "https://github.com/o/r/pull/1",
    statusCheckRollup: [],
    ...over,
  }) as Parameters<typeof prState>[0];

describe("prState", () => {
  it("calls a red build red, whatever the reviewers said", () => {
    // a failure outranks everything: approved + broken is not ready to merge
    for (const bad of ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR"]) {
      expect(prState(pr({ statusCheckRollup: [{ conclusion: bad }], reviewDecision: "APPROVED" }))).toBe(
        "ci-failed",
      );
    }
  });

  it("does not mistake a queued or skipped check for a failure", () => {
    // gh reports SKIPPED for irrelevant jobs and PENDING/IN_PROGRESS mid-run;
    // treating those as red would put half of every repo in Needs you
    const checks = [{ conclusion: "SKIPPED" }, { state: "PENDING" }, { conclusion: "SUCCESS" }];
    expect(prState(pr({ statusCheckRollup: checks }))).toBe("review-pending");
  });

  it("puts changes-requested ahead of draft", () => {
    expect(prState(pr({ reviewDecision: "CHANGES_REQUESTED", isDraft: true }))).toBe(
      "changes-requested",
    );
  });

  it("does not call a draft 'waiting on a reviewer'", () => {
    expect(prState(pr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" }))).toBe("draft");
  });

  it("only claims 'ready' when checks actually ran and passed", () => {
    expect(prState(pr({ reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }))).toBe(
      "ready",
    );
    // approved but no CI at all: say approved, don't imply a green build
    expect(prState(pr({ reviewDecision: "APPROVED", statusCheckRollup: [] }))).toBe("approved");
    expect(prState(pr({ reviewDecision: "APPROVED", statusCheckRollup: null }))).toBe("approved");
  });

  it("treats an unreviewed open PR as review-pending", () => {
    expect(prState(pr({ reviewDecision: "REVIEW_REQUIRED" }))).toBe("review-pending");
    expect(prState(pr({ reviewDecision: "" }))).toBe("review-pending");
    expect(prState(pr({}))).toBe("review-pending");
  });
});

describe("columnFor", () => {
  it("routes every state to exactly one column", () => {
    const states: BoardState[] = [
      "working",
      "input-needed",
      "ci-failed",
      "changes-requested",
      "review-pending",
      "draft",
      "approved",
      "ready",
    ];
    for (const s of states) expect(columnFor(s), s).toBeTruthy();
  });

  it("puts everything that wants a human in Needs you", () => {
    expect(columnFor("input-needed")).toBe("needs-you");
    expect(columnFor("ci-failed")).toBe("needs-you");
    expect(columnFor("changes-requested")).toBe("needs-you");
  });

  it("keeps work in flight out of the merge column", () => {
    expect(columnFor("working")).toBe("working");
    expect(columnFor("draft")).toBe("in-review");
    expect(columnFor("review-pending")).toBe("in-review");
    expect(columnFor("ready")).toBe("ready");
    expect(columnFor("approved")).toBe("ready");
  });
});

/**
 * Dependencies (#13): a card with an unfinished blocker cannot become a turn.
 *
 * The refusal happens at dispatch — the moment a card would turn into agent
 * work — because that is where a premature start costs something: an agent
 * building on a prerequisite that isn't done produces work that gets thrown
 * away. Cycles are refused at write instead, because A→B→A makes both
 * unbecomable forever and the person typing the link is the one who can say
 * which half was wrong.
 */
describe("task dependencies", () => {
  let apiBase: string;
  let apiToken: string;
  let pid: string;
  const HH = () => ({ authorization: `Bearer ${apiToken}`, "content-type": "application/json" });
  const mk = async (title: string, extra: Record<string, unknown> = {}) => {
    const r = await fetch(`${apiBase}/api/projects/${pid}/board/tasks`, {
      method: "POST", headers: HH(), body: JSON.stringify({ title, ...extra }),
    });
    return ((await r.json()) as { task: { id: string } }).task;
  };

  beforeAll(async () => {
    process.env.LOOM_HOME = process.env.LOOM_HOME ?? tmpDir("home-board");
    process.env.LOOM_NO_NOTIFY = "1";
    const { LoomDaemon } = await import("../src/daemon/server.js");
    const { DaemonClient } = await import("../src/daemon/client.js");
    const { readDaemonConfig } = await import("../src/core/registry.js");
    const d = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const { host, port } = await d.listen();
    apiBase = `http://${host}:${port}`;
    apiToken = readDaemonConfig()!.adminToken;
    const c = new DaemonClient(readDaemonConfig()!);
    pid = (await c.addProject(makeProjectDir({ name: "deps" }))).project.id;
    depsDaemon = d;
  });

  afterAll(async () => {
    await depsDaemon?.close();
  });

  it("refuses to dispatch a blocked card, naming what's in the way", async () => {
    const base = await mk("build the schema");
    const dependent = await mk("write the queries", { blockedBy: [base.id], agent: "plannerbot" });

    const r = await fetch(`${apiBase}/api/projects/${pid}/board/tasks/${dependent.id}/dispatch`, {
      method: "POST", headers: HH(),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; blockers: Array<{ title: string }> };
    expect(body.error).toBe("blocked");
    expect(body.blockers[0]!.title).toBe("build the schema");
  });

  it("dispatches once the blocker reaches ready", async () => {
    const base = await mk("design the api");
    const dependent = await mk("implement the api", { blockedBy: [base.id], agent: "plannerbot" });

    await fetch(`${apiBase}/api/projects/${pid}/board/tasks/${base.id}`, {
      method: "POST", headers: HH(), body: JSON.stringify({ column: "ready" }),
    });
    const r = await fetch(`${apiBase}/api/projects/${pid}/board/tasks/${dependent.id}/dispatch`, {
      method: "POST", headers: HH(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dispatched: boolean; agentId: string };
    expect(body.dispatched).toBe(true);
    expect(body.agentId).toBe("plannerbot");
  });

  it("refuses a dependency cycle at write time", async () => {
    const a = await mk("a");
    const b = await mk("b", { blockedBy: [a.id] });
    const r = await fetch(`${apiBase}/api/projects/${pid}/board/tasks/${a.id}`, {
      method: "POST", headers: HH(), body: JSON.stringify({ blockedBy: [b.id] }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("cycle");
  });

  it("drops links to cards that don't exist instead of blocking forever", async () => {
    const t = await mk("solo", { blockedBy: ["nope"] });
    const r = await fetch(`${apiBase}/api/projects/${pid}/board/tasks/${t.id}/blockers`, { headers: HH() });
    expect(((await r.json()) as { blockers: unknown[] }).blockers).toHaveLength(0);
  });
});

let depsDaemon: import("../src/daemon/server.js").LoomDaemon | null = null;
