import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { setProvider } from "../src/core/providers.js";
import { readIntake, saveIntake } from "../src/core/intake.js";
import { readPrRecords, savePrRecord } from "../src/core/pr-feedback.js";
import { readTriggers } from "../src/core/triggers.js";
import { triggerCalendar } from "../src/core/integration-triggers.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { TriggerRunner } from "../src/daemon/triggers.js";
import { PrFeedback } from "../src/daemon/pr-feedback.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, rt: ProjectRuntime, id: string, dir: string, admin: string, phone: string, scoped: string;
let base: string, providerBase: string;
const requests: Array<{ path: string; body: any; auth?: string }> = [];
let jiraFail = false, merged = false, linearFail = false, linearUpdates = 0;
const mrUrl = "https://gitlab.com/group/sub/repo/-/merge_requests/7";
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", d => raw += String(d));
  req.on("end", () => {
    const b = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, body: b, auth: req.headers.authorization ?? req.headers["private-token"] as string });
    res.setHeader("content-type", "application/json");
    const json = (v: unknown) => res.end(JSON.stringify(v));
    if (req.url === "/rest/api/3/search/jql") {
      if (jiraFail) { res.statusCode = 401; return json({ error: "private-secret" }); }
      return json({ issues: [{ id: b.nextPageToken ? "2" : "1", key: b.nextPageToken ? "APP-2" : "APP-1", fields: { summary: "Fix refresh", description: { content: [{ content: [{ text: "Fix login" }] }] }, labels: ["ready"] } }], ...(b.nextPageToken ? { isLast: true } : { nextPageToken: "page2" }) });
    }
    if (req.url?.endsWith("/comment")) return json({ id: "comment" });
    if (req.url === "/linear") {
      if (b.query.includes("issueUpdate")) { linearUpdates++; if (linearFail) return json({ errors: [{ message: "failed" }] }); return json({ data: { issueUpdate: { success: true } } }); }
      return json({ data: { issue: { state: { type: "started" }, team: { states: { nodes: [{ id: "done-state", name: "Done", type: "completed" }] } } } } });
    }
    if (req.url?.includes("/members/all/")) return json({ access_level: req.url.endsWith("/1") ? 40 : 10 });
    if (req.url?.includes("/discussions")) {
      const page2 = req.url.includes("page=2");
      if (!page2) res.setHeader("x-next-page", "2");
      return json([{ notes: [{ id: page2 ? 12 : 11, body: page2 ? "Fix the inline case" : "Fix review", author: { id: 1, username: "maintainer" } }, { id: 13, body: "untrusted", author: { id: 2, username: "outsider" } }, { id: 14, body: "system", system: true, author: { id: 1 } }] }]);
    }
    if (req.url?.endsWith("/merge_requests/7")) return json({ state: merged ? "merged" : "opened", web_url: mrUrl, sha: "head-1", detailed_merge_status: "mergeable", head_pipeline: { status: "failed", web_url: "https://gitlab.com/pipeline/9" } });
    res.statusCode = 404; json({});
  });
});
async function api(method: string, path: string, body?: unknown, token = admin) {
  return fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const route = (p: string) => `/api/projects/${id}${p}`;
async function pair(projects?: string[]) {
  const p = await (await api("POST", "/api/pair/new", projects ? { projects } : {})).json();
  return (await (await api("POST", "/api/pair/claim", { token: p.token, name: "test phone" })).json()).clientToken as string;
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-integrations"); process.env.LOOM_NO_NOTIFY = "1";
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  providerBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.LOOM_TEST_LINEAR_URL = providerBase + "/linear";
  setProvider("jira", { key: "me@example.com:private-secret", baseUrl: providerBase });
  setProvider("linear", { key: "linear-secret" });
  setProvider("gitlab", { key: "gitlab-secret", baseUrl: providerBase });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); base = client.baseUrl; admin = readDaemonConfig()!.adminToken;
  dir = makeProjectDir(); id = (await client.addProject(dir)).project.id;
  rt = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
  phone = await pair(); scoped = await pair([id]);
});
afterAll(async () => { await daemon.close(); await new Promise<void>(r => server.close(() => r())); delete process.env.LOOM_TEST_LINEAR_URL; });

