/**
 * Slack and Discord: the same agents, in the channel your team already talks in. Mention the bot
 * and the message goes to a Loom thread (one per Slack thread / Discord channel or thread); the
 * agent's answer comes back there. Replies in a bridged thread need no mention.
 *
 * Runs in the daemon with your own bot's tokens — Slack over Socket Mode, Discord over its
 * gateway — so nothing needs a public URL and no hosted service sits in between. Only people on
 * the allow-list are heard: everyone else, and other bots, are ignored. A bridged turn runs
 * this machine's agents as you, so approvals stay where they are (Loom, your phone); the
 * channel is told a turn is waiting on one.
 *
 * Approach credit: Nuphos (github.com/nuphos/nuphos, Apache-2.0, © Zeabur Inc.) — "add the same
 * agent to Slack or Discord" — and openab (MIT, openabdev), whose Socket Mode / gateway bots and
 * allow-lists Nuphos vendors. Loom's version never auto-approves anything.
 */

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { logbook } from "../core/logbook.js";
import { listProjects, loomHome } from "../core/registry.js";
import type { LoomEvent } from "../types.js";
import type { ProjectRuntime } from "./runtime.js";

export type Platform = "slack" | "discord";

export interface BridgeConfig {
  enabled: boolean;
  botToken: string;
  /** Slack only: the app-level token (xapp-…) Socket Mode connects with. */
  appToken?: string;
  /** Who is heard (Slack user ids U…, Discord user ids). Empty hears nobody. */
  users: string[];
  /** Where (channel ids). Empty: any channel the bot is in. */
  channels: string[];
  /** The project its threads run in (name or id); default: the only project. */
  project?: string;
  /** Who answers; default: whoever holds the baton. */
  agent?: string;
}

interface BridgesFile { slack?: BridgeConfig; discord?: BridgeConfig }
interface ThreadRef { platform: Platform; channel: string; thread: string; projectId: string; chat: string }

const configFile = () => path.join(loomHome(), "bridges.json");
const stateFile = () => path.join(loomHome(), "bridges-state.json");

export function readBridges(): BridgesFile {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")) as BridgesFile; } catch { return {}; }
}
export function writeBridges(b: BridgesFile): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(b, null, 2) + "\n", { mode: 0o600 });
}
function readThreads(): ThreadRef[] {
  try { const t = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as { threads?: ThreadRef[] }; return t.threads ?? []; } catch { return []; }
}
function writeThreads(threads: ThreadRef[]): void {
  fs.writeFileSync(stateFile(), JSON.stringify({ threads: threads.slice(-500) }, null, 2) + "\n", { mode: 0o600 });
}

/** A token as a client sees it: enough to recognise, never enough to use. */
export const maskToken = (t?: string) => (t ? `${t.slice(0, 5)}…${t.slice(-4)}` : "");

/** Split text into pieces a platform will take (Slack ~4000, Discord 2000), on line breaks where possible. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

interface Incoming {
  platform: Platform;
  channel: string;
  /** The thread a reply goes to: Slack's thread_ts, a Discord channel/thread id. */
  thread: string;
  user: string;
  userName?: string;
  text: string;
  /** Mentioned the bot (or a DM) — a fresh thread needs that; a bridged one doesn't. */
  mentioned: boolean;
}

interface PlatformClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  post(channel: string, thread: string, text: string): Promise<void>;
}

/** The platform-neutral half: who's heard, which Loom thread, and getting answers back. */
export class ChatBridges {
  private clients = new Map<Platform, PlatformClient>();
  private threads: ThreadRef[] = readThreads();
  private watching = new Map<string, () => void>();
  /** chat key → the agent text gathered this turn, posted when the turn ends. */
  private pending = new Map<string, string[]>();
  status: Partial<Record<Platform, { connected: boolean; error?: string; heard: number; ignored: number }>> = {};

  constructor(
    private runtime: (projectId: string) => Promise<ProjectRuntime>,
    private api = { slack: process.env.LOOM_SLACK_API || "https://slack.com/api", discord: process.env.LOOM_DISCORD_API || "https://discord.com/api/v10" },
  ) {}

  async startAll(): Promise<void> {
    const b = readBridges();
    for (const p of ["slack", "discord"] as const) if (b[p]?.enabled) await this.restart(p).catch(() => {});
  }

  async restart(p: Platform): Promise<void> {
    await this.clients.get(p)?.stop().catch(() => {});
    this.clients.delete(p);
    const cfg = readBridges()[p];
    if (!cfg?.enabled) { delete this.status[p]; return; }
    const st: { connected: boolean; error?: string; heard: number; ignored: number } = (this.status[p] = { connected: false, heard: 0, ignored: 0 });
    const on = (m: Incoming) => void this.incoming(cfg, m).catch((e) => logbook.warn("bridge", `${p} message failed`, String(e)));
    const client = p === "slack"
      ? new SlackClient(this.api.slack, cfg, on, (ok, err) => { st.connected = ok; if (err) st.error = err; else delete st.error; })
      : new DiscordClient(this.api.discord, cfg, on, (ok, err) => { st.connected = ok; if (err) st.error = err; else delete st.error; });
    this.clients.set(p, client);
    try { await client.start(); }
    catch (e) { st.error = (e as Error).message; logbook.warn("bridge", `${p} didn't connect`, st.error); throw e; }
    // threads bridged before a restart keep answering
    for (const t of this.threads.filter((x) => x.platform === p)) await this.watch(t).catch(() => {});
  }

