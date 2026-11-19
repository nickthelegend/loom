import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { sendMail, type SmtpSettings } from "../src/core/smtp.js";
import { readEmail, saveEmail, EmailDigest } from "../src/daemon/email-digest.js";
import { DiscordRuns } from "../src/daemon/discord-runs.js";
import { writeBridges } from "../src/daemon/chat-bridge.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, rt: ProjectRuntime, id: string, local: string, sock: WebSocket;
let discordFail = false;
const posts: Array<{ path: string; body: any }> = [], acks: any[] = [];
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", d => raw += String(d)); req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {}; posts.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (discordFail && req.url === "/channels/thread-1/messages") { res.statusCode = 503; return res.end("{}"); }
    if (req.url === "/auth.test") return res.end(JSON.stringify({ ok: true, user_id: "BOT" }));
    if (req.url === "/apps.connections.open") return res.end(JSON.stringify({ ok: true, url: local.replace("http:", "ws:") }));
    if (req.url === "/chat.postMessage") return res.end(JSON.stringify({ ok: true, ts: String(posts.length) }));
    if (req.url?.endsWith("/threads")) return res.end(JSON.stringify({ id: "thread-1" }));
    return res.end(JSON.stringify({ ok: true, id: String(posts.length) }));
  });
});
const wss = new WebSocketServer({ server });
wss.on("connection", ws => { sock = ws; ws.on("message", data => acks.push(JSON.parse(String(data)))); });
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-delivery"); process.env.LOOM_NO_NOTIFY = "1";
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.LOOM_SLACK_API = local; process.env.LOOM_DISCORD_API = local;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!);
  const dir = makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "executor" }] });
  execFileSync("git", ["init", "-q"], { cwd: dir }); fs.writeFileSync(path.join(dir, "file.txt"), "seed");
  execFileSync("git", ["add", "file.txt"], { cwd: dir }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd: dir });
  id = (await client.addProject(dir)).project.id; rt = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
  await client.setBridge("slack", { enabled: true, botToken: "bot", appToken: "app", users: ["U1"], channels: ["C1"], project: id, agent: "echo" });
  await waitUntil(() => Boolean(sock));
});
afterAll(async () => { await daemon.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise<void>(r => server.close(() => r())); delete process.env.LOOM_SLACK_API; delete process.env.LOOM_DISCORD_API; });

it("Slack Socket Mode acknowledges promptly, starts an echo Orchestra goal, deduplicates and refuses strangers", async () => {
  const command = (envelope: string, user = "U1", channel = "C1", text = "Implement a tiny change") => sock.send(JSON.stringify({ type: "slash_commands", envelope_id: envelope, payload: { command: "/loom", user_id: user, channel_id: channel, text } }));
  command("denied", "outsider"); command("wrong-channel", "U1", "C2"); command("empty", "U1", "C1", "");
  await waitUntil(() => acks.length >= 3);
  expect(acks[0].payload.text).toContain("not allowed"); expect(acks[2].payload.text).toContain("Usage");
  expect(rt.orchestra.list()).toHaveLength(0);
  command("goal"); command("goal");
  await waitUntil(() => rt.orchestra.list().length === 1);
  expect(rt.orchestra.list()[0]!.goal).toContain("Implement a tiny change");
  expect(acks.filter(a => a.envelope_id === "goal")).toHaveLength(2);
  await waitUntil(() => rt.orchestra.list()[0]!.status === "waiting_human");
  await rt.orchestra.abort(rt.orchestra.list()[0]!.id);
});

it("Discord persists one thread per run and orders progress through restarts without mentions", async () => {
  writeBridges({ discord: { enabled: true, botToken: "discord-token", users: ["1"], channels: [], project: id, orchestraChannel: "123" } });
  const first = new DiscordRuns(local);
  const event = (n: number, phase: string) => ({ id: n, ts: Date.now(), kind: "orchestra" as const, payload: { runId: "run-test", phase, goal: "@everyone goal", summary: "progress" } });
  await Promise.all([first.deliver(id, event(10001, "started")), first.deliver(id, { ...event(10002, "task_completed"), payload: { ...event(10002, "task_completed").payload, task: { title: "Build UI", status: "done" } } })]);
  const restart = new DiscordRuns(local);
  await restart.deliver(id, event(10002, "task_completed")); await restart.deliver(id, event(10003, "completed"));
  const threads = posts.filter(p => p.path.endsWith("/threads")); expect(threads).toHaveLength(1);
  const updates = posts.filter(p => p.path === "/channels/thread-1/messages");
  expect(updates.map(p => p.body.content.split(" · ")[0])).toEqual(["started", "task_completed", "completed"]);
  expect(updates.every(p => p.body.allowed_mentions.parse.length === 0)).toBe(true);
  expect(updates[1]!.body.content).toContain("Build UI · done");
  discordFail = true; await expect(restart.deliver(id, event(10004, "aborted"))).rejects.toThrow("503");
  discordFail = false;
  const recovered = new DiscordRuns(local); await recovered.retryPending(); await recovered.close();
  expect(posts.filter(p => p.path.endsWith("/threads"))).toHaveLength(1);
  expect(posts.filter(p => p.path === "/channels/thread-1/messages").at(-1)!.body.content).toContain("aborted");
  writeBridges({}); await restart.deliver(id, event(10005, "aborted"));
  expect(posts.filter(p => p.path === "/channels/thread-1/messages")).toHaveLength(5);
  await first.close(); await restart.close();
  await restart.deliver(id, event(10006, "completed"));
});

