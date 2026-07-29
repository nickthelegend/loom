/**
 * Per-agent spend budgets, enforced.
 *
 * These were write-only: the Observatory burn panel stored USD/day per agent and
 * not one code path ever read it back, so an agent with a $1 cap would happily
 * spend $40 and the cap was decoration. What's asserted here is the enforcement
 * — a turn refused before anything is committed, a visible event, the same pause
 * record the self-heal alert pause uses, and a pause that lifts itself when the spend
 * is no longer over.
 *
 * Echo agents report a deterministic $0.001 per turn, which is what makes a
 * budget test possible without a real model.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { BudgetExceededError, ProjectRuntime } from "../src/daemon/runtime.js";
import type { LoomEvent } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

/** What one echo turn costs. */
const TURN = 0.001;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-budget");
  process.env.LOOM_NO_NOTIFY = "1";
});

/** A runtime over a fresh project dir, with the caller's spend already logged. */
async function runtimeWith(spend: Array<{ agentId: string; costUsd: number; ts?: number }>): Promise<ProjectRuntime> {
  const dir = makeProjectDir({ name: "budget" });
  const rt = await ProjectRuntime.open({ id: "budget", name: "budget", dir });
  for (const s of spend) {
    // A turn's money lands on a `turn_cost` status — the same event the running
    // cost totals are folded from, so the budget is measured against the same
    // ledger the burn chart draws.
    rt.log.append({
      kind: "status",
      agentId: s.agentId,
      payload: { state: "turn_cost", costUsd: s.costUsd },
      ...(s.ts ? { ts: s.ts } : {}),
    });
  }
  return rt;
}

describe("spend, measured", () => {
  it("sums only today's turns, and only this agent's", async () => {
    const rt = await runtimeWith([
      { agentId: "plannerbot", costUsd: 0.02 },
      { agentId: "plannerbot", costUsd: 0.03 },
      { agentId: "execbot", costUsd: 0.5 },
      // Yesterday's spend is yesterday's problem: a USD/day cap that counted
      // all of history would refuse every turn forever once it was ever hit.
      { agentId: "plannerbot", costUsd: 9.99, ts: Date.now() - DAY_MS },
    ]);
    try {
      expect(rt.spendTodayFor("plannerbot")).toBeCloseTo(0.05, 6);
      expect(rt.spendTodayFor("execbot")).toBeCloseTo(0.5, 6);
      expect(rt.spendTodayFor("nobody")).toBe(0);
    } finally {
      await rt.close();
    }
  });

  it("reports each budgeted agent's cap against what it has actually spent", async () => {
    const rt = await runtimeWith([{ agentId: "plannerbot", costUsd: 0.4 }]);
    try {
      rt.setBudget("plannerbot", 1);
      rt.setBudget("execbot", 0.25);
      const status = rt.budgetStatus();
      expect(status.plannerbot).toEqual({ budgetUsd: 1, spentTodayUsd: 0.4, over: false });
      expect(status.execbot).toEqual({ budgetUsd: 0.25, spentTodayUsd: 0, over: false });
    } finally {
      await rt.close();
    }
  });
});

describe("enforcement", () => {
  it("lets a turn through when no budget is set", async () => {
    const rt = await runtimeWith([{ agentId: "plannerbot", costUsd: 100 }]);
    try {
      await expect(rt.sendMessage("go", "plannerbot")).resolves.toMatchObject({ agentId: "plannerbot" });
    } finally {
      await rt.close();
    }
  });

  it("lets a turn through when the agent is under its budget", async () => {
    const rt = await runtimeWith([{ agentId: "plannerbot", costUsd: 0.4 }]);
    try {
      rt.setBudget("plannerbot", 1);
      await expect(rt.sendMessage("go", "plannerbot")).resolves.toMatchObject({ agentId: "plannerbot" });
      expect(rt.quarantined().plannerbot).toBeUndefined();
    } finally {
      await rt.close();
    }
  });

  it("refuses the turn at or over the budget, and says by how much", async () => {
    const rt = await runtimeWith([{ agentId: "plannerbot", costUsd: 1.25 }]);
    try {
      rt.setBudget("plannerbot", 1);
      const err = await rt.sendMessage("go", "plannerbot").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(err).toMatchObject({ agentId: "plannerbot", budgetUsd: 1, spentUsd: 1.25 });

      // Visible: a status event in the thread, carrying the real numbers.
      const refusal = rt.log.list({ kinds: ["status"] }).find((e: LoomEvent) => e.payload.state === "budget_exceeded");
      expect(refusal).toMatchObject({ agentId: "plannerbot" });
      expect(refusal!.payload).toMatchObject({ budgetUsd: 1, spentTodayUsd: 1.25 });

      // …and the same pause record the self-heal webhook writes, so the UI has
      // one thing to render for "this agent is paused" however it got paused.
      expect(rt.quarantined().plannerbot).toMatchObject({ displaced: false });
      expect(rt.quarantined().plannerbot!.reason).toContain("$1.00/day");

      // Nothing was committed on the way out: no baton, no prompt in the thread.
      expect(rt.baton.holder()).toBeNull();
      expect(rt.log.list({ kinds: ["message"] })).toHaveLength(0);
    } finally {
      await rt.close();
    }
  });

  it("refuses a handoff to an agent that is out of budget", async () => {
    const rt = await runtimeWith([{ agentId: "execbot", costUsd: 2 }]);
    try {
      rt.setBudget("execbot", 1);
      await expect(rt.handoff("execbot")).rejects.toThrow(BudgetExceededError);
      // The baton stayed where it was rather than landing on an agent that
      // would refuse every prompt it was handed.
      expect(rt.baton.holder()).toBeNull();
    } finally {
      await rt.close();
    }
  });

  /**
   * The pause has to lift itself. A budget is per DAY, so the same agent is
   * fine tomorrow — and if a human raises the cap, the next attempt should just
   * work rather than needing someone to find the quarantine and clear it.
   */
  it("lifts its own pause once the agent is under budget again", async () => {
    const rt = await runtimeWith([{ agentId: "plannerbot", costUsd: 1.25 }]);
    try {
      rt.setBudget("plannerbot", 1);
      await expect(rt.sendMessage("go", "plannerbot")).rejects.toThrow(BudgetExceededError);
      expect(rt.quarantined().plannerbot).toBeDefined();

      rt.setBudget("plannerbot", 5);
      await expect(rt.sendMessage("go", "plannerbot")).resolves.toMatchObject({ agentId: "plannerbot" });
      expect(rt.quarantined().plannerbot).toBeUndefined();
      expect(
        rt.log.list({ kinds: ["status"] }).some((e: LoomEvent) => e.payload.state === "budget_recovered"),
      ).toBe(true);
    } finally {
      await rt.close();
    }
  });

  /** A pause somebody else owns is not this guard's to lift. */
  it("leaves an alert quarantine alone", async () => {
    const rt = await runtimeWith([]);
    try {
      rt.quarantine("plannerbot", "HighErrorRate", true);
      rt.setBudget("plannerbot", 5); // under budget, so the budget guard passes
      // The send is refused — by the *alert* pause, not the budget one. This
      // case used to assert that the send went through, which encoded the bug:
      // an alert quarantine was written and never read, so a paused agent kept
      // taking work. What it is really about is that the budget guard must not
      // lift someone else's pause, and that still holds below.
      await expect(rt.sendMessage("go", "plannerbot")).rejects.toThrow(/paused by a firing alert/);
      expect(rt.quarantined().plannerbot).toMatchObject({ reason: "HighErrorRate", displaced: true });
    } finally {
      await rt.close();
    }
  });
});