describe("#425 triggers", () => {
  it("starts a fresh echo chat for each trusted signed /loom comment, ignoring edits, outsiders, bots and replay", async () => {
    const made = await (await api("POST", route("/triggers"), { kind: "webhook", prompt: "unused", githubCommand: true })).json();
    expect(made.secret).toBeTruthy();
    const body = { action: "created", issue: { number: 42, html_url: "https://github.com/a/b/issues/42" }, comment: { id: 100, body: "/loom fix refresh", author_association: "MEMBER", user: { type: "User" } } };
    const deliver = async (b: unknown, signature = true) => {
      const raw = JSON.stringify(b);
      return fetch(base + made.path, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "issue_comment", "x-hub-signature-256": signature ? "sha256=" + crypto.createHmac("sha256", made.secret).update(raw).digest("hex") : "wrong" }, body: raw });
    };
    expect((await deliver(body, false)).status).toBe(401);
    for (const b of [{ ...body, action: "edited" }, { ...body, comment: { ...body.comment, author_association: "NONE" } }, { ...body, comment: { ...body.comment, user: { type: "Bot" } } }, { ...body, issue: { ...body.issue, pull_request: {} } }]) expect((await (await deliver(b)).json()).ok).toBe(false);
    expect((await (await deliver(body)).json()).ok).toBe(true);
    const chat = readTriggers(dir).triggers.find(t => t.id === made.trigger.id)!.chat!;
    await waitUntil(() => rt.log.list({ chat, kinds: ["message"], limit: 100 }).some(e => e.agentId && String(e.payload.text).includes("fix refresh")));
    const restartRunner = new TriggerRunner(async () => rt);
    expect((await restartRunner.fire(id, dir, made.trigger.id, { kind: "webhook", event: "issue_comment", body })).note).toContain("already delivered");
    body.comment.id++;
    expect((await (await deliver(body)).json()).ok).toBe(true);
    expect(readTriggers(dir).triggers.find(t => t.id === made.trigger.id)!.chat).not.toBe(chat);
  });
  it("previews real templates without queueing and exports an authenticated calendar", async () => {
    const before = rt.chats().length;
    const templates = await (await api("GET", route("/triggers/templates"), undefined, scoped)).json();
    expect(templates.templates).toHaveLength(3);
    const result = await (await api("POST", route("/triggers/preview"), { prompt: "{{body.title}} / {{body.__proto__}} / {{event}}", payload: { title: "<img onerror=bad> $&" }, event: "$&" }, scoped)).json();
    expect(result.prompt).toBe("<img onerror=bad> $& /  / $&");
    expect(rt.chats()).toHaveLength(before);
    await client.addTrigger(id, { kind: "schedule", every: "1h", name: "Morning, work;\nNext", prompt: "private prompt" });
    const r = await api("GET", route("/triggers/calendar"), undefined, scoped);
    expect(r.headers.get("content-type")).toContain("text/calendar");
    const ics = await r.text();
    expect(ics).toContain("BEGIN:VCALENDAR\r\n"); expect(ics).toContain("Morning\\, work\\;\\nNext"); expect(ics).not.toContain("private prompt");
    expect((await fetch(base + route("/triggers/calendar"))).status).toBe(401);
    const feed = await client.calendarLink(id);
    expect((await fetch(base + feed.path)).status).toBe(200);
    const rotated = await client.calendarLink(id, true);
    expect((await fetch(base + feed.path)).status).toBe(404);
    expect((await fetch(base + rotated.path)).headers.get("content-type")).toContain("text/calendar");
    await api("DELETE", route("/triggers/calendar-link"), undefined, phone);
    expect((await fetch(base + rotated.path)).status).toBe(404);
  });
  it("keeps forecast UIDs stable, folds UTF-8 and excludes disabled and webhook triggers", () => {
    const now = new Date(2026, 0, 1).getTime();
    const t = { id: "one", kind: "schedule" as const, name: "é".repeat(100), prompt: "", enabled: true, cron: "0 9 * * 1-5", createdAt: now };
    const a = triggerCalendar("p", [t, { ...t, id: "disabled", enabled: false }, { ...t, id: "hook", kind: "webhook" }], now);
    expect(a).toBe(triggerCalendar("p", [t], now));
    expect(a.split("\r\n").every(line => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(a.match(/BEGIN:VEVENT/g)).toHaveLength(100);
  });
});

