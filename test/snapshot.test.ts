/**
 * Snapshots: a restorable "before" for the moment you let a fleet loose.
 *
 * What travels: brain, board, config. What deliberately doesn't: the working
 * tree (git owns files and does it better) and the event log (history is what
 * happened; a restore that rewrote it would be a lie with a timestamp). The
 * subtle rule worth guarding: restore MERGES the brain rather than replacing
 * it — what the project knew then comes back, what it learned since stays.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectState } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const teach = (text: string) =>
  fetch(`${baseUrl}/api/projects/${projectId}/brain`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ kind: "decision", text }),
  });

const memories = async (): Promise<string[]> => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}/brain`, { headers: H() });
  return ((await r.json()) as { memories: Array<{ text: string }> }).memories.map((m) => m.text);
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "snap" });
  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("snapshot and restore", () => {
  it("round-trips brain, board and config", async () => {
    await teach("before: sqlite everywhere");
    await fetch(`${baseUrl}/api/projects/${projectId}/board/tasks`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ title: "the before card" }),
    });

    const snapRes = await fetch(`${baseUrl}/api/projects/${projectId}/snapshot`, { headers: H() });
    const snap = (await snapRes.json()) as Record<string, unknown>;
    expect(snap.format).toBe("loom-snapshot");

    // The fleet then makes a mess: board wiped, config's roster changed.
    const state = readProjectState(projectDir);
    const rt = await (async () => {
      // touch nothing directly; use the API like everything else
      return null;
    })();
    void rt;
    for (const t of state.tasks ?? []) {
      await fetch(`${baseUrl}/api/projects/${projectId}/board/tasks/${t.id}`, {
        method: "DELETE",
        headers: H(),
      });
    }
    await client.addAgent(projectId, "echo", { as: "intruder" });

    const restore = await fetch(`${baseUrl}/api/projects/${projectId}/restore`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify(snap),
    });
    expect(restore.status).toBe(200);

    // Board came back; the intruder is gone from the roster.
    const after = readProjectState(projectDir);
    expect((after.tasks ?? []).map((t) => t.title)).toContain("the before card");
    const r = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: H() });
    const { project } = (await r.json()) as { project: { agents: Array<{ id: string }> } };
    expect(project.agents.some((a) => a.id === "intruder")).toBe(false);
  });

  it("restore merges the brain — what was learned since the snapshot survives", async () => {
    const snapRes = await fetch(`${baseUrl}/api/projects/${projectId}/snapshot`, { headers: H() });
    const snap = await snapRes.json();

    await teach("after: a lesson learned post-snapshot");
    await fetch(`${baseUrl}/api/projects/${projectId}/restore`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify(snap),
    });

    const texts = await memories();
    expect(texts.some((t) => t.includes("before: sqlite everywhere"))).toBe(true);
    // The one that would be lost by a replace-restore. This is the rule.
    expect(texts.some((t) => t.includes("after: a lesson learned"))).toBe(true);
  });

  it("refuses a document that isn't a snapshot", async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/restore`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ mystery: true }),
    });
    expect(r.status).toBe(400);
  });
});
