/**
 * Routing end-to-end over real HTTP: pipelines auto-advance through
 * handoffs, pause on questions, resume on answers, abort cleanly, and
 * yield to manual control.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoomEvent, ProjectConfig } from "../src/types.js";
import { parseModelRef } from "../src/adapters/opencode.js";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import { resolveSteps } from "../src/core/routes.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
});

afterAll(async () => {
  await daemon.close();
});

/** Fresh project per test so route states can't bleed into each other. */
async function freshProject(configExtra?: Partial<ProjectConfig>) {
  const dir = makeProjectDir(configExtra); // plannerbot + execbot echo agents
  const res = await client.addProject(dir);
  return { dir, id: res.project.id };
}

async function events(id: string, kind?: string): Promise<LoomEvent[]> {
  const { events } = await client.events(id, undefined, 500);
  return kind ? events.filter((e) => e.kind === kind) : events;
}

describe("resolveSteps", () => {
  const config: ProjectConfig = {
    name: "x",
    agents: [
      { id: "cc", kind: "claude-code", role: "planner" },
      { id: "oc", kind: "opencode", role: "executor" },
      { id: "ag", kind: "antigravity", role: "general" },
    ],
  };
  const isAdapter = (id: string) => id !== "ag";

  it("resolves ids and roles", () => {
    expect(resolveSteps(["cc", "executor"], config, isAdapter).ids).toEqual(["cc", "oc"]);
    expect(resolveSteps(["planner", "executor", "planner"], config, isAdapter).ids).toEqual([
      "cc",
      "oc",
      "cc",
    ]);
  });

  it("resolves object steps and carries per-step instructions", () => {
    const resolved = resolveSteps(
      ["planner", { step: "executor", instruction: "only touch src/api" }, { step: "cc" }],
      config,
      isAdapter,
    );
    expect(resolved.ids).toEqual(["cc", "oc", "cc"]);
    expect(resolved.instructions).toEqual([null, "only touch src/api", null]);
  });

  it("carries a per-step role, and leaves it null to inherit the agent's own", () => {
    // The whole point of task-time roles: the same agent (cc, whose own role is
    // planner) can be handed the reviewer job for this one task.
    const resolved = resolveSteps(
      [{ step: "cc", role: "reviewer" }, { step: "oc" }],
      config,
      isAdapter,
    );
    expect(resolved.ids).toEqual(["cc", "oc"]);
    expect(resolved.roles).toEqual(["reviewer", null]);
  });

  it("rejects unknown steps and bridge steps", () => {
    expect(() => resolveSteps(["ghost"], config, isAdapter)).toThrow(/matches no agent/);
    expect(() => resolveSteps(["ag"], config, isAdapter)).toThrow(/bridge/);
    expect(() => resolveSteps([{ step: "ag" }], config, isAdapter)).toThrow(/bridge/);
    expect(() => resolveSteps([], config, isAdapter)).toThrow(/at least one step/);
  });
});

describe("opencode model refs", () => {
  it("parses provider/model strings into {providerID, id}, rejects malformed", () => {
    expect(parseModelRef("opencode/minimax-m2.5")).toEqual({
      providerID: "opencode",
      id: "minimax-m2.5",
    });
    // model id may itself contain slashes (split on the first only)
    expect(parseModelRef("openrouter/deepseek/deepseek-v4")).toEqual({
      providerID: "openrouter",
      id: "deepseek/deepseek-v4",
    });
    expect(parseModelRef("no-slash")).toBeNull();
    expect(parseModelRef("/leading")).toBeNull();
    expect(parseModelRef("trailing/")).toBeNull();
  });
});