describe("#425 issue intake and feedback", () => {
  it("paginates Jira assignments, queues chats idempotently and sends backlinks", async () => {
    rt.queue.setPaused(true);
    const { issues } = await client.intake(id, "jira", 'ready" OR x');
    expect(issues.map(i => i.identifier)).toEqual(["APP-1", "APP-2"]);
    const fetched = requests.filter(r => r.path === "/rest/api/3/search/jql");
    expect(fetched[0]!.body.jql).toContain('assignee = currentUser()');
    expect(fetched[0]!.auth).toBe("Basic " + Buffer.from("me@example.com:private-secret").toString("base64"));
    const input = { source: "jira" as const, ids: ["1"], mode: "chat" as const };
    const one = await client.startIntake(id, input), two = await client.startIntake(id, input);
    expect(one).toEqual(two);
    expect(rt.queue.snapshot().items.filter(i => i.chat === one.issues[0]!.started!.chat)).toHaveLength(1);
    const { recordIntakePr, flushIntakePrs } = await import("../src/core/intake.js");
    recordIntakePr(dir, one.issues[0]!.started!.chat!, mrUrl); await flushIntakePrs(dir);
    expect(requests.some(r => r.path === "/rest/api/3/issue/1/comment" && JSON.stringify(r.body).includes(mrUrl))).toBe(true);
    jiraFail = true; await expect(client.intake(id, "jira")).rejects.toThrow("Jira request failed"); jiraFail = false;
  });
  it("polls GitLab pipelines and paginated trusted reviews once, respecting feedback modes", async () => {
    const chat = rt.createChat("MR", { agentId: "plannerbot" }).id;
    await client.setPrFeedback(id, chat, "ci+reviews");
    const { pr } = await client.watchPr(id, chat, mrUrl);
    expect(pr).toMatchObject({ provider: "gitlab", repo: "gitlab.com/group/sub/repo", prNumber: 7 });
    await rt.prFeedback.pollNow(); await rt.prFeedback.pollNow();
    const queue = rt.queue.snapshot().items.filter(i => i.chat === chat);
    expect(queue).toHaveLength(3);
    expect(queue.some(i => i.text.includes("untrusted"))).toBe(false);
    expect(queue.some(i => i.text.includes("inline case"))).toBe(true);
    await client.setPrFeedback(id, chat, "off"); await rt.prFeedback.pollNow();
    expect(rt.queue.snapshot().items.filter(i => i.chat === chat)).toHaveLength(3);
    await expect(client.watchPr(id, "main", mrUrl)).rejects.toThrow("already belongs");
    expect(requests.some(r => r.path.includes("group%2Fsub%2Frepo") && r.auth === "gitlab-secret")).toBe(true);
    merged = true; await rt.prFeedback.pollNow();
    expect(readPrRecords(dir)[0]!.state).toBe("MERGED");
  });
  it("retries a failed Linear transition after merge and records completion only after success", async () => {
    saveIntake(dir, { source: "linear", id: "linear-1", title: "Linked", url: "https://linear.app/issue/1", labels: [], started: { chat: "main" }, prs: [{ url: mrUrl, sent: true }] });
    linearFail = true;
    const first = new PrFeedback(rt); await first.pollNow(); await first.stop();
    expect(readIntake(dir).find(r => r.id === "linear-1")!.completedAt).toBeUndefined();
    linearFail = false;
    const second = new PrFeedback(rt); await second.pollNow(); await second.pollNow(); await second.stop();
    expect(readIntake(dir).find(r => r.id === "linear-1")!.completedAt).toBeGreaterThan(0);
    expect(linearUpdates).toBe(2);
    expect(requests.find(r => r.path === "/linear" && r.body.query.includes("issueUpdate"))!.body.variables.input.stateId).toBe("done-state");
    // Closed without merging never completes its issue.
    saveIntake(dir, { source: "linear", id: "closed", title: "Closed", url: "", labels: [], started: { chat: "main" }, prs: [{ url: "https://github.com/a/b/pull/4", sent: true }] });
    savePrRecord(dir, { repo: "a/b", prNumber: 4, chat: "main", source: "delivery", state: "CLOSED", openedAt: Date.now(), url: "https://github.com/a/b/pull/4", signatures: [] });
    const third = new PrFeedback(rt); await third.pollNow(); await third.stop();
    expect(readIntake(dir).find(r => r.id === "closed")!.completedAt).toBeUndefined();
  });
});

describe("#425 machine settings", () => {
  it("allows owner phones, rejects scoped tokens, masks SMTP secrets and previews the actual digest", async () => {
    const settings = { enabled: true, host: "localhost", port: 465, security: "tls", username: "me", password: "mail-secret", from: "me@example.com", to: "you@example.com", everyHours: 24 };
    expect((await api("PUT", "/api/integrations/email", settings, scoped)).status).toBe(403);
    expect((await api("GET", "/api/integrations/email", undefined, scoped)).status).toBe(403);
    const saved = await (await api("PUT", "/api/integrations/email", settings, phone)).json();
    expect(saved.hasPassword).toBe(true); expect(saved.password).toBeUndefined();
    expect(fs.statSync(process.env.LOOM_HOME + "/email-digest.json").mode & 0o777).toBe(0o600);
    expect((await api("PUT", "/api/integrations/email", { to: "bad\r\nBcc:evil" }, phone)).status).toBe(400);
    rt.log.append({ kind: "error", chat: "main", payload: { message: "test failure" } });
    expect((await (await api("GET", "/api/integrations/email/preview", undefined, phone)).json()).text).toContain("test failure");
    expect((await api("GET", "/api/bridges", undefined, phone)).status).toBe(200);
    expect((await api("GET", "/api/bridges", undefined, scoped)).status).toBe(403);
    const share = await client.shareLive({ project: id, chat: "main", role: "view", name: "guest" });
    const packed = new URL(share.link).hash;
    const guestPair = new URLSearchParams(packed.slice(1)).get("pair");
    const guest = await (await api("POST", "/api/pair/claim", { token: guestPair, name: "guest" })).json();
    for (const path of ["/api/integrations/email", "/api/bridges", route("/triggers/templates"), route("/triggers/calendar")]) expect((await api("GET", path, undefined, guest.clientToken)).status).toBe(403);
    await api("PUT", "/api/integrations/email", { enabled: false });
    expect((await api("POST", "/api/integrations/email/send", {})).status).toBe(502);
  });
});
