/**
 * End-to-end integration over real HTTP + WS: daemon boots, a project with
 * two echo adapters (planner + executor) runs the full loop —
 * send → stream → suggestion → handoff (projection + briefing) → baton
 * enforcement (409) → pairing → live WS delivery.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient, DaemonError } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let projectId: string;
let projectDir: string;
let baseUrl: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  client = new DaemonClient(readDaemonConfig()!);

  projectDir = makeProjectDir({ name: "weave" }); // plannerbot + execbot (echo)
  const res = await client.addProject(projectDir);
  projectId = res.project.id;
});

afterAll(async () => {
  await daemon.close();
});

async function eventsOf(kind?: string): Promise<LoomEvent[]> {
  const { events } = await client.events(projectId, undefined, 500);
  return kind ? events.filter((e) => e.kind === kind) : events;
}

describe("loom daemon end-to-end", () => {
  it("health + board", async () => {
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    const { projects } = await client.listProjects();
    expect(projects.map((p) => p.id)).toContain(projectId);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(401);
  });

  it("serves the phone app publicly (shell only — API stays authed)", async () => {
    const app = await fetch(`${baseUrl}/app`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/html");
    const html = await app.text();
    expect(html).toContain('id="loom-app"');
    expect(html).toContain("/api/pair/claim");

    const manifest = await fetch(`${baseUrl}/app/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as { name: string }).name).toBe("Loom");

    const rootRedirect = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(rootRedirect.status).toBe(302);
    expect(rootRedirect.headers.get("location")).toBe("/app");
  });

  it("first message auto-acquires the baton and the agent streams back", async () => {
    const { agentId } = await client.send(projectId, "hello there");
    expect(agentId).toBe("plannerbot");
    await waitUntil(async () => (await eventsOf("run_complete")).length >= 1);
    const messages = await eventsOf("message");
    expect(messages.some((m) => !m.agentId && m.payload.text === "hello there")).toBe(true);
    expect(
      messages.some((m) => m.agentId === "plannerbot" && String(m.payload.text).includes("hello there")),
    ).toBe(true);
    const { project } = await client.project(projectId);
    expect(project.holder).toBe("plannerbot");
  });

  it("planner finishing a plan produces a handoff suggestion", async () => {
    await client.send(projectId, "make a plan for the parser");
    await waitUntil(async () => (await eventsOf("suggestion")).length >= 1);
    const suggestion = (await eventsOf("suggestion"))[0]!;
    expect(suggestion.payload.to).toBe("execbot");
  });

  it("messaging a non-holder returns 409 not_holder (explicit handoff only)", async () => {
    await expect(client.send(projectId, "do it", "execbot")).rejects.toMatchObject({
      status: 409,
    });
    try {
      await client.send(projectId, "do it", "execbot");
    } catch (err) {
      expect((err as DaemonError).body?.error).toBe("not_holder");
      expect((err as DaemonError).body?.holder).toBe("plannerbot");
    }
  });

  it("handoff moves the baton, writes the namespaced projection, briefs the target", async () => {
    await client.decision(projectId, "tokenizer before parser");
    const { from, to } = await client.handoff(projectId, "execbot");
    expect(from).toBe("plannerbot");
    expect(to).toBe("execbot");

    const memoryFile = path.join(projectDir, ".loom", "memory", "execbot.md");
    expect(fs.existsSync(memoryFile)).toBe(true);
    const memory = fs.readFileSync(memoryFile, "utf8");
    expect(memory).toContain("# Loom shared context — weave");
    expect(memory).toContain("tokenizer before parser");
    expect(memory).toContain("`execbot` (echo) — executor ← you");

    // First post-handoff turn carries the one-shot briefing (echo reports it).
    await client.send(projectId, "continue the work");
    await waitUntil(async () =>
      (await eventsOf("message")).some(
        (m) => m.agentId === "execbot" && String(m.payload.text).includes("briefed:"),
      ),
    );

    const { project } = await client.project(projectId);
    expect(project.holder).toBe("execbot");
    // …and the old holder is now the one that 409s.
    await expect(client.send(projectId, "hi", "plannerbot")).rejects.toMatchObject({ status: 409 });
  });

  it("bridges cannot receive the baton", async () => {
    // registered agent kinds include bridges; handoff to unknown/bridge fails loudly
    await expect(client.handoff(projectId, "ghost")).rejects.toThrow(/unknown agent/);
  });

  it("pairing: mint → claim once → client token works, reuse fails", async () => {
    const { token, url } = await client.newPairingToken();
    expect(url).toContain("http://127.0.0.1:");
    const claim = await fetch(`${baseUrl}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "test-phone" }),
    });
    expect(claim.status).toBe(200);
    const { clientToken } = (await claim.json()) as { clientToken: string };

    const authed = await fetch(`${baseUrl}/api/projects`, {
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(authed.status).toBe(200);

    const reuse = await fetch(`${baseUrl}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(reuse.status).toBe(403);

    // paired clients are NOT admins: minting new pairing tokens is denied
    const mint = await fetch(`${baseUrl}/api/pair/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(mint.status).toBe(403);
  });

  it("websocket delivers live events for the project", async () => {
    const seen: LoomEvent[] = [];
    const unsubscribe = client.subscribe((pid, e) => {
      if (pid === projectId) seen.push(e);
    }, projectId);
    await new Promise((r) => setTimeout(r, 300)); // let the socket connect
    await client.send(projectId, "ping over the wire");
    await waitUntil(() => seen.some((e) => e.kind === "run_complete"), { timeoutMs: 8000 });
    unsubscribe();
    expect(seen.some((e) => e.kind === "message" && !e.agentId)).toBe(true);
    expect(seen.some((e) => e.kind === "message" && e.agentId === "execbot")).toBe(true);
  });

  it("hot-reloads an edited .loom/config.json once the project is quiet", async () => {
    const cfgFile = path.join(projectDir, ".loom", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as {
      agents: Array<Record<string, unknown>>;
    };
    cfg.agents.push({ id: "reviewbot", kind: "echo", role: "reviewer" });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    // mtime granularity can be coarse — nudge it forward explicitly.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(cfgFile, future, future);
    const { project } = await client.project(projectId);
    expect(project.agents.map((a) => a.id)).toContain("reviewbot");
  });

  it("clears a ghost baton holder left by a removed agent", async () => {
    const stateFile = path.join(projectDir, ".loom", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    state.holder = "agent-that-was-deleted";
    fs.writeFileSync(stateFile, JSON.stringify(state));
    // Routing must recover (clear the ghost, fall back to the default adapter)…
    const { agentId } = await client.send(projectId, "who picks this up?");
    expect(agentId).toBe("plannerbot");
    // …and the board must never display a ghost.
    const { project } = await client.project(projectId);
    expect(project.holder).toBe("plannerbot");
    // Restore execbot as holder for the following tests.
    await client.handoff(projectId, "execbot");
  });

  it('auto-captures "Decision:" lines from agent replies into shared memory', async () => {
    await client.send(projectId, "note this\nDecision: use sqlite for the log");
    await waitUntil(async () =>
      (await eventsOf("decision")).some(
        (d) => d.payload.auto === true && String(d.payload.text).includes("use sqlite"),
      ),
    );
    // …and the decision survives into the next projection.
    await client.handoff(projectId, "plannerbot");
    const memory = fs.readFileSync(
      path.join(projectDir, ".loom", "memory", "plannerbot.md"),
      "utf8",
    );
    expect(memory).toContain("use sqlite for the log");
    await client.handoff(projectId, "execbot"); // restore holder for later tests
  });

  it("handoff records the outgoing agent's dirty working tree", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, "scratch.txt"), "uncommitted");
    await client.handoff(projectId, "plannerbot");
    const handoffs = await eventsOf("handoff");
    const last = handoffs[handoffs.length - 1]!;
    expect(last.payload.dirty).toBe(true);
    expect(String(last.payload.diff)).toContain("scratch.txt");
    await client.handoff(projectId, "execbot");
  });

  it("interrupt stops a long-running turn", async () => {
    await client.send(projectId, "sleep:5000");
    await waitUntil(async () => {
      const { project } = await client.project(projectId);
      return project.agents.find((a) => a.id === "execbot")?.busy === true;
    });
    const { interrupted } = await client.interrupt(projectId);
    expect(interrupted).toBe("execbot");
    await waitUntil(async () =>
      (await eventsOf("status")).some((e) => e.payload.state === "interrupted"),
    );
  });
});