describe("over the API", () => {
  let daemon: LoomDaemon;
  let baseUrl: string;
  let token: string;
  let client: DaemonClient;
  let projectId: string;

  const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  beforeAll(async () => {
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const { host, port } = await daemon.listen();
    baseUrl = `http://${host}:${port}`;
    token = readDaemonConfig()!.adminToken;
    client = new DaemonClient(readDaemonConfig()!);
    projectId = (await client.addProject(makeProjectDir({ name: "capped" }))).project.id;
  });
  afterAll(async () => {
    await daemon.close();
  });

  it("answers a refused turn with 409 and the numbers behind it", async () => {
    // One real turn so there is genuine spend, then a cap below it.
    await client.send(projectId, "one");
    await waitUntil(async () => (await client.costs(projectId)).costs.turns >= 1);

    const put = await fetch(`${baseUrl}/api/projects/${projectId}/budgets/plannerbot`, {
      method: "PUT",
      headers: H(),
      body: JSON.stringify({ usdPerDay: TURN / 2 }),
    });
    const saved = (await put.json()) as { budgets: Record<string, number>; status: Record<string, { over: boolean }> };
    expect(saved.budgets.plannerbot).toBeCloseTo(TURN / 2, 6);
    // The status the panel renders is measured, not the number that was typed.
    expect(saved.status.plannerbot!.over).toBe(true);

    const res = await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ text: "two" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; agentId: string; budgetUsd: number; spentTodayUsd: number };
    expect(body.error).toBe("budget_exceeded");
    expect(body.agentId).toBe("plannerbot");
    expect(body.spentTodayUsd).toBeCloseTo(TURN, 6);
  });

  it("fails a route whose step can't afford to start, with the reason", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/route`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ task: "anything", spec: ["plannerbot"] }),
    });
    expect(res.status).toBe(200); // the route starts; the STEP is what can't
    await waitUntil(async () => (await client.routeState(projectId)).route?.status === "failed");
    const { route } = await client.routeState(projectId);
    expect(route!.reason).toContain("budget");
  });

  it("hard stop: quarantines at turn end, not at the next ask", async () => {
      // Before: an agent that crossed its cap kept showing as healthy until
      // something next tried to dispatch to it. The burn panel said "over" while
      // the roster said "fine" — two surfaces disagreeing about one fact. Now the
      // turn_cost that crosses the line quarantines on the spot.
      const dir = makeProjectDir({ name: "hardstop" });
      const addRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: H(),
        body: JSON.stringify({ dir }),
      });
      const pid = ((await addRes.json()) as { project: { id: string } }).project.id;

      // Cap below one turn's cost: the very first turn must trip it.
      await fetch(`${baseUrl}/api/projects/${pid}/budgets/plannerbot`, {
        method: "PUT",
        headers: H(),
        body: JSON.stringify({ usdPerDay: TURN / 2 }),
      });
      const r = await fetch(`${baseUrl}/api/projects/${pid}/messages`, {
        method: "POST",
        headers: H(),
        body: JSON.stringify({ text: "one costly turn" }),
      });
      expect(r.status).toBe(200); // under the cap when it started

      // Without any further dispatch, the agent is paused once its cost lands.
      await waitUntil(async () => {
        const res = await fetch(`${baseUrl}/api/projects/${pid}`, { headers: H() });
        const { project } = (await res.json()) as {
          project: { quarantine?: Record<string, { reason: string }> };
        };
        return Boolean(project.quarantine?.plannerbot?.reason?.includes("budget"));
      });
  });
});
