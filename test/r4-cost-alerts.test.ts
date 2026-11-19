import http from "node:http";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { writeDaemonConfig, writeProjectState } from "../src/core/registry.js";
import { writeBridges } from "../src/daemon/chat-bridge.js";
import { saveEmail } from "../src/daemon/email-digest.js";
import { sendMail } from "../src/core/smtp.js";
import { deliverSpendAlert } from "../src/core/cost-r4/alerts.js";
import { budgetNotices } from "../src/core/cost-r4/budgets.js";
import { updateCostSettings } from "../src/core/cost-r4/settings.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

beforeEach(() => { process.env.LOOM_HOME = tmpDir("r4-alerts-home"); process.env.LOOM_NO_PRICE_FETCH = "1"; });
async function host() { const dir = makeProjectDir(); return { info: { id: "project", name: "Cost project", dir }, log: await EventLog.open(path.join(dir, ".loom")) }; }

it("sends agent warnings and daily-model pauses to Slack and only phones allowed to see the project", async () => {
  const h = await host(), posts: Array<{ path: string; body: any }> = [];
  const server = http.createServer((req, res) => { let text = ""; req.on("data", b => { text += b; }); req.on("end", () => { posts.push({ path: req.url!, body: JSON.parse(text) }); res.setHeader("content-type", "application/json"); res.end('{"ok":true,"data":[]}'); }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.LOOM_SLACK_API = url; process.env.LOOM_EXPO_PUSH_URL = url + "/push"; delete process.env.LOOM_NO_PUSH;
  try {
    const device = (id: string) => ({ id, name: id, token: id, createdAt: 1, pushToken: `ExponentPushToken[${id}]` });
    writeDaemonConfig({ host: "127.0.0.1", port: 0, adminToken: "test", clients: [device("owner"), { ...device("scoped"), projects: [h.info.id] }, { ...device("other"), projects: ["other"] }, { ...device("muted"), pushKinds: ["done"] }, { ...device("guest"), guest: { project: h.info.id, chat: "main", role: "view", name: "guest", expiresAt: Date.now() + 60000 } }] });
    writeBridges({ slack: { enabled: true, botToken: "fake", users: [], channels: ["budget-alerts"], project: h.info.id } });
    updateCostSettings(h.info.dir, { alerts: ["slack", "push"] });
    writeProjectState(h.info.dir, { budgets: { echo: 1 } });
    h.log.append({ kind: "run_complete", agentId: "echo", payload: { costUsd: 0.8 } }); budgetNotices(h);
    const warning = h.log.list({ kinds: ["status"] }).find(e => e.payload.scope === "agent")!;
    expect(warning.payload.stopped).toBe(false);
    const lists = vi.spyOn(h.log, "list");
    await deliverSpendAlert(h, warning); await deliverSpendAlert(h, warning);
    expect(lists).toHaveBeenCalledTimes(1);
    lists.mockRestore();
    expect(posts.filter(p => p.path === "/chat.postMessage")).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ channel: "budget-alerts", mrkdwn: false, text: expect.stringContaining("80%") });
    const pushed = posts.find(p => p.path === "/push")!.body;
    expect(pushed.map((p: { to: string }) => p.to).sort()).toEqual(["ExponentPushToken[owner]", "ExponentPushToken[scoped]"]);
    const stopped = h.log.append({ kind: "status", payload: { state: "model_cap_warning", stopped: true, text: "echo-a daily model cap reached" } });
    await deliverSpendAlert(h, stopped);
    expect(posts.filter(p => p.path === "/chat.postMessage")).toHaveLength(2);
    expect(posts.at(-1)?.body[0].body).toContain("daily model cap reached");
    updateCostSettings(h.info.dir, { alerts: [] });
    const off = h.log.append({ kind: "status", payload: { state: "budget_exceeded" } }); await deliverSpendAlert(h, off); expect(posts).toHaveLength(4);
  } finally { h.log.close(); delete process.env.LOOM_SLACK_API; delete process.env.LOOM_EXPO_PUSH_URL; await new Promise<void>(r => server.close(() => r())); }
});

it("delivers selected budget emails through SMTP with verified TLS and deduplicates successful delivery", async () => {
  const h = await host(), certDir = tmpDir("r4-smtp"), certPath = path.join(certDir, "cert.pem"), keyPath = path.join(certDir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const ca = fs.readFileSync(certPath, "utf8"), key = fs.readFileSync(keyPath, "utf8"), messages: string[] = [];
  const server = tls.createServer({ key, cert: ca }, socket => {
    socket.write("220 ready\r\n"); let input = "", message = "", inData = false;
    socket.on("error", () => {});
    socket.on("data", data => {
      input += data.toString(); let end: number;
      while ((end = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 2);
        if (inData) { if (line === ".") { messages.push(message); inData = false; socket.write("250 accepted\r\n"); } else message += line + "\r\n"; continue; }
        if (line.startsWith("EHLO")) socket.write("250-test\r\n250 OK\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 OK\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    saveEmail({ enabled: true, host: "127.0.0.1", port: (server.address() as { port: number }).port, security: "tls", username: "", password: "", from: "owner@example.com", to: "owner@example.com", everyHours: 24 });
    updateCostSettings(h.info.dir, { alerts: ["email"] });
    const event = h.log.append({ kind: "status", payload: { state: "cost_budget_notice", scope: "month", text: "Monthly budget paused; raise the cap" } });
    const mail: typeof sendMail = (cfg, subject, text) => sendMail(cfg, subject, text, { ca });
    await deliverSpendAlert(h, event, mail); await deliverSpendAlert(h, event, mail);
    expect(messages).toHaveLength(1);
    const decoded = Buffer.from(messages[0]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(decoded).toContain("Cost project: Monthly budget paused");
    expect(h.log.list({ kinds: ["status"] }).at(-1)?.payload.state).toBe("cost_alert_delivered");
  } finally { saveEmail({ enabled: false }); h.log.close(); await new Promise<void>(r => server.close(() => r())); }
});