it("delivers an SMTP digest over verified TLS, handles multiline replies, and advances the cursor only on success", async () => {
  const certDir = tmpDir("r3-smtp"), certPath = path.join(certDir, "cert.pem"), keyPath = path.join(certDir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const ca = fs.readFileSync(certPath, "utf8"), key = fs.readFileSync(keyPath, "utf8");
  const messages: string[] = [], commands: string[] = []; let refuse = false;
  const smtp = tls.createServer({ key, cert: ca }, socket => {
    socket.write("220 test ready\r\n"); let input = "", message = "", inData = false;
    socket.on("error", () => {});
    socket.on("data", data => {
      input += data.toString(); let end: number;
      while ((end = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 2);
        if (inData) { if (line === ".") { messages.push(message); inData = false; socket.write("250 accepted\r\n"); } else message += line + "\r\n"; continue; }
        commands.push(line);
        if (line.startsWith("EHLO")) { socket.write("250-test\r\n250-AUTH PLAIN\r\n"); setTimeout(() => socket.write("250 OK\r\n"), 5); }
        else if (line.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL")) socket.write(refuse ? "550 refused\r\n" : "250 OK\r\n");
        else if (line.startsWith("RCPT")) socket.write("250 OK\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  await new Promise<void>(r => smtp.listen(0, "127.0.0.1", r));
  const cfg: SmtpSettings = { enabled: true, host: "127.0.0.1", port: (smtp.address() as { port: number }).port, security: "tls", username: "owner", password: "secret", from: "owner@example.com", to: "recipient@example.com", everyHours: 24 };
  const email = new EmailDigest(async () => rt, (c, s, t) => sendMail(c, s, t, { ca }));
  try {
    saveEmail({ ...cfg }); rt.log.append({ kind: "error", payload: { message: "Digest fixture é" } });
    await email.tick(true); expect(messages).toHaveLength(1);
    const decoded = Buffer.from(messages[0]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(decoded).toContain("Digest fixture é");
    expect(commands.some(c => c === "AUTH PLAIN " + Buffer.from("\0owner\0secret").toString("base64"))).toBe(true);
    const cursor = readEmail().lastSentAt; expect(cursor).toBeGreaterThan(0);
    await email.tick(); expect(messages).toHaveLength(1);
    refuse = true; await expect(email.tick(true)).rejects.toThrow("550"); expect(readEmail().lastSentAt).toBe(cursor);
    await expect(sendMail(cfg, "test", "test")).rejects.toThrow();
    let authenticatedAfterUpgrade = false;
    const starttls = net.createServer(socket => {
      socket.write("220 ready\r\n");
      const listen = (conn: net.Socket, encrypted: boolean) => {
        let buffered = "", dataMode = false;
        const receive = (data: Buffer) => {
          buffered += data.toString(); let end: number;
          while ((end = buffered.indexOf("\r\n")) >= 0) {
            const line = buffered.slice(0, end); buffered = buffered.slice(end + 2);
            if (dataMode) { if (line === ".") { dataMode = false; conn.write("250 accepted\r\n"); } continue; }
            if (line.startsWith("EHLO")) conn.write("250-test\r\n250 STARTTLS\r\n");
            else if (line === "STARTTLS") {
              conn.write("220 upgrade\r\n"); conn.removeListener("data", receive);
              const secure = new tls.TLSSocket(conn, { isServer: true, secureContext: tls.createSecureContext({ key, cert: ca }) });
              secure.on("error", () => {}); listen(secure, true); return;
            } else if (line.startsWith("AUTH")) { authenticatedAfterUpgrade = encrypted; conn.write("235 authenticated\r\n"); }
            else if (line === "DATA") { dataMode = true; conn.write("354 send\r\n"); }
            else if (line === "QUIT") conn.end("221 bye\r\n");
            else conn.write("250 OK\r\n");
          }
        };
        conn.on("data", receive); conn.on("error", () => {});
      };
      listen(socket, false);
    });
    await new Promise<void>(r => starttls.listen(0, "127.0.0.1", r));
    try {
      await sendMail({ ...cfg, security: "starttls", port: (starttls.address() as { port: number }).port }, "STARTTLS", "body", { ca });
      expect(authenticatedAfterUpgrade).toBe(true);
    } finally { await new Promise<void>(r => starttls.close(() => r())); }
  } finally { await email.close(); saveEmail({ enabled: false }); await new Promise<void>(r => smtp.close(() => r())); }
});