  async stopAll(): Promise<void> {
    for (const c of this.clients.values()) await c.stop().catch(() => {});
    this.clients.clear();
    for (const off of this.watching.values()) off();
    this.watching.clear();
  }

  private async incoming(cfg: BridgeConfig, m: Incoming): Promise<void> {
    const st = this.status[m.platform];
    const known = this.threads.find((t) => t.platform === m.platform && t.channel === m.channel && t.thread === m.thread);
    const heard = cfg.users.includes(m.user) && (!cfg.channels.length || cfg.channels.includes(m.channel)) && (m.mentioned || Boolean(known));
    if (!heard || !m.text.trim()) { if (st) st.ignored++; return; }
    if (st) st.heard++;
    let ref = known;
    if (!ref) {
      const infos = listProjects();
      const info = cfg.project ? infos.find((p) => p.name === cfg.project || p.id === cfg.project) : infos.length === 1 ? infos[0] : undefined;
      if (!info) {
        await this.clients.get(m.platform)?.post(m.channel, m.thread, cfg.project ? `Loom has no project "${cfg.project}".` : "Loom has several projects — set one for this bridge: loom bridge " + m.platform + " --project <name>");
        return;
      }
      const rt = await this.runtime(info.id);
      const chat = rt.createChat(`${m.platform === "slack" ? "Slack" : "Discord"} · ${m.userName ?? m.user}: ${m.text.slice(0, 40)}`, cfg.agent ? { agentId: cfg.agent } : {}).id;
      ref = { platform: m.platform, channel: m.channel, thread: m.thread, projectId: info.id, chat };
      this.threads.push(ref);
      writeThreads(this.threads);
    }
    await this.watch(ref);
    const rt = await this.runtime(ref.projectId);
    const agentId = cfg.agent ?? rt.baton.holder() ?? rt.config.agents.find((a) => a.enabled !== false)?.id;
    if (!agentId) { await this.clients.get(m.platform)?.post(m.channel, m.thread, "This Loom project has no agents."); return; }
    rt.enqueue({ text: `${m.text.trim()}\n\n(from ${m.userName ?? m.user} on ${m.platform === "slack" ? "Slack" : "Discord"})`, chat: ref.chat, source: "user", target: { kind: "agent", agentId } });
  }

  /** Follow a bridged chat: gather the agent's text, post it when the turn ends; say when it waits on someone. */
  private async watch(ref: ThreadRef): Promise<void> {
    const key = `${ref.projectId}:${ref.chat}`;
    if (this.watching.has(key)) return;
    const rt = await this.runtime(ref.projectId);
    const post = (text: string) => {
      const client = this.clients.get(ref.platform);
      if (!client) return;
      const max = ref.platform === "slack" ? 3800 : 1900;
      void (async () => { for (const part of chunk(text, max)) await client.post(ref.channel, ref.thread, part); })()
        .catch((e) => logbook.warn("bridge", `${ref.platform} reply failed`, String(e)));
    };
    const off = rt.log.onEvent((e: LoomEvent) => {
      if ((e as { chat?: string }).chat !== ref.chat) return;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.kind === "message" && e.agentId && typeof p.text === "string" && !p.reasoning) {
        this.pending.set(key, [...(this.pending.get(key) ?? []), p.text]);
      } else if (e.kind === "run_complete" && e.agentId) {
        const parts = this.pending.get(key) ?? [];
        this.pending.delete(key);
        const err = typeof p.error === "string" ? p.error : "";
        if (parts.length) post(parts.join("\n\n"));
        else if (err) post(`${e.agentId} stopped: ${err}`);
      } else if (e.kind === "needs_input" && typeof p.question === "string") {
        post(`${e.agentId ?? "The agent"} asks: ${p.question}`);
      } else if (e.kind === "approval" && p.phase === "requested") {
        post(`⏸ ${e.agentId ?? "The agent"} is waiting for approval to use ${String(p.tool ?? "a tool")} — approve it in Loom or on your phone.`);
      }
    });
    this.watching.set(key, off);
  }
}

// ---------------------------------------------------------------------------
// Slack (Socket Mode)
// ---------------------------------------------------------------------------

