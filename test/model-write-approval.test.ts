/**
 * A model agent asking a person before it writes — the whole way round.
 *
 * The unit tests hand the adapter a broker directly. This one goes through the
 * daemon, because the thing most likely to be wrong is the wiring: does the
 * card actually reach the thread, does answering it over HTTP actually release
 * the agent, and does the file appear only when the answer was yes.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setProvider } from "../src/core/providers.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon | null = null;
let provider: http.Server | null = null;

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  provider?.closeAllConnections?.();
  await new Promise<void>((r) => (provider ? provider.close(() => r()) : r()));
  provider = null;
});

beforeEach(() => {
  process.env.LOOM_HOME = tmpDir("home-approval");
  process.env.LOOM_NO_NOTIFY = "1";
});

/** A model that asks to write one file, then reports what happened. */
async function writingProvider(): Promise<string> {
  provider = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages: Array<{ role: string; content: string }> };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!body.messages.some((m) => m.role === "tool")) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "w1",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: "NOTES.md",
                          content: "written by a model\n",
                          why: "the note you asked for",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "all done" } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    provider!.listen(0, "127.0.0.1", () => resolve((provider!.address() as net.AddressInfo).port));
  });
  const id = `ap-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "Ap" });
  return id;
}

async function stand() {
  const providerId = await writingProvider();
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  const base = `http://${host}:${port}`;
  const token = readDaemonConfig()!.adminToken;
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const dir = makeProjectDir({
    name: "approving",
    agents: [
      {
        id: "cheap",
        kind: "model",
        role: "executor",
        options: { provider: providerId, model: "m", tools: true, write: true },
      },
    ],
  });
  const added = await api("/api/projects", { method: "POST", body: JSON.stringify({ dir }) });
  const pid = (added.body as { project: { id: string } }).project.id;
  return { api, pid, dir };
}

/** The pending approval in the thread, once it turns up. */
async function pendingCard(
  api: (p: string, i?: RequestInit) => Promise<{ body: Record<string, unknown> }>,
  pid: string,
) {
  let card: Record<string, unknown> | undefined;
  await waitUntil(async () => {
    const { body } = await api(`/api/projects/${pid}/events?limit=50`);
    const events = (body.events ?? []) as Array<{ kind: string; payload: Record<string, unknown> }>;
    card = events.find((e) => e.kind === "approval" && e.payload.phase === "requested")?.payload;
    return Boolean(card);
  });
  return card!;
}

describe("a model asking to write, through the daemon", () => {
  it("shows the card, waits, and writes when you allow it", async () => {
    const { api, pid, dir } = await stand();
    await api(`/api/projects/${pid}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "add a note", agentId: "cheap" }),
    });

    const card = await pendingCard(api, pid);
    expect(card.tool).toBe("write_file");
    // The card says what would happen, in words, not as a JSON dump.
    expect(String(card.input)).toContain("write NOTES.md");
    expect(String(card.input)).toContain("the note you asked for");
    // Nothing has been written while it waits.
    expect(fs.existsSync(path.join(dir, "NOTES.md"))).toBe(false);

    const answered = await api(`/api/projects/${pid}/approvals/${String(card.approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(answered.body.ok).toBe(true);

    await waitUntil(() => fs.existsSync(path.join(dir, "NOTES.md")));
    expect(fs.readFileSync(path.join(dir, "NOTES.md"), "utf8")).toBe("written by a model\n");

    // …and the decision is in the thread beside the request, as an audit trail.
    const { body } = await api(`/api/projects/${pid}/events?limit=50`);
    const decided = (body.events as Array<{ kind: string; payload: Record<string, unknown> }>).find(
      (e) => e.kind === "approval" && e.payload.phase === "decided",
    );
    expect(decided!.payload).toMatchObject({ behavior: "allow", tool: "write_file" });
  }, 60_000);

  it("writes nothing when you deny it, and tells the model why", async () => {
    const { api, pid, dir } = await stand();
    await api(`/api/projects/${pid}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "add a note", agentId: "cheap" }),
    });

    const card = await pendingCard(api, pid);
    await api(`/api/projects/${pid}/approvals/${String(card.approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ decision: "deny", message: "not that file" }),
    });

    await waitUntil(async () => {
      const { body } = await api(`/api/projects/${pid}/events?limit=50`);
      return (body.events as Array<{ kind: string }>).some((e) => e.kind === "run_complete");
    });
    expect(fs.existsSync(path.join(dir, "NOTES.md"))).toBe(false);

    const { body } = await api(`/api/projects/${pid}/events?limit=50`);
    const said = (body.events as Array<{ kind: string; agentId?: string; payload: Record<string, unknown> }>)
      .filter((e) => e.kind === "message" && e.agentId === "cheap")
      .map((e) => String(e.payload.text))
      .join("");
    expect(said).toContain("all done"); // it carried on rather than dying
  }, 60_000);
});
