/**
 * Sub-agents, over a real daemon.
 *
 * A turn used to be all-or-nothing: one agent, one prompt, one result. "Audit
 * these twelve files" wanted twelve cheap readers and the only way to get them
 * was twelve sequential turns, each taking the baton off the last.
 *
 * The property the whole feature rests on is that a child never touches the
 * baton. If it did, fanning work out would silently steal the conversation from
 * the agent that started it, and the human's next message would land somewhere
 * they didn't choose — a worse bug than not having sub-agents at all. So that is
 * what most of this file checks.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { LoomEvent, ProjectStatus } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const status = async (): Promise<ProjectStatus> => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: H() });
  return ((await r.json()) as { project: ProjectStatus }).project;
};

const events = async (): Promise<LoomEvent[]> =>
  (await client.events(projectId)).events;

const kinds = async (kind: string): Promise<LoomEvent[]> =>
  (await events()).filter((e) => e.kind === kind);

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  // plannerbot + execbot, both echo adapters
  projectId = (await client.addProject(makeProjectDir({ name: "subagents" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("spawning a subtask", () => {
  it("runs it on the child and says so", async () => {
    const out = await client.spawnSubtask(projectId, "plannerbot", "execbot", "count the files");
    expect(out.agentId).toBe("execbot");
    expect(out.id).toBeTruthy();

    const started = await kinds("subtask_started");
    expect(started.length).toBe(1);
    expect(started[0]!.agentId).toBe("execbot");
    expect(started[0]!.payload.parent).toBe("plannerbot");
    expect(started[0]!.payload.task).toBe("count the files");
  });

  it("leaves the baton exactly where it was", async () => {
    // The one that matters. Spawning is not a handoff, so nothing about who
    // holds the lock may change — including "nobody".
    const before = (await status()).holder;
    await client.spawnSubtask(projectId, "plannerbot", "execbot", "read the readme");
    expect((await status()).holder).toBe(before);

    // And no handoff was recorded, because none happened.
    expect(await kinds("handoff")).toHaveLength(0);
  });

  it("does not stop the parent from taking its own turn", async () => {
    // A child holding anything would make this throw NotHolderError, which is
    // exactly the failure this design exists to avoid.
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ text: "carry on", agentId: "plannerbot" }),
    });
    expect(r.status).toBe(200);
    expect((await status()).holder).toBe("plannerbot");
  });

  it("reports what is in flight", async () => {
    const { subtasks } = await client.subtasks(projectId);
    for (const s of subtasks) {
      expect(s.parent).toBe("plannerbot");
      expect(s.agentId).toBe("execbot");
    }
  });

  it("records completion against the child, parented to who asked", async () => {
    await waitUntil(async () => (await kinds("subtask_done")).length > 0, { timeoutMs: 8000 });
    const done = await kinds("subtask_done");
    expect(done[0]!.agentId).toBe("execbot");
    expect(done[0]!.payload.parent).toBe("plannerbot");
    expect(done[0]!.payload.subtaskId).toBeTruthy();
  });

  it("clears itself from the in-flight list when it finishes", async () => {
    await waitUntil(async () => (await client.subtasks(projectId)).subtasks.length === 0, { timeoutMs: 8000 });
    expect((await client.subtasks(projectId)).subtasks).toHaveLength(0);
  });
});

describe("refusing a bad subtask", () => {
  it("needs a task", async () => {
    await expect(client.spawnSubtask(projectId, "plannerbot", "execbot", "   ")).rejects.toThrow(
      /missing task|needs a task/,
    );
  });

  it("needs a parent that exists", async () => {
    // The thread indents a child's result under the parent's turn, so a parent
    // that isn't in the project would produce an orphan with nowhere to sit.
    await expect(client.spawnSubtask(projectId, "ghost", "execbot", "x")).rejects.toThrow(
      /unknown agent/,
    );
  });

  it("needs a child that exists", async () => {
    await expect(client.spawnSubtask(projectId, "plannerbot", "ghost", "x")).rejects.toThrow(
      /unknown agent/,
    );
  });

  it("caps concurrency instead of melting the machine", async () => {
    // Each child is a real CLI process with its own model calls. Four at once is
    // a fan-out; forty is a fork bomb with a nicer name.
    const spawned: string[] = [];
    let refusal = "";
    for (let i = 0; i < 8; i++) {
      try {
        const out = await client.spawnSubtask(projectId, "plannerbot", "execbot", `probe ${i}`);
        spawned.push(out.id);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    // Echo returns fast, so the cap may or may not be reached before one drains.
    // Either way the invariant holds: never more than the cap in flight at once.
    const live = (await client.subtasks(projectId)).subtasks.length;
    expect(live).toBeLessThanOrEqual(4);
    if (refusal) expect(refusal).toMatch(/already running/);
  });
});
