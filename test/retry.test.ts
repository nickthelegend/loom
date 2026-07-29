/**
 * Retrying a failed turn on a different agent.
 *
 * The recovery used to be retyping the prompt at someone else, who then started
 * cold. Retry finds the failed turn's own prompt, moves the baton, and re-sends
 * the same text — with the failure attached as a briefing rather than pasted
 * into the message, so the thread shows a clean prompt twice, not a prompt
 * wearing a stack trace.
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

const events = async (): Promise<LoomEvent[]> => (await client.events(projectId)).events;

const status = async (): Promise<ProjectStatus> => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: H() });
  return ((await r.json()) as { project: ProjectStatus }).project;
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(makeProjectDir({ name: "retry" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("retry", () => {
  it("refuses when nothing has failed", async () => {
    await expect(client.retryTurn(projectId, "execbot")).rejects.toThrow(/no failed turn/);
  });

  it("re-runs the failed prompt on the chosen agent, with the failure in the briefing", async () => {
    // A real failure, produced by the agent itself: echo's fail: trigger errors
    // the turn the way a dead CLI would.
    await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({
        text: "ship the login page fail:spawn ENOENT: the CLI is not installed",
        agentId: "plannerbot",
      }),
    });
    await waitUntil(async () => (await events()).some((e) => e.kind === "error"));

    const { agentId, retried } = await client.retryTurn(projectId, "execbot");
    expect(agentId).toBe("execbot");
    expect(retried).toContain("ship the login page");

    // The baton moved to the retry agent…
    expect((await status()).holder).toBe("execbot");

    // …the prompt appears again as itself, not wearing the stack trace…
    const msgs = (await events()).filter(
      (e) => e.kind === "message" && !e.agentId &&
        String(e.payload.text ?? "").includes("ship the login page"),
    );
    expect(msgs.length).toBe(2);
    // The failure travelled as briefing, not as message text.
    expect(msgs.every((m) => !String(m.payload.text).includes("[Loom retry]"))).toBe(true);

    // …and the second agent genuinely took the turn. (The fixture prompt
    // carries the fail: trigger, so its turn errors too — the point proven is
    // the re-dispatch, and its error names the second agent, not the first.)
    await waitUntil(async () =>
      (await events()).some((e) => e.kind === "error" && e.agentId === "execbot"),
    );
  });

  it("refuses to retry onto an agent that doesn't exist", async () => {
    await expect(client.retryTurn(projectId, "ghost")).rejects.toThrow(/unknown agent/);
  });
});
