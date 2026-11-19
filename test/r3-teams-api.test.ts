import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orchestraSharePage } from "../src/core/share-page.js";
import { requestApproval } from "../src/core/approvals.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { createShare, openShare } from "../src/core/shares.js";
import { auditCsv, mentionLogins } from "../src/core/team-sharing.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, admin: string, pid: string, other: string, phone: string, scoped: string, scopedId: string, guest: string, teamId: string;
let hub: Awaited<ReturnType<typeof startHubServer>>, bob: TeamLink;
const notices: string[] = [], sockets: WebSocket[] = [];
const call = (token: string, method: string, route: string, body?: unknown) => fetch(base + route, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const project = (route: string) => `/api/projects/${pid}${route}`;
async function pair(body: object, name: string) {
  const made = await (await call(admin, "POST", "/api/pair/new", body)).json();
  const r = await call(admin, "POST", "/api/pair/claim", { token: made.token, name });
  expect(r.status).toBe(200); return r.json();
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-api"); process.env.LOOM_NO_NOTIFY = "1"; process.env.LOOM_NO_PUSH = "1";
  hub = await startHubServer({ host: "127.0.0.1", port: 0, secret: "r3" });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const cfg = readDaemonConfig()!; client = new DaemonClient(cfg); base = client.baseUrl; admin = cfg.adminToken;
  const dir = makeProjectDir({ name: "r3 teams" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "seed");
  git("remote", "add", "origin", "https://github.com/acme/r3.git");
  pid = (await client.addProject(dir)).project.id;
  other = (await client.addProject(makeProjectDir())).project.id;
  phone = (await pair({}, "Owner phone")).clientToken;
  const s = await pair({ projects: [pid] }, "Reviewer"); scoped = s.clientToken; scopedId = s.clientId;
  guest = (await pair({ guest: { project: pid, chat: "main", name: "Visitor", role: "view" } }, "Visitor")).clientToken;
  await daemon.team.signIn(hub.url, { github: "alice", secret: "r3" });
  teamId = (await daemon.team.createTeam("r3")).id;
  expect((await call(admin, "POST", project("/team/share"), { teamId })).status).toBe(200);
  bob = new TeamLink({ statePath: path.join(tmpDir("r3-bob"), "team.json"), runtimes: () => [], broadcast: () => {}, mention: from => notices.push(from) });
  await bob.join((await daemon.team.invite(teamId)).link, { github: "bob", secret: "r3" });
}, 60_000);
afterAll(async () => { sockets.forEach(s => s.terminate()); await bob?.stop(); await daemon?.close(); await hub?.close(); });

describe("#424 sharing and access", () => {
  it("creates each expiry preset for scoped project clients, expires and revokes", async () => {
    for (const [preset, hours] of [["1h", 1], ["1d", 24], ["7d", 168]] as const) {
      const start = Date.now();
      const res = await call(scoped, "POST", project("/chats/main/share"), { preset }); expect(res.status).toBe(200);
      const link = await res.json(); expect(link.expiresAt - start).toBeGreaterThanOrEqual(hours * 3600000); expect(link.expiresAt - Date.now()).toBeLessThanOrEqual(hours * 3600000);
      const page = await fetch(link.url); expect(page.status).toBe(200); expect(await page.text()).toContain('id="share-expiry"');
      expect(page.headers.get("cache-control")).toBe("no-store"); expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
      expect((await call(scoped, "DELETE", project(`/shares/${link.id}`))).status).toBe(200); expect((await fetch(link.url)).status).toBe(404);
    }
    for (const body of [{ preset: "forever" }, { hours: "oops" }, { hours: -1 }]) expect((await call(phone, "POST", project("/chats/main/share"), body)).status).toBe(400);
    const created = createShare({ projectId: pid, chat: "main", title: "expiry", hours: 1 }, 1000);
    expect(openShare(created.token, 3600999)).not.toBeNull(); expect(openShare(created.token, 3601000)).toBeNull();
    expect((await call(scoped, "POST", `/api/projects/${other}/chats/main/share`, {})).status).toBe(403);
    expect((await call(guest, "GET", project("/shares"))).status).toBe(403);
  });

  it("shares only the selected Orchestra run and never gives its reader API access", async () => {
    const result = await call(phone, "POST", project("/orchestra"), { goal: "<script>private-run</script>", orchestrator: "plannerbot", workers: ["execbot"] });
    expect(result.status).toBe(200); const { run } = await result.json();
    const rendered = orchestraSharePage({ ...run, dir: "/private/secret-directory", workerDetails: [{ id: "execbot", kind: "echo", configDir: "/private/secret-config" }],
      summary: "finished <safely>", tasks: [{ id: "t1", title: "Task", agent: "execbot", status: "done", result: "result <script>", dir: "/private/task-directory" }] }, "test");
    expect(rendered).toContain("finished &lt;safely&gt;"); expect(rendered).toContain("result &lt;script&gt;");
    expect(rendered).not.toContain("/private/");
    const link = await client.shareRun(pid, run.id, "1h");
    const page = await (await fetch(link.url)).text();
    expect(page).toContain("Read-only Orchestra run"); expect(page).toContain("&lt;script&gt;private-run&lt;/script&gt;");
    expect(page).not.toContain("configDir"); expect(page).not.toContain("reportToken");
    const shareToken = link.url.split("/").at(-1)!;
    expect((await call(shareToken, "POST", project(`/orchestra/${run.id}/abort`), {})).status).toBe(401);
    expect((await call(guest, "POST", project(`/orchestra/${run.id}/share`), {})).status).toBe(403);
    await call(phone, "POST", project(`/orchestra/${run.id}/abort`), {});
    expect((await call(phone, "POST", project("/orchestra/missing/share"), {})).status).toBe(404);
  });

  it("enforces project approval roles while retaining owner-phone access and attribution", async () => {
    const request = () => requestApproval({ project: pid, agent: "execbot", tool: "Bash", input: { command: "echo test" } });
    const pending = request(); let approvalId = "";
    await waitUntil(async () => { const r = await (await call(phone, "GET", project("/approvals"))).json(); approvalId = r.approvals[0]?.id; return !!approvalId; });
    expect((await call(phone, "PUT", project("/approval-roles"), { mode: "selected", approvers: [] })).status).toBe(200);
    expect((await call(scoped, "POST", project(`/approvals/${approvalId}`), { decision: "allow" })).status).toBe(403);
    expect((await call(scoped, "PUT", project("/approval-roles"), { mode: "everyone", approvers: [] })).status).toBe(403);
    expect((await call(phone, "POST", project(`/approvals/${approvalId}`), { decision: "allow" })).status).toBe(200);
    expect(await pending).toMatchObject({ behavior: "allow" });
    expect((await client.auditCsv()).csv).toContain("Owner phone");
    await call(phone, "PUT", project("/approval-roles"), { mode: "selected", approvers: [scopedId] });
    const next = request();
    await waitUntil(async () => { const r = await (await call(scoped, "GET", project("/approvals"))).json(); approvalId = r.approvals[0]?.id; return !!approvalId; });
    expect((await call(scoped, "POST", project(`/approvals/${approvalId}`), { decision: "deny" })).status).toBe(200);
    expect(await next).toMatchObject({ behavior: "deny" });
    expect((await call(scoped, "GET", project("/approval-roles"))).status).toBe(200);
    expect((await call(guest, "GET", project("/approval-roles"))).status).toBe(403);
    expect((await call(phone, "PUT", project("/approval-roles"), { mode: "invalid", approvers: [] })).status).toBe(400);
  });

  it("exports CSV with quoting and formula protection, including owner phones", async () => {
    const res = await call(phone, "GET", "/api/audit.csv?since=0"); expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv"); expect(res.headers.get("content-disposition")).toContain("loom-audit.csv");
    expect(await res.text()).toContain('"who"');
    const csv = auditCsv([{ at: 0, project: "id", projectName: "a,b", what: 'a "quote"\nand a newline', who: "=HYPERLINK(1)", detail: " @SUM(1)" }]);
    expect(csv).toContain('"a,b"'); expect(csv).toContain('"a ""quote""\nand a newline"'); expect(csv).toContain("'=HYPERLINK"); expect(csv).toContain("' @SUM");
    for (const token of [scoped, guest]) expect((await call(token, "GET", "/api/audit.csv")).status).toBe(403);
    expect((await call(phone, "GET", "/api/audit.csv?since=nope")).status).toBe(400);
  });

  it("rolls chat viewers into the project list, removes disconnected viewers and respects scopes", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + `/ws?project=${pid}`, [`loom.bearer.${phone}`]); sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "presence", chat: "main" }));
    const people = async () => ((await (await call(scoped, "GET", "/api/projects")).json()).projects as Array<{ id: string; presence: Array<{ name: string }> }>);
    await waitUntil(async () => (await people()).find(p => p.id === pid)?.presence.some(p => p.name === "Owner phone") ?? false);
    expect((await people()).map(p => p.id)).toEqual([pid]);
    ws.close(); await waitUntil(async () => !(await people()).find(p => p.id === pid)?.presence.length);
  });
});

