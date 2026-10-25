/**
 * Slack and Discord bridges (approach credit: Nuphos / openab), against stand-ins for both APIs:
 * Slack's Web API + Socket Mode, Discord's REST + gateway. A real daemon with echo agents.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { readDaemonConfig } from "../src/core/registry.js";
import { chunk } from "../src/daemon/chat-bridge.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

describe("chunk", () => {
  it("splits long replies on line breaks, under the platform's limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const parts = chunk(text, 1000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
});

/** Slack + Discord stand-ins on one server. */
function fakes() {
  const posts: Array<{ platform: string; channel: string; thread?: string; text: string }> = [];
  const acks: string[] = [];
  let slackSock: WebSocket | null = null;
  let discordSock: WebSocket | null = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const port = (server.address() as { port: number }).port;
      res.setHeader("content-type", "application/json");
      if (req.url === "/slack/auth.test") return res.end(JSON.stringify({ ok: true, user_id: "UBOT" }));
      if (req.url === "/slack/apps.connections.open") return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/slack-socket` }));
      if (req.url === "/slack/chat.postMessage") { posts.push({ platform: "slack", channel: body.channel, thread: body.thread_ts, text: body.text }); return res.end(JSON.stringify({ ok: true })); }
      if (req.url === "/discord/gateway/bot") return res.end(JSON.stringify({ url: `ws://127.0.0.1:${port}/discord-gw` }));
      const m = /^\/discord\/channels\/([^/]+)\/messages$/.exec(req.url ?? "");
      if (m) { posts.push({ platform: "discord", channel: m[1]!, text: body.content }); return res.end(JSON.stringify({ id: "1" })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    if (req.url === "/slack-socket") {
      slackSock = ws;
      ws.send(JSON.stringify({ type: "hello" }));
      ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.envelope_id) acks.push(m.envelope_id); });
    } else {
      discordSock = ws;
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "DBOT" } } })); });
    }
  });
  return {
    server, posts, acks,
    slack: (event: Record<string, unknown>, id = `env-${Math.random()}`) => slackSock!.send(JSON.stringify({ envelope_id: id, type: "events_api", payload: { event } })),
    discord: (d: Record<string, unknown>) => discordSock!.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d })),
    ready: () => Boolean(slackSock && discordSock),
  };
}

describe("bridges on a real daemon", () => {
  let daemon: LoomDaemon;
  let base: string;
  let admin: string;
  const f = fakes();
  const api = (method: string, p: string, body?: unknown) =>
    fetch(base + p, { method, headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

  beforeAll(async () => {
    await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
    const port = (f.server.address() as { port: number }).port;
    process.env.LOOM_HOME = tmpDir("home-bridges");
    process.env.LOOM_NO_NOTIFY = "1";
    process.env.LOOM_SLACK_API = `http://127.0.0.1:${port}/slack`;
    process.env.LOOM_DISCORD_API = `http://127.0.0.1:${port}/discord`;
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    const cfg = readDaemonConfig()!;
    base = `http://${cfg.host}:${cfg.port}`;
    admin = cfg.adminToken;
    await new DaemonClient(cfg).addProject(makeProjectDir({ name: "bridged" }));
  }, 60_000);
  afterAll(async () => {
    await daemon.close();
    delete process.env.LOOM_SLACK_API;
    delete process.env.LOOM_DISCORD_API;
    await new Promise((r) => f.server.close(r));
  });

  it("refuses a bridge that would hear nobody, and keeps tokens out of what it shows", async () => {
    expect((await api("PUT", "/api/bridges/slack", { botToken: "xoxb-1", appToken: "xapp-1" })).status).toBe(400);
    expect((await api("PUT", "/api/bridges/slack", { botToken: "xoxb-secret-token", appToken: "xapp-secret-token", users: "U1", channels: ["C1"] })).status).toBe(200);
    expect((await api("PUT", "/api/bridges/discord", { botToken: "discord-secret-token", users: ["D1"] })).status).toBe(200);
    const shown = await (await api("GET", "/api/bridges")).text();
    expect(shown).not.toContain("secret-token");
    await waitUntil(() => f.ready(), 10_000);
  }, 30_000);

  it("Slack: a mention from someone allowed gets the agent's answer in its thread; follow-ups need no mention", async () => {
    f.slack({ type: "app_mention", user: "U1", channel: "C1", ts: "100.1", text: "<@UBOT> hello from slack" }, "env-1");
    await waitUntil(() => f.posts.some((p) => p.platform === "slack" && p.thread === "100.1" && p.text.includes("hello from slack")), 20_000);
    expect(f.acks).toContain("env-1");
    expect(f.posts.find((p) => p.thread === "100.1")!.text).not.toContain("<@UBOT>");
    f.slack({ type: "message", user: "U1", channel: "C1", ts: "100.5", thread_ts: "100.1", text: "and a follow-up" });
    await waitUntil(() => f.posts.some((p) => p.thread === "100.1" && p.text.includes("and a follow-up")), 20_000);
  }, 60_000);

  it("Slack: strangers, other channels, other bots, and un-mentioned chatter are ignored", async () => {
    const before = f.posts.length;
    f.slack({ type: "app_mention", user: "U9", channel: "C1", ts: "200.1", text: "<@UBOT> let me in" });
    f.slack({ type: "app_mention", user: "U1", channel: "C2", ts: "201.1", text: "<@UBOT> wrong channel" });
    f.slack({ type: "app_mention", user: "U1", bot_id: "B1", channel: "C1", ts: "202.1", text: "<@UBOT> a bot" });
    f.slack({ type: "message", user: "U1", channel: "C1", ts: "203.1", text: "just chatting" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(f.posts.length).toBe(before);
    const status = (await (await api("GET", "/api/bridges")).json()) as { slack: { status: { ignored: number } } };
    expect(status.slack.status.ignored).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("Discord: a mention gets the answer in the same channel", async () => {
    f.discord({ id: "m1", channel_id: "C9", guild_id: "G1", content: "<@DBOT> hi from discord", author: { id: "D1", username: "nick" }, mentions: [{ id: "DBOT" }] });
    await waitUntil(() => f.posts.some((p) => p.platform === "discord" && p.channel === "C9" && p.text.includes("hi from discord")), 20_000);
    const before = f.posts.length;
    f.discord({ id: "m2", channel_id: "C8", guild_id: "G1", content: "<@DBOT> I'm not allowed", author: { id: "D2" }, mentions: [{ id: "DBOT" }] });
    await new Promise((r) => setTimeout(r, 1000));
    expect(f.posts.length).toBe(before);
  }, 60_000);
});
