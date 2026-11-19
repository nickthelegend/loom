import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { startHubServer } from "../src/hub/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, base: string, token: string, pid: string, runId: string, teamId: string;
let hub: Awaited<ReturnType<typeof startHubServer>>;
const mounted: Array<{ close(): void }> = [];
const call = async (method: string, route: string, body?: object) => {
  const r = await fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom"); process.env.LOOM_NO_NOTIFY = "1"; process.env.LOOM_NO_PUSH = "1";
  hub = await startHubServer({ host: "127.0.0.1", port: 0, secret: "r3" });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const client = new DaemonClient(readDaemonConfig()!); base = client.baseUrl; token = readDaemonConfig()!.adminToken;
  const dir = makeProjectDir({ name: "r3 browser" });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  git("remote", "add", "origin", "https://github.com/acme/dom.git"); pid = (await client.addProject(dir)).project.id;
  runId = (await call("POST", `/api/projects/${pid}/orchestra`, { goal: "Review <img src=x onerror=alert(1)>", orchestrator: "plannerbot", workers: ["execbot"] })).run.id;
  await daemon.team.signIn(hub.url, { github: "alice", secret: "r3" }); teamId = (await daemon.team.createTeam("Browser team")).id;
  await call("POST", `/api/projects/${pid}/team/share`, { teamId });
  await daemon.team.invite(teamId);
  const alice = hub.hub.client(hub.hub.signIn("alice").token);
  await hub.hub.client(hub.hub.signIn("bob").token).redeemInvite((await alice.createInvite(teamId)).invite);
  await hub.hub.client(hub.hub.signIn("alice").token).appendFeed(teamId, { type: "goal_started", repo: "acme/dom", meta: {} });
  await hub.hub.client(hub.hub.signIn("alice").token).appendFeed(teamId, { type: "pr_merged", repo: "acme/dom", meta: { number: 42 } });
}, 60_000);
afterEach(() => { mounted.splice(0).forEach(m => m.close()); });
afterAll(async () => { await daemon?.close(); await hub?.close(); });

// The same real-page/real-daemon harness as app-orchestra-dom, with only browser capabilities supplied.
function mount() {
  const errors: string[] = [], sockets: WebSocket[] = []; let closed = false;
  const never = new Promise<never>(() => {}), vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message));
  const downloads: Blob[] = [];
  const dom = new JSDOM(APP_HTML, { url: `${base}/app#p/${pid}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia;
      w.fetch = ((url: string, init?: RequestInit) => closed ? never : fetch(new URL(url, base), init).then(r => closed ? never : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1"); w.confirm = () => true;
      w.URL.createObjectURL = b => { downloads.push(b as Blob); return "blob:download"; }; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = () => {};
    } });
  const q = (s: string) => dom.window.document.querySelector(s) as HTMLElement | null;
  const click = async (s: string) => { await waitUntil(() => !!q(s)?.onclick, { timeoutMs: 60_000 }); q(s)!.click(); };
  // waits for the field: a dialog renders after its data arrives, which a loaded runner can take a while to do
  const fill = async (s: string, value: string) => { await waitUntil(() => !!q(s), { timeoutMs: 60_000 }); const e = q(s) as HTMLInputElement; e.value = value; e.dispatchEvent(new dom.window.Event("input", { bubbles: true })); e.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  // Another dialog (a platform-specific notice) may already be up; in a browser it would cover the page and be
  // closed first, but jsdom lets the click through and the sharing dialog then refuses to stack on it.
  const closeDialogs = () => dom.window.document.querySelectorAll(".scrim").forEach(e => e.remove());
  const m = { dom, errors, downloads, q, click, fill, closeDialogs, close() { closed = true; sockets.forEach(s => { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); }); dom.window.close(); } }; mounted.push(m); return m;
}

it("creates a selected run share, counts down, saves roles, downloads CSV and revokes in the web UI", async () => {
  const m = mount(); await m.click('.tab[data-tab="orchestra"]'); await waitUntil(() => !!m.q('[data-run]')); m.closeDialogs(); await m.click('#oshare');
  await m.fill('[data-expiry-preset]', '7d'); await m.click('[data-create-share]');
  await waitUntil(() => !!m.q('[aria-label="Read-only share link"]'));
  const link = (m.q('[aria-label="Read-only share link"]') as HTMLInputElement).value;
  expect(m.q('[data-share-result]')!.textContent).toMatch(/6d|7d/);
  const page = await (await fetch(link)).text(); expect(page).toContain("Read-only Orchestra run"); expect(page).toContain("&lt;img");
  expect(m.q('.scrim img')).toBeNull();
  await waitUntil(() => !!m.q('.scrim [data-mode]')); await m.fill('.scrim [data-mode]', 'selected'); await m.click('[data-save-roles]');
  await waitUntil(async () => (await call('GET', `/api/projects/${pid}/approval-roles`)).mode === 'selected');
  await m.click('[data-audit]'); await waitUntil(() => m.downloads.length === 1);
  await m.click('[data-revoke]'); await waitUntil(async () => (await fetch(link)).status === 404);
  expect(m.errors).toEqual([]);
});

it("filters the existing activity feed, shares a fleet and revokes an invite from the team UI", async () => {
  const m = mount(); await m.click('.tab[data-tab="team"]');
  await waitUntil(() => !!m.q('[data-feed-kind]'), { timeoutMs: 60_000 });
  await m.fill('[data-feed-kind]', 'pr_merged');
  expect(m.q('[data-tfeed="goal_started"]')!.hidden).toBe(true); expect(m.q('[data-tfeed="pr_merged"]')!.hidden).toBe(false);
  m.closeDialogs(); await m.click('[data-team-sharing]'); await waitUntil(() => !!m.q('[data-invite-revoke]'), { timeoutMs: 60_000 });
  await m.fill('[data-fleet-name]', 'browser'); await m.fill('[data-fleet-spec]', 'echox2'); await m.click('[data-publish]');
  await waitUntil(() => !!m.q('[data-import="browser"]')); await m.click('[data-import="browser"]');
  await waitUntil(async () => (await call('GET', '/api/fleets')).fleets.some((f: { name: string }) => f.name === 'browser'));
  await m.click('[data-remove-fleet="browser"]'); await waitUntil(() => !m.q('[data-import="browser"]'));
  await m.click('[data-invite-revoke]'); await waitUntil(() => !m.q('[data-invite-revoke]'));
  expect(m.errors).toEqual([]);
});


it("offers teammate mentions beside files and renders project presence names safely", async () => {
  const made = await call("POST", "/api/pair/new", {});
  const phone = await call("POST", "/api/pair/claim", { token: made.token, name: "Reader <img>" });
  const ws = new WebSocket(base.replace("http", "ws") + `/ws?project=${pid}`, [`loom.bearer.${phone.clientToken}`]);
  try {
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "presence", chat: "main" }));
    const m = mount(); await waitUntil(() => !!m.q('#box'));
    await waitUntil(() => (m.q('.srow .project-presence')?.getAttribute('aria-label') || '').includes('Reader <img>'));
    expect(m.q('.project-presence img')).toBeNull();
    const input = m.q('#box') as HTMLTextAreaElement; input.focus(); await m.fill('#box', '@bo'); input.setSelectionRange(3, 3);
    input.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    await waitUntil(() => (m.q('#cmenu')?.textContent || '').includes('@bob'));
    m.q('#cmenu .cmi')!.dispatchEvent(new m.dom.window.MouseEvent('mousedown', { bubbles: true }));
    expect(input.value).toBe('@bob ');
    expect(m.errors).toEqual([]);
  } finally { ws.terminate(); }
});