describe("#424 team transport", () => {
  it("sends one encrypted notification per teammate mentioned in a real chat", async () => {
    expect(mentionLogins("mail@bob.com @Bob @bob (@alice) @unknown")).toEqual(["bob", "alice", "unknown"]);
    const suggestions = await (await call(scoped, "GET", project("/teammates"))).json();
    expect(suggestions.teammates).toEqual([expect.objectContaining({ github: "bob" })]);
    expect((await call(guest, "GET", project("/teammates"))).status).toBe(403);
    const res = await call(phone, "POST", project("/messages"), { text: "@Bob please review <private> @bob and @unknown", agentId: "execbot" }); expect(res.status).toBe(200);
    await waitUntil(() => notices.length === 1); expect(notices).toEqual(["alice"]);
    const status = bob.status() as { teams: Array<{ feed: Array<{ type: string; meta: { to: string }; content: { text: string } }> }> };
    const mentions = status.teams[0]!.feed.filter(f => f.type === "mention"); expect(mentions).toHaveLength(1); expect(mentions[0]!.content.text).toContain("<private>");
    const raw = await hub.hub.client(hub.hub.signIn("alice").token).feed(teamId);
    expect(JSON.stringify(raw)).not.toContain("<private>");
  });

  it("shares fleets across members and only lets an author or team owner replace them", async () => {
    expect((await call(phone, "PUT", "/api/team/fleets", { teamId, name: "test", spec: "echo@private-modelx2" })).status).toBe(200);
    expect(await bob.sharedFleets(teamId)).toEqual([expect.objectContaining({ name: "test", spec: "echo@private-modelx2" })]);
    await expect(bob.shareFleet(teamId, "test", "echo")).rejects.toThrow(/author/);
    const raw = await hub.hub.client(hub.hub.signIn("alice").token).teamFleets(teamId); expect(JSON.stringify(raw)).not.toContain("private-model");
    expect((await call(phone, "PUT", "/api/team/fleets", { teamId, name: "bad", spec: "@recursive" })).status).toBe(400);
    for (const token of [scoped, guest]) expect((await call(token, "PUT", "/api/team/fleets", { teamId, name: "bad", spec: "echo" })).status).toBe(403);
    await daemon.team.rotate(teamId);
    const newcomer = new TeamLink({ statePath: path.join(tmpDir("r3-fleet-newcomer"), "team.json"), runtimes: () => [], broadcast: () => {} });
    try {
      await newcomer.join((await daemon.team.invite(teamId)).link, { github: "fleet-reader", secret: "r3" });
      expect(await newcomer.sharedFleets(teamId)).toEqual([expect.objectContaining({ name: "test", spec: "echo@private-modelx2" })]);
    } finally { await newcomer.stop(); }
    expect((await call(phone, "DELETE", `/api/team/fleets/test?teamId=${teamId}`)).status).toBe(200);
    expect(await bob.sharedFleets(teamId)).toEqual([]);
  });

  it("includes remote teammate presence in project summaries and drops it on departure", async () => {
    const raw = hub.hub.client(hub.hub.signIn("bob").token);
    const deviceId = String(bob.status().device);
    const presence = { deviceId, repo: "acme/r3", agent: "echo", kind: "echo", touches: [], state: "running" as const, since: Date.now() };
    await raw.heartbeat(teamId, presence);
    const names = async () => (await (await call(scoped, "GET", "/api/projects")).json()).projects[0].presence.map((p: { name: string }) => p.name);
    await waitUntil(async () => (await names()).includes("bob"));
    await raw.clearPresence(teamId, { deviceId, repo: presence.repo, agent: presence.agent });
    await waitUntil(async () => !(await names()).includes("bob"));
  });

  it("lists and revokes unused invites over HTTP; copied links become unusable", async () => {
    const r = await call(phone, "POST", "/api/team/invite", { teamId }); expect(r.status).toBe(200);
    const made = await r.json();
    const list = await (await call(phone, "GET", `/api/team/invites?teamId=${teamId}`)).json(); expect(list.invites.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(made.result.link);
    const id = list.invites.at(-1).id;
    expect((await (await call(phone, "DELETE", `/api/team/invites/${id}?teamId=${teamId}`)).json()).revoked).toBe(true);
    const charlie = new TeamLink({ statePath: path.join(tmpDir("r3-charlie"), "team.json"), runtimes: () => [], broadcast: () => {} });
    try { await expect(charlie.join(made.result.link, { github: "charlie", secret: "r3" })).rejects.toThrow(/invalid|expired/); } finally { await charlie.stop(); }
    for (const token of [scoped, guest]) expect((await call(token, "DELETE", `/api/team/invites/${id}?teamId=${teamId}`)).status).toBe(403);
  });
});
