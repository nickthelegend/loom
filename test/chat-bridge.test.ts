/**
 * Slack and Discord bridges (approach credit: Nuphos / openab), against stand-ins for both APIs:
 * Slack's Web API + Socket Mode, Discord's REST + gateway. A real daemon with echo agents.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { JSDOM, VirtualConsole } from "jsdom";
import { APP_HTML } from "../src/daemon/app-page.js";
import { requestApproval } from "../src/core/approvals.js";
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

interface Message {
  platform: string;
  channel: string;
  thread?: string;
  id: string;
  text: string;
  actions: string[];
}

/** Slack + Discord stand-ins on one server. */
function fakes() {
  const posts: Message[] = [];
  const requests: Array<{ method: string; url: string; body: Record<string, any> }> = [];
  const feedback: string[] = [];
  const delays = { post: 0, failEdits: 0 };
  const acks: string[] = [];
  let slackSock: WebSocket | null = null;
  let discordSock: WebSocket | null = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method!, url: req.url!, body });
      const port = (server.address() as { port: number }).port;
      res.setHeader("content-type", "application/json");
      if (req.url === "/slack/auth.test") return res.end(JSON.stringify({ ok: true, user_id: "UBOT" }));
      if (req.url === "/slack/apps.connections.open") return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/slack-socket` }));
      if (req.url === "/slack/chat.postEphemeral") { feedback.push(body.text); return res.end(JSON.stringify({ ok: true })); }
      if (req.url === "/slack/chat.postMessage") {
        const id = String(posts.length + 1);
        posts.push({ platform: "slack", channel: body.channel, thread: body.thread_ts, text: body.text, id,
          actions: body.blocks?.find((b: any) => b.type === "actions")?.elements.map((b: any) => b.action_id) ?? [] });
        return setTimeout(() => res.end(JSON.stringify({ ok: true, ts: id })), delays.post);
      }
      const edit = /^\/discord\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(req.url ?? "");
      if (req.url === "/slack/chat.update" || (edit && req.method === "PATCH")) {
        if (delays.failEdits > 0) { delays.failEdits--; res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "temporary failure" })); }
        const msg = posts.find((p) => p.id === (edit ? edit[2] : body.ts) && p.channel === (edit ? edit[1] : body.channel));
        if (!msg) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false })); }
        msg.text = edit ? body.content : body.text;
        msg.actions = [];
        return res.end(JSON.stringify({ ok: true, id: msg.id, ts: msg.id }));
      }
      if (/^\/discord\/interactions\/[^/]+\/[^/]+\/callback$/.test(req.url ?? "")) {
        feedback.push(body.data.content); res.statusCode = 204; return res.end();
      }
      if (req.url === "/discord/gateway/bot") return res.end(JSON.stringify({ url: `ws://127.0.0.1:${port}/discord-gw` }));
      const m = /^\/discord\/channels\/([^/]+)\/messages$/.exec(req.url ?? "");
      if (m) {
        const id = String(posts.length + 1);
        posts.push({ platform: "discord", channel: m[1]!, text: body.content, id,
          actions: body.components?.[0]?.components.map((b: any) => b.custom_id) ?? [] });
        return setTimeout(() => res.end(JSON.stringify({ id })), delays.post);
      }
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
    server, posts, acks, requests, feedback, delays,
    click: (message: Message, user: string, name: string, action = message.actions[0]!, overrides: { channel?: string; message?: string } = {}) => {
      if (message.platform === "slack") slackSock!.send(JSON.stringify({ envelope_id: `click-${Math.random()}`, type: "interactive", payload: {
        type: "block_actions", user: { id: user, name }, channel: { id: overrides.channel ?? message.channel },
        message: { ts: overrides.message ?? message.id }, actions: [{ action_id: action }],
      } }));
      else discordSock!.send(JSON.stringify({ op: 0, t: "INTERACTION_CREATE", d: {
        type: 3, id: `click-${Math.random()}`, token: "interaction-token", channel_id: overrides.channel ?? message.channel,
        message: { id: overrides.message ?? message.id }, member: { user: { id: user, username: name }, nick: name },
        data: { component_type: 2, custom_id: action },
      } }));
    },
    slack: (event: Record<string, unknown>, id = `env-${Math.random()}`) => slackSock!.send(JSON.stringify({ envelope_id: id, type: "events_api", payload: { event } })),
    discord: (d: Record<string, unknown>) => discordSock!.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d })),
    ready: () => Boolean(slackSock && discordSock),
  };
}