class SlackClient implements PlatformClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private botUser = "";
  private retry = 1_000;

  constructor(private api: string, private cfg: BridgeConfig, private on: (m: Incoming) => void, private state: (ok: boolean, err?: string) => void) {}

  private async call(method: string, token: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.api}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!out.ok) throw new Error(`slack ${method}: ${String(out.error ?? res.status)}`);
    return out;
  }

  async start(): Promise<void> {
    if (!this.cfg.appToken) throw new Error("Slack needs an app-level token (xapp-…) for Socket Mode");
    this.botUser = String((await this.call("auth.test", this.cfg.botToken)).user_id ?? "");
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { url } = (await this.call("apps.connections.open", this.cfg.appToken!)) as { url: string };
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => { this.retry = 1_000; this.state(true); });
    ws.on("message", (data) => {
      let env: { envelope_id?: string; type?: string; payload?: { event?: Record<string, unknown> } };
      try { env = JSON.parse(String(data)); } catch { return; }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === "disconnect") { ws.close(); return; }
      if (env.type !== "events_api") return;
      const ev = env.payload?.event ?? {};
      if (ev.bot_id || ev.subtype || typeof ev.text !== "string" || typeof ev.user !== "string") return;
      const mentioned = ev.type === "app_mention" || ev.channel_type === "im";
      if (ev.type !== "app_mention" && ev.type !== "message") return;
      // an app_mention also arrives as a message event: take the mention, drop its twin
      if (ev.type === "message" && this.botUser && ev.text.includes(`<@${this.botUser}>`)) return;
      this.on({
        platform: "slack", channel: String(ev.channel), thread: String(ev.thread_ts ?? ev.ts), user: ev.user,
        text: ev.text.replace(new RegExp(`<@${this.botUser}>`, "g"), "").trim(), mentioned,
      });
    });
    ws.on("close", () => {
      this.state(false);
      if (this.stopped) return;
      const wait = this.retry;
      this.retry = Math.min(this.retry * 2, 60_000);
      setTimeout(() => void this.connect().catch((e) => this.state(false, (e as Error).message)), wait).unref?.();
    });
    ws.on("error", (e) => this.state(false, e.message));
  }

  async post(channel: string, thread: string, text: string): Promise<void> {
    await this.call("chat.postMessage", this.cfg.botToken, { channel, thread_ts: thread, text });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// Discord (gateway)
// ---------------------------------------------------------------------------

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const DISCORD_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

class DiscordClient implements PlatformClient {
  private ws: WebSocket | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private me = "";
  private stopped = false;
  private retry = 1_000;

  constructor(private api: string, private cfg: BridgeConfig, private on: (m: Incoming) => void, private state: (ok: boolean, err?: string) => void) {}

  private async rest(method: string, route: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.api}${route}`, { method, headers: { authorization: `Bot ${this.cfg.botToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`discord ${route}: ${String(out.message ?? res.status)}`);
    return out;
  }

  async start(): Promise<void> {
    const { url } = (await this.rest("GET", "/gateway/bot")) as { url: string };
    this.connect(url);
  }

  private connect(url: string): void {
    const ws = new WebSocket(`${url}?v=10&encoding=json`);
    this.ws = ws;
    ws.on("message", (data) => {
      let m: { op: number; d?: Record<string, unknown> & { heartbeat_interval?: number }; s?: number | null; t?: string };
      try { m = JSON.parse(String(data)); } catch { return; }
      if (typeof m.s === "number") this.seq = m.s;
      if (m.op === 10) {
        if (this.beat) clearInterval(this.beat);
        this.beat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op: 1, d: this.seq })), m.d?.heartbeat_interval ?? 41_250);
        this.beat.unref?.();
        ws.send(JSON.stringify({ op: 2, d: { token: this.cfg.botToken, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "loom", device: "loom" } } }));
        return;
      }
      if (m.op === 7 || m.op === 9) { ws.close(); return; } // reconnect / invalid session
      if (m.op !== 0) return;
      if (m.t === "READY") { this.me = String((m.d?.user as { id?: string } | undefined)?.id ?? ""); this.retry = 1_000; this.state(true); return; }
      if (m.t !== "MESSAGE_CREATE") return;
      const d = m.d as { id: string; channel_id: string; guild_id?: string; content?: string; author?: { id: string; username?: string; bot?: boolean }; mentions?: Array<{ id: string }> };
      if (!d.author || d.author.bot || typeof d.content !== "string") return;
      const mentioned = !d.guild_id || Boolean(d.mentions?.some((u) => u.id === this.me));
      this.on({
        platform: "discord", channel: d.channel_id, thread: d.channel_id, user: d.author.id, ...(d.author.username ? { userName: d.author.username } : {}),
        text: d.content.replace(new RegExp(`<@!?${this.me}>`, "g"), "").trim(), mentioned,
      });
    });
    ws.on("close", () => {
      if (this.beat) clearInterval(this.beat);
      this.state(false);
      if (this.stopped) return;
      const wait = this.retry;
      this.retry = Math.min(this.retry * 2, 60_000);
      setTimeout(() => void this.start().catch((e) => this.state(false, (e as Error).message)), wait).unref?.();
    });
    ws.on("error", (e) => this.state(false, e.message));
  }

  async post(channel: string, _thread: string, text: string): Promise<void> {
    await this.rest("POST", `/channels/${channel}/messages`, { content: text, allowed_mentions: { parse: [] } });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.beat) clearInterval(this.beat);
    this.ws?.close();
  }
}