describe("routes end-to-end", () => {
  it("runs a two-step pipeline to completion with handoffs and briefings", async () => {
    const { dir, id } = await freshProject();
    const { route } = await client.startRoute(id, "build the hello world feature", [
      "plannerbot",
      "execbot",
    ]);
    expect(route.steps).toEqual(["plannerbot", "execbot"]);

    await waitUntil(async () => (await events(id, "route_completed")).length === 1);

    // Both agents took a turn, in order, each briefed via handoff.
    const messages = await events(id, "message");
    const plannerTurn = messages.find((m) => m.agentId === "plannerbot");
    const execTurn = messages.find((m) => m.agentId === "execbot");
    expect(plannerTurn).toBeTruthy();
    expect(execTurn).toBeTruthy();
    expect(String(execTurn!.payload.text)).toContain("briefed:");

    // Handoffs happened for each step; projections exist for both agents.
    expect((await events(id, "handoff")).length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(dir, ".loom", "memory", "plannerbot.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".loom", "memory", "execbot.md"))).toBe(true);

    // Route steps were logged, suggestions were suppressed while routing.
    expect((await events(id, "route_step")).length).toBe(2);
    expect((await events(id, "suggestion")).length).toBe(0);

    const { project } = await client.project(id);
    expect(project.holder).toBe("execbot");
    expect(project.route?.status).toBe("completed");
  });

  it("resolves role names and named routes from config", async () => {
    const { id } = await freshProject({
      routes: { ship: ["planner", "executor"] },
    } as Partial<ProjectConfig>);
    const { route } = await client.startRoute(id, "ship the thing", "ship");
    expect(route.name).toBe("ship");
    expect(route.steps).toEqual(["plannerbot", "execbot"]);
    await waitUntil(async () => (await events(id, "route_completed")).length === 1);
  });

  it("pauses when the agent asks a question, resumes on the user's answer", async () => {
    const { id } = await freshProject();
    // Single-step route; the echo agent asks whatever follows "ask:".
    await client.startRoute(id, "please ask: which database should we use?", ["plannerbot"]);

    await waitUntil(async () => (await events(id, "route_paused")).length === 1);
    let { route } = await client.routeState(id);
    expect(route?.status).toBe("waiting_human");
    expect(route?.pendingQuestion).toContain("which database");

    // The user answers in the shared thread — the route resumes by itself.
    await client.send(id, "use sqlite");
    await waitUntil(async () => (await events(id, "route_completed")).length === 1);
    expect((await events(id, "route_resumed")).length).toBe(1);
    ({ route } = await client.routeState(id));
    expect(route?.status).toBe("completed");
  });

  it("rejects a second route while one is active (409 route_active)", async () => {
    const { id } = await freshProject();
    await client.startRoute(id, "sleep:1500 then work", ["plannerbot", "execbot"]);
    await expect(client.startRoute(id, "another task", ["execbot"])).rejects.toMatchObject({
      status: 409,
    });
    await client.abortRoute(id); // clean up
  });

  it("abort stops the route and interrupts the in-flight step", async () => {
    const { id } = await freshProject();
    await client.startRoute(id, "sleep:5000", ["plannerbot", "execbot"]);
    await waitUntil(async () => {
      const { project } = await client.project(id);
      return project.agents.find((a) => a.id === "plannerbot")?.busy === true;
    });
    const { route } = await client.abortRoute(id);
    expect(route.status).toBe("aborted");
    const failures = await events(id, "route_failed");
    expect(failures.length).toBe(1);
    expect(failures[0]!.payload.aborted).toBe(true);
    // The interrupted agent goes quiet; no completion is ever logged.
    await waitUntil(async () =>
      (await events(id, "status")).some((e) => e.payload.state === "interrupted"),
    );
    expect((await events(id, "route_completed")).length).toBe(0);
  });

  it("a manual handoff cancels the active route — the human outranks it", async () => {
    const { id } = await freshProject();
    await client.startRoute(id, "sleep:5000", ["plannerbot", "execbot"]);
    await waitUntil(async () => {
      const { project } = await client.project(id);
      return project.agents.find((a) => a.id === "plannerbot")?.busy === true;
    });
    await client.handoff(id, "execbot");
    const { route } = await client.routeState(id);
    expect(route?.status).toBe("aborted");
    expect(route?.reason).toContain("manual handoff");
    const { project } = await client.project(id);
    expect(project.holder).toBe("execbot");
  });

  it("dynamic route: the router picks every hop and stops at done", async () => {
    const { id } = await freshProject({
      agents: [
        { id: "plannerbot", kind: "echo", role: "planner" },
        { id: "execbot", kind: "echo", role: "executor" },
        { id: "reviewbot", kind: "echo", role: "reviewer" },
      ],
    } as Partial<ProjectConfig>);
    const { route } = await client.startRoute(id, "build the widget", "auto", {
      router: "rules",
      maxHops: 6,
    });
    expect(route.mode).toBe("dynamic");
    expect(route.steps).toEqual(["plannerbot"]); // first hop chosen by the router

    await waitUntil(async () => (await events(id, "route_completed")).length === 1);
    const { route: final } = await client.routeState(id);
    expect(final?.status).toBe("completed");
    // plan → execute → review, then the router said done.
    expect(final?.steps).toEqual(["plannerbot", "execbot", "reviewbot"]);

    // Every dynamically chosen hop logged its reason.
    const steps = await events(id, "route_step");
    expect(steps.length).toBe(3);
    for (const s of steps) expect(String(s.payload.reason ?? "")).not.toBe("");
    expect(steps[1]!.payload.reason).toContain("execute");
  });

  it("dynamic route respects the hop budget", async () => {
    const { id } = await freshProject({
      agents: [
        // Two executors ping-ponging would never finish — budget caps it.
        { id: "plannerbot", kind: "echo", role: "planner" },
        { id: "execbot", kind: "echo", role: "executor" },
      ],
    } as Partial<ProjectConfig>);
    await client.startRoute(id, "tiny task", "auto", { router: "rules", maxHops: 2 });
    await waitUntil(async () => (await events(id, "route_completed")).length === 1);
    const { route } = await client.routeState(id);
    expect(route?.steps.length).toBeLessThanOrEqual(2);
  });

  it("per-step instructions from config reach exactly their step", async () => {
    const { id } = await freshProject({
      routes: {
        focus: [
          { step: "planner", instruction: "ONLY design the schema, nothing else" },
          "executor",
        ],
      },
    } as Partial<ProjectConfig>);
    await client.startRoute(id, "ship the schema", "focus");
    await waitUntil(async () => (await events(id, "route_completed")).length === 1);
    const loomMessages = (await events(id, "message")).filter((m) => m.payload.author === "loom");
    expect(loomMessages).toHaveLength(2);
    expect(String(loomMessages[0]!.payload.text)).toContain(
      "Step-specific instructions: ONLY design the schema",
    );
    expect(String(loomMessages[1]!.payload.text)).not.toContain("Step-specific instructions");
  });

  it("llm projection mode falls back to the template and never blocks a handoff", async () => {
    const { dir, id } = await freshProject({
      projection: { mode: "llm", model: "haiku", timeoutMs: 8000 },
    } as Partial<ProjectConfig>);
    // claude is unavailable/logged-out in test environments — the distiller
    // must fall back to the template without failing the handoff.
    await client.send(id, "hello");
    await waitUntil(async () => (await events(id, "run_complete")).length >= 1);
    await client.handoff(id, "execbot");
    const memory = fs.readFileSync(path.join(dir, ".loom", "memory", "execbot.md"), "utf8");
    expect(memory).toContain("# Loom shared context —");
    expect(memory).toContain("execbot");
    const { project } = await client.project(id);
    expect(project.holder).toBe("execbot");
  });

  it("route instructions carry role guidance and step position", async () => {
    const { id } = await freshProject();
    await client.startRoute(id, "tiny task", ["plannerbot", "execbot"]);
    await waitUntil(async () => (await events(id, "route_completed")).length === 1);
    const loomMessages = (await events(id, "message")).filter(
      (m) => m.payload.author === "loom",
    );
    expect(loomMessages.length).toBe(2);
    expect(String(loomMessages[0]!.payload.text)).toContain("step 1/2 (planner)");
    expect(String(loomMessages[0]!.payload.text)).toContain("Task: tiny task");
    expect(String(loomMessages[1]!.payload.text)).toContain("step 2/2 (executor)");
  });
});