describe("bridges on a real daemon", () => {
  let daemon: LoomDaemon;
  let base: string;
  let admin: string;
  let projectId: string;
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
    projectId = (await new DaemonClient(cfg).addProject(makeProjectDir({ name: "bridged", agents: [{ id: "echo", kind: "echo", role: "executor" }] }))).project.id;
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
    await waitUntil(() => f.ready(), { timeoutMs: 10_000 });
  }, 30_000);

  it("Slack: a mention from someone allowed gets the agent's answer in its thread; follow-ups need no mention", async () => {
    f.slack({ type: "app_mention", user: "U1", channel: "C1", ts: "100.1", text: "<@UBOT> hello from slack" }, "env-1");
    await waitUntil(() => f.posts.some((p) => p.platform === "slack" && p.thread === "100.1" && p.text.includes("hello from slack")), { timeoutMs: 20_000 });
    expect(f.acks).toContain("env-1");
    expect(f.posts.find((p) => p.thread === "100.1")!.text).not.toContain("<@UBOT>");
    f.slack({ type: "message", user: "U1", channel: "C1", ts: "100.5", thread_ts: "100.1", text: "and a follow-up" });
    await waitUntil(() => f.posts.some((p) => p.thread === "100.1" && p.text.includes("and a follow-up")), { timeoutMs: 20_000 });
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
    await waitUntil(() => f.posts.some((p) => p.platform === "discord" && p.channel === "C9" && p.text.includes("hi from discord")), { timeoutMs: 20_000 });
    const before = f.posts.length;
    f.discord({ id: "m2", channel_id: "C8", guild_id: "G1", content: "<@DBOT> I'm not allowed", author: { id: "D2" }, mentions: [{ id: "DBOT" }] });
    await new Promise((r) => setTimeout(r, 1000));
    expect(f.posts.length).toBe(before);
  }, 60_000);

  for (const platform of ["slack", "discord"] as const) {
    const channel = platform === "slack" ? "C1" : "C9";
    const thread = platform === "slack" ? "100.1" : "C9";
    const user = platform === "slack" ? "U1" : "D1";
    const send = (text: string) => platform === "slack"
      ? f.slack({ type: "message", user, channel, ts: `${Date.now()}`, thread_ts: thread, text })
      : f.discord({ id: `${Date.now()}`, channel_id: channel, guild_id: "G1", content: text, author: { id: user } });
    const messages = () => f.posts.filter((m) => m.platform === platform && m.channel === channel);
    const events = async () => (await (await api("GET", `/api/projects/${projectId}/events?limit=500`)).json()).events as Array<{ kind: string; payload: Record<string, unknown> }>;
    const pending = async () => (await (await api("GET", `/api/projects/${projectId}/approvals`)).json()).approvals as Array<{ id: string }>;
    const click = async (card: Message, who: string, action: string, overrides = {}) => {
      const before = f.feedback.length;
      f.click(card, who, "Pat", action, overrides);
      await waitUntil(() => f.feedback.length > before);
      if (platform === "discord") {
        expect(f.requests.findLast((r) => r.url.endsWith("/callback"))!.body).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
      } else expect(f.acks.some((id) => id.startsWith("click-"))).toBe(true);
      return f.feedback.at(-1)!;
    };
    const ask = async () => {
      const before = f.posts.length;
      const controller = new AbortController();
      const decision = requestApproval({ project: projectId, agent: "echo", tool: "Bash", input: { command: "npm test" }, signal: controller.signal });
      await waitUntil(() => f.posts.slice(before).some((m) => m.platform === platform && m.actions.length === 2));
      const card = f.posts.slice(before).find((m) => m.platform === platform && m.actions.length === 2)!;
      const actions = [...card.actions];
      const id = actions[0]!.split(":").at(-1)!;
      return { decision, controller, card, actions, id };
    };

    it(`${platform}: posts at turn start, edits the current tool, then replaces the same message with the answer`, async () => {
      const before = messages().length;
      const reqs = f.requests.length;
      send("run:npm test sleep:2500");
      await waitUntil(() => messages().length > before);
      const status = messages()[before]!;
      expect(status.text).toBe("The agent is working…");
      await waitUntil(() => status.text === "echo is using shell…");
      expect(messages()).toHaveLength(before + 1);
      await waitUntil(() => status.text.includes("echo(echo):"));
      expect(messages()).toHaveLength(before + 1);
      const writes = f.requests.slice(reqs).filter((r) => r.url.includes(platform) && (r.url.includes("chat.update") || r.method === "PATCH"));
      expect(writes.length).toBeGreaterThanOrEqual(2);
      expect(writes.at(-1)!.body[platform === "slack" ? "blocks" : "components"]).toEqual([]);
    });

    it(`${platform}: queued turns each get their own status and final answer`, async () => {
      const before = messages().length;
      send("sleep:700 first queued turn");
      await waitUntil(() => messages().length > before);
      send("sleep:700 second queued turn");
      await waitUntil(() => messages().length === before + 2);
      const [first, second] = messages().slice(before);
      expect(first!.text).toContain("first queued turn");
      expect(first!.text).not.toContain("second queued turn");
      expect(second!.text).toBe("The agent is working…");
      await waitUntil(() => second!.text.includes("second queued turn"));
      expect(messages()).toHaveLength(before + 2);
    });

    it(`${platform}: serializes a slow initial post and splits long final answers`, async () => {
      const before = messages().length;
      f.delays.post = 150;
      try {
        send("long-answer " + "x".repeat(5000));
        await waitUntil(() => messages().slice(before).some((m) => m.text.includes("from ")));
        const sent = messages().slice(before);
        expect(sent).toHaveLength(platform === "slack" ? 2 : 3);
        expect(sent[0]!.text).toContain("long-answer");
        expect(sent.every((m) => m.text.length <= (platform === "slack" ? 3800 : 1900))).toBe(true);
        expect(sent.map((m) => m.text).join("")).toContain("x".repeat(5000));
      } finally { f.delays.post = 0; }
    });

    it(`${platform}: replaces status on errors and interruption, and can recover from a failed edit`, async () => {
      let before = messages().length;
      send("fail:bridge test failure");
      await waitUntil(() => messages().slice(before).some((m) => m.text === "echo stopped: bridge test failure"));
      before = messages().length;
      send("sleep:5000");
      await waitUntil(() => messages().length > before);
      // the status message goes up at turn_started, a beat before the agent is busy — interrupting
      // in that gap stops nothing (CI caught it), so wait until it's really working
      await waitUntil(async () => {
        const r = await (await api("GET", `/api/projects/${projectId}`)).json() as { project?: { agents?: Array<{ busy?: boolean }> } };
        return Boolean(r.project?.agents?.some((a) => a.busy));
      });
      await api("POST", `/api/projects/${projectId}/interrupt`);
      await waitUntil(() => messages().slice(before).some((m) => m.text === "echo was interrupted."));
      before = messages().length;
      f.delays.failEdits = 1;
      send("edit recovery");
      await waitUntil(() => messages().slice(before).some((m) => m.text.includes("echo(echo): edit recovery")));
      expect(f.delays.failEdits).toBe(0);
    });

    it(`${platform}: only default approvers can decide, bound to the original message, once, with attribution`, async () => {
      const a = await ask();
      try {
        expect(a.card.text).toContain("npm test");
        const posted = f.requests.findLast((r) => r.url === (platform === "slack" ? "/slack/chat.postMessage" : `/discord/channels/${channel}/messages`))!.body;
        if (platform === "slack") {
          expect(posted.blocks).toMatchObject([{ type: "section", text: { type: "plain_text" } }, { type: "actions", elements: [
            { type: "button", text: { text: "Allow" }, action_id: a.actions[0] },
            { type: "button", text: { text: "Deny" }, action_id: a.actions[1] },
          ] }]);
        } else expect(posted.components).toMatchObject([{ type: 1, components: [
          { type: 2, label: "Allow", custom_id: a.actions[0] }, { type: 2, label: "Deny", custom_id: a.actions[1] },
        ] }]);
        expect(await click(a.card, user, a.actions[0]!.replace(":allow:", ":allow_session:"))).toContain("no longer available");
        expect(await click(a.card, "stranger", a.actions[0]!)).toContain("aren't allowed");
        expect(await click(a.card, user, a.actions[0]!, { channel: "elsewhere" })).not.toBe("Approval allowed.");
        expect(await click(a.card, user, a.actions[0]!, { message: "different-message" })).toContain("no longer available");
        expect(await pending()).toContainEqual(expect.objectContaining({ id: a.id }));
        expect(await click(a.card, user, a.actions[0]!)).toBe("Approval allowed.");
        expect(await a.decision).toEqual({ behavior: "allow" });
        await waitUntil(() => a.card.actions.length === 0);
        expect(a.card.text).toBe("Allowed: Bash by Pat.");
        expect(await click(a.card, user, a.actions[1]!)).toContain("no longer available");
        const decided = (await events()).filter((e) => e.kind === "approval" && e.payload.approvalId === a.id && e.payload.phase === "decided");
        expect(decided).toHaveLength(1);
        expect(decided[0]!.payload).toMatchObject({ by: "Pat", behavior: "allow" });
      } finally { a.controller.abort(); }
    });

    it(`${platform}: explicit approvers replace users, including an empty list; configuration changes apply to existing cards`, async () => {
      const a = await ask();
      try {
        expect((await api("PUT", `/api/bridges/${platform}`, { approvers: [] })).status).toBe(200);
        // Wait for the new socket to finish its handshake before clicking.
        await waitUntil(async () => (await (await api("GET", "/api/bridges")).json())[platform].status.connected);
        expect(await click(a.card, user, a.actions[0]!)).toContain("aren't allowed");
        expect((await api("PUT", `/api/bridges/${platform}`, { approvers: "reviewer" })).status).toBe(200);
        await waitUntil(async () => (await (await api("GET", "/api/bridges")).json())[platform].status.connected);
        expect(await click(a.card, user, a.actions[0]!)).toContain("aren't allowed");
        expect(await click(a.card, "reviewer", a.actions[1]!)).toBe("Approval denied.");
        expect(await a.decision).toMatchObject({ behavior: "deny" });
        await waitUntil(() => a.card.actions.length === 0);
        expect(a.card.text).toContain("Denied: Bash by Pat.");
        const shown = await (await api("GET", "/api/bridges")).json();
        expect(shown[platform].approvers).toEqual(["reviewer"]);
      } finally {
        a.controller.abort();
        await api("PUT", `/api/bridges/${platform}`, { approvers: null });
        await waitUntil(async () => (await (await api("GET", "/api/bridges")).json())[platform].status.connected);
      }
    });

    it(`${platform}: decisions in Loom and aborted requests remove channel buttons`, async () => {
      const a = await ask();
      try {
        expect((await api("POST", `/api/projects/${projectId}/approvals/${a.id}`, { decision: "allow" })).status).toBe(200);
        expect(await a.decision).toEqual({ behavior: "allow" });
        await waitUntil(() => a.card.actions.length === 0);
        expect(await click(a.card, user, a.actions[1]!)).toContain("no longer available");
      } finally { a.controller.abort(); }
      const b = await ask();
      b.controller.abort();
      expect(await b.decision).toMatchObject({ behavior: "deny" });
      await waitUntil(() => b.card.actions.length === 0);
      expect(b.card.text).toContain("The agent stopped waiting.");
    });
  }


  it("Settings saves separate approvers, nobody, and the users default through the real API", async () => {
    const errors: string[] = [];
    const sockets: WebSocket[] = [];
    const console = new VirtualConsole();
    console.on("jsdomError", (e: Error) => errors.push(e.message));
    let closed = false;
    const never = new Promise<never>(() => {});
    const dom = new JSDOM(APP_HTML, {
      url: `${base}/app`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
      beforeParse(window) {
        window.scrollTo = () => {};
        window.HTMLElement.prototype.scrollTo = () => {};
        window.HTMLElement.prototype.scrollIntoView = () => {};
        window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
        window.matchMedia = ((media: string) => ({ matches: media.includes("min-width"), media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as any;
        window.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(input, base), init).then((r) => closed ? never : r)) as any;
        window.WebSocket = class extends WebSocket {
          constructor(url: string, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
        } as any;
        window.localStorage.setItem("loomClientToken", admin);
        window.localStorage.setItem("loomSetupSeen", "1");
        window.localStorage.setItem("loomDevMode", "1");
      },
    });
    const doc = dom.window.document;
    const input = (key: string) => doc.querySelector(`[data-b="slack-${key}"]`) as HTMLInputElement;
    const config = async () => (await (await api("GET", "/api/bridges")).json()).slack;
    try {
      await waitUntil(() => !!doc.querySelector("#slist .srow"));
      doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      await waitUntil(() => !!doc.querySelector("#pq"));
      const query = doc.querySelector("#pq") as HTMLInputElement;
      query.value = "Slack";
      query.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitUntil(() => doc.querySelector(".prow")?.textContent?.includes("Slack") === true);
      (doc.querySelector(".prow") as HTMLElement).click();
      await waitUntil(() => !!input("approvers"));
      expect(input("same-approvers").checked).toBe(true);
      expect(input("approvers").disabled).toBe(true);
      input("same-approvers").click();
      expect(input("approvers").disabled).toBe(false);
      input("approvers").value = "U2, U3";
      const save = () => (doc.querySelector('[data-save="slack"]') as HTMLButtonElement).click();
      save();
      await waitUntil(async () => (await config()).approvers?.join(",") === "U2,U3");
      await waitUntil(() => input("approvers")?.value === "U2, U3" && !(doc.querySelector('[data-save="slack"]') as HTMLButtonElement)?.disabled);
      expect(input("same-approvers").checked).toBe(false);
      input("approvers").value = "";
      save();
      await waitUntil(async () => (await config()).approvers?.length === 0);
      await waitUntil(() => !!input("same-approvers") && !(doc.querySelector('[data-save="slack"]') as HTMLButtonElement)?.disabled);
      expect(input("same-approvers").checked).toBe(false);
      input("same-approvers").click();
      save();
      await waitUntil(async () => (await config()).approvers === undefined);
      await waitUntil(() => input("approvers")?.disabled === true);
      expect(errors).toEqual([]);
    } finally {
      closed = true;
      for (const ws of sockets) { ws.removeAllListeners(); ws.on("error", () => {}); ws.terminate(); }
      dom.window.close();
    }
  });

});
