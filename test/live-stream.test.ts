/**
 * Replies as they're written.
 *
 * Before this, the thread showed nothing between your send and the agent's
 * finished message — fifteen seconds of a blank pane, then a wall of text —
 * because nothing between an adapter and the socket carried text that wasn't a
 * finished event. These pin the new path at each hop: the adapters that can
 * stream turn their tool's own deltas into StreamDelta, the daemon puts them on
 * the wire as "stream" frames (and never in the log), and the pieces around it
 * (paging the log backwards, provider-qualified model ids) hold.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EchoAdapter } from "../src/adapters/echo.js";
import { splitQualifiedModel } from "../src/adapters/model.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { EventLog } from "../src/core/eventlog.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { StreamDelta } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

describe("a model id picked off the all-providers list", () => {
  it("splits the provider off the front, and keeps the model's own slashes", () => {
    expect(splitQualifiedModel({ model: "openrouter/google/gemma-4-31b-it:free" })).toEqual({
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
    });
    expect(splitQualifiedModel({ model: "ollama/llama3" })).toEqual({ provider: "ollama", model: "llama3" });
  });

  it("leaves alone what isn't a provider, or already names one", () => {
    // OpenRouter's own id for an OpenAI model: the default provider's, not OpenAI's
    expect(splitQualifiedModel({ model: "openai/gpt-4o" })).toEqual({ model: "openai/gpt-4o" });
    expect(splitQualifiedModel({ model: "google/gemma-4-31b-it:free" })).toEqual({ model: "google/gemma-4-31b-it:free" });
    expect(splitQualifiedModel({ model: "groq/llama", provider: "openrouter" })).toEqual({ model: "groq/llama", provider: "openrouter" });
    expect(splitQualifiedModel({ model: "plain" })).toEqual({ model: "plain" });
  });
});

describe("paging a thread backwards", () => {
  for (const store of ["sqlite", "jsonl"] as const) {
    it(`returns the page before a cursor, oldest first (${store})`, async () => {
      const prev = process.env.LOOM_STORE;
      if (store === "jsonl") process.env.LOOM_STORE = "jsonl";
      else delete process.env.LOOM_STORE;
      try {
        const log = await EventLog.open(tmpDir(`log-${store}`));
        for (let i = 1; i <= 10; i++) log.append({ kind: "message", chat: "main", payload: { text: `m${i}` } });
        const page = log.list({ before: 8, limit: 3, chat: "main" });
        expect(page.map((e) => e.payload.text)).toEqual(["m5", "m6", "m7"]);
        expect(log.list({ before: 2, chat: "main" }).map((e) => e.payload.text)).toEqual(["m1"]);
        log.close();
      } finally {
        if (prev === undefined) delete process.env.LOOM_STORE;
        else process.env.LOOM_STORE = prev;
      }
    });
  }
});

describe("opencode's live text", () => {
  it("streams session.next deltas for its own session only", () => {
    const a = new OpenCodeAdapter("opencode", tmpDir("oc"), {});
    const got: StreamDelta[] = [];
    a.onStream((d) => got.push(d));
    const sse = (a as unknown as { handleSse(e: unknown): void; sessionId: string | null });
    sse.sessionId = "ses_mine";
    sse.handleSse({ type: "session.next.text.delta", properties: { sessionID: "ses_mine", delta: "Warp" } });
    sse.handleSse({ type: "session.next.text.delta", properties: { sessionID: "ses_other", delta: "not mine" } });
    sse.handleSse({ type: "session.next.reasoning.delta", properties: { sessionID: "ses_mine", delta: "hmm" } });
    sse.handleSse({ type: "session.next.text.delta", properties: { sessionID: "ses_mine", delta: " threads" } });
    expect(got).toEqual([{ text: "Warp" }, { text: "hmm", reasoning: true }, { text: " threads" }]);
  });
});

describe("the echo agent types when asked to", () => {
  it("streams the reply word by word, then logs it once", async () => {
    const a = new EchoAdapter("echo", tmpDir("echo"));
    const pieces: string[] = [];
    const messages: string[] = [];
    a.onStream((d) => pieces.push(d.text));
    a.onEvent((e) => { if (e.kind === "message") messages.push(String(e.payload.text)); });
    await a.send({ text: "stream:1 three little words" });
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join("")).toBe(messages[0]);
    expect(messages).toHaveLength(1);
  });
});

describe("the daemon puts a reply on the wire as it's written", () => {
  let daemon: LoomDaemon;
  let ws: WebSocket;
  let client: DaemonClient;
  let projectId: string;
  const frames: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home-stream");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    const { host, port } = await daemon.listen();
    const cfg = readDaemonConfig()!;
    client = new DaemonClient(cfg);
    const dir = makeProjectDir({ name: "streaming" });
    fs.writeFileSync(path.join(dir, "README.md"), "# streaming\n");
    projectId = (await client.addProject(dir)).project.id;
    ws = new WebSocket(`ws://${host}:${port}/ws?token=${cfg.adminToken}&project=${projectId}`);
    ws.on("message", (d) => {
      try { frames.push(JSON.parse(String(d)) as Record<string, unknown>); } catch { /* not JSON */ }
    });
    ws.on("error", () => {});
    await new Promise<void>((r) => ws.once("open", () => r()));
  });

  afterAll(async () => {
    ws?.close();
    await daemon?.close();
  });

  it("sends stream frames for the thread, before the message, and never logs them", async () => {
    await client.send(projectId, "stream:15 a reply that arrives in pieces", "plannerbot");
    await waitUntil(() => frames.some((f) => f.type === "event" && (f.event as { kind?: string })?.kind === "run_complete"));

    const streams = frames.filter((f) => f.type === "stream");
    expect(streams.length).toBeGreaterThan(1);
    expect(streams.every((f) => f.agentId === "plannerbot" && f.chat === "main")).toBe(true);
    const typed = streams.map((f) => String(f.text)).join("");
    const msgAt = frames.findIndex((f) => f.type === "event" && (f.event as { kind?: string; agentId?: string })?.kind === "message" &&
      (f.event as { agentId?: string }).agentId === "plannerbot");
    const lastStreamAt = frames.map((f) => f.type).lastIndexOf("stream");
    // every typed piece reached the socket before the finished message did
    expect(lastStreamAt).toBeLessThan(msgAt);
    const message = String(((frames[msgAt]!.event as { payload: { text: string } }).payload.text));
    expect(typed).toBe(message);

    // the log holds the reply once, and nothing of its typing
    const { events } = await (await fetch(`${client.baseUrl}/api/projects/${projectId}/events?limit=50`, {
      headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}` },
    })).json() as { events: Array<{ kind: string; agentId?: string }> };
    expect(events.filter((e) => e.kind === "message" && e.agentId === "plannerbot")).toHaveLength(1);
    expect(events.some((e) => (e.kind as string) === "stream")).toBe(false);
  });

  it("keeps what was typed when the turn is stopped mid-reply, marked partial", async () => {
    const before = frames.length;
    await client.send(projectId, "stream:120 one two three four five six seven eight nine ten", "plannerbot");
    await waitUntil(() => frames.slice(before).filter((f) => f.type === "stream" && f.agentId === "plannerbot").length >= 2);
    await client.interrupt(projectId);
    await waitUntil(() => frames.slice(before).some((f) => f.type === "event" &&
      (f.event as { kind?: string; agentId?: string; payload?: { state?: string } }).agentId === "plannerbot" &&
      (f.event as { kind?: string }).kind === "status" && (f.event as { payload: { state?: string } }).payload.state === "interrupted"));
    const typed = frames.slice(before).filter((f) => f.type === "stream" && f.agentId === "plannerbot").map((f) => String(f.text)).join("");
    const { events } = await (await fetch(`${client.baseUrl}/api/projects/${projectId}/events?limit=50`, {
      headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}` },
    })).json() as { events: Array<{ kind: string; agentId?: string; payload: { text?: string; partial?: boolean } }> };
    const kept = events.filter((e) => e.kind === "message" && e.agentId === "plannerbot" && e.payload.partial);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.payload.partial).toBe(true);
    expect(kept[0]!.payload.text).toBe(typed);
    expect(typed.length).toBeGreaterThan(0);
  });
});
