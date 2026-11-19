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
import { TeamLink } from "../src/daemon/team.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, base: string, token: string, pid: string, messageId: number, guest: string;
let hub: Awaited<ReturnType<typeof startHubServer>>, bob: TeamLink;
const mounted: Array<{ close(): void }> = [];
const route = (p: string) => `/api/projects/${pid}/teams-r4${p}`;
const call = async (method: string, p: string, body?: object) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-dom"); process.env.LOOM_NO_NOTIFY = "1"; process.env.LOOM_NO_PUSH = "1";
  hub = await startHubServer({ host: "127.0.0.1", port: 0, secret: "r4" });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const client = new DaemonClient(readDaemonConfig()!); base = client.baseUrl; token = readDaemonConfig()!.adminToken;
  const dir = makeProjectDir({ name: "R4 browser" }), git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "code.txt"), "before\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"); fs.writeFileSync(path.join(dir, "code.txt"), "after\n");
  git("remote", "add", "origin", "https://github.com/acme/r4-dom.git"); pid = (await client.addProject(dir)).project.id;
  await call("POST", "/api/templates", { name: "Explain", text: "Explain {{topic}}" });
  await call("PUT", "/api/orchestra-recipes", { name: "Unavailable", options: { goal: "Missing", workers: ["missing-worker"] } });
  await call("POST", route("/library/recipes/Unavailable/publish"), {});
  await daemon.team.signIn(hub.url, { github: "alice", secret: "r4" }); const team = (await daemon.team.createTeam("UI")).id; await call("POST", `/api/projects/${pid}/team/share`, { teamId: team });
  bob = new TeamLink({ statePath: path.join(tmpDir("r4-dom-bob"), "team.json"), runtimes: () => [], broadcast: () => {} }); await bob.join((await daemon.team.invite(team)).link, { github: "bob", secret: "r4" });
  await call("POST", `/api/projects/${pid}/messages`, { text: "Browser task", agentId: "execbot" });
  await waitUntil(async () => { const r = await call("GET", `/api/projects/${pid}/events`); messageId = r.events.find((e: any) => e.kind === "message" && e.payload.author === "user")?.id; return Boolean(messageId && r.events.some((e: any) => e.kind === "run_complete")); });
  const pairing = await call("POST", "/api/pair/new", { guest: { project: pid, chat: "main", name: "Guest", role: "view" } }); guest = (await call("POST", "/api/pair/claim", { token: pairing.token, name: "Guest" })).clientToken;
}, 60000);
afterEach(() => mounted.splice(0).forEach(m => m.close()));
afterAll(async () => { await bob?.stop(); await daemon?.close(); await hub?.close(); });

// Real bundled page and real daemon, with the browser capability shims from app-orchestra-dom.
function mount(guestMode = false) {
  const errors: string[] = [], sockets: WebSocket[] = []; let closed = false;
  const never = new Promise<never>(() => {}), vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, { url: `${base}/app#p/${pid}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia;
      w.fetch = ((url: string, init?: RequestInit) => {
        if (closed) return never;
        // Guests arrive from another machine, where loopback bootstrap is refused.
        if (guestMode && new URL(url, base).pathname === "/api/bootstrap") return Promise.resolve(new Response("{}", { status: 403 }));
        return fetch(new URL(url, base), init).then(r => closed ? never : r);
      }) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", guestMode ? guest : token); if (guestMode) w.localStorage.setItem("loomGuest", "1"); w.localStorage.setItem("loomDevMode", "1"); w.localStorage.setItem("loomSetupSeen", "1"); w.confirm = () => true;
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async () => {} } });
    } });
  const q = (s: string) => dom.window.document.querySelector(s) as HTMLElement | null;
  const click = async (s: string) => { await waitUntil(() => !!q(s)); q(s)!.click(); };
  const fill = async (s: string, value: string) => { await waitUntil(() => !!q(s)); const el = q(s) as HTMLInputElement; el.value = value; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  const m = { dom, errors, q, click, fill, close() { closed = true; sockets.forEach(s => { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); }); dom.window.close(); } }; mounted.push(m); return m;
}
it("publishes a personal template, labels the pulled Team entry, renders variables, and reports missing recipe workers", async () => {
  const m = mount(); await m.click('[data-library]'); await m.click('[data-publish="Explain"]');
  await waitUntil(() => !!m.q('[data-use="Explain"]'));
  expect(m.q('[data-use="Explain"]')?.parentElement?.textContent).toContain("Team");
  await m.click('[data-use="Explain"]'); await m.fill('[data-variable="topic"]', 'browser safety'); await m.click('[data-insert]');
  await waitUntil(() => (m.q('#box') as HTMLTextAreaElement)?.value === 'Explain browser safety');
  await m.click('[data-library]'); await m.click('[data-use="Unavailable"]');
  await waitUntil(() => (m.q('.scrim [data-error]')?.textContent || '').includes("aren't available locally")); expect(m.errors).toEqual([]);
});
it("passes and requests review through the UI and shows the standup in the Team tab", async () => {
  const m = mount(); await m.click('[data-pass]'); await m.fill('[data-login]', '@bob'); await m.fill('[data-note]', 'Please continue'); await m.click('[data-create]');
  await waitUntil(() => !!m.q('[aria-label="Share link"]'));
  const link = (m.q('[aria-label="Share link"]') as HTMLInputElement).value; expect(await (await fetch(link)).text()).toContain('Please continue');
  await m.click('[data-close]'); await m.click('[data-review]'); await m.fill('[data-login]', '@bob'); await m.click('[data-create]');
  await waitUntil(() => !!m.q('[aria-label="Share link"]')); expect(await (await fetch((m.q('[aria-label="Share link"]') as HTMLInputElement).value)).text()).toContain('Review requested from @bob');
  await m.click('[data-close]'); await m.click('.tab[data-tab="team"]');
  await waitUntil(() => (m.q('[data-report]')?.textContent || '').includes('Browser task')); expect(m.errors).toEqual([]);
});
it("creates a changes link from Source Control and displays visitor annotations with reply/remove controls", async () => {
  const m = mount();
  // Source Control is one of the existing right-rail views.
  await m.click('[data-view="scm"]');
  await m.click('[data-share-changes]'); await m.click('[data-create]'); await waitUntil(() => !!m.q('[aria-label="Share link"]'));
  const url = (m.q('[aria-label="Share link"]') as HTMLInputElement).value; expect(await (await fetch(url)).text()).toContain('code.txt'); await m.click('[data-close]');
  const link = await call('POST', route('/shares'), { chat: 'main' });
  const response = await fetch(link.url + '/annotations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '<Reviewer>', text: '<script>not code</script>', messageId }) }); expect(response.status).toBe(200);
  const { annotation } = await response.json();
  await waitUntil(() => !!m.q(`[data-annotation="${annotation.id}"]`));
  const selector = `[data-annotation="${annotation.id}"]`; expect(m.q(selector + ' script')).toBeNull(); expect(m.q(selector)?.parentElement?.getAttribute('data-id')).toBe(String(messageId));
  await m.click(selector + ' [data-reply]'); await m.fill(selector + ' textarea', 'Thanks, fixed');
  await new Promise(resolve => setTimeout(resolve, 5500));
  expect((m.q(selector + ' textarea') as HTMLTextAreaElement)?.value).toBe('Thanks, fixed');
  const save = Array.from(m.q(selector)!.querySelectorAll('button')).find(b => b.textContent === 'Save reply')!; save.click();
  await waitUntil(() => (m.q(selector)?.textContent || '').includes('Owner reply: Thanks, fixed'));
  await m.click(selector + ' [data-remove]'); await waitUntil(() => !m.q(selector)); expect(m.errors).toEqual([]);
});
it("guest Follow toggles presence and renders the owner's open file without executing markup", async () => {
  const owner = new WebSocket(base.replace('http', 'ws') + `/ws?project=${pid}`, [`loom.bearer.${token}`]);
  try {
    await new Promise<void>((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); }); owner.send(JSON.stringify({ type: 'presence', chat: 'main' }));
    const m = mount(true); await m.click('#gfollow');
    await waitUntil(async () => (await call('GET', `/api/projects/${pid}/chats/main/presence`)).people.some((p: any) => p.kind === 'guest' && p.following));
    owner.send(JSON.stringify({ type: 'presence', chat: 'main', view: { scroll: 0.3, file: 'code.txt', preview: '<script>preview</script>' } }));
    await waitUntil(() => (m.q('#gfollow-file')?.textContent || '').includes('<script>preview</script>')); expect(m.q('#gfollow-file script')).toBeNull();
    await m.click('#gfollow'); expect(m.q('#gfollow')?.getAttribute('aria-pressed')).toBe('false'); expect(m.q('#gfollow-file')?.hidden).toBe(true); expect(m.errors).toEqual([]);
  } finally { owner.terminate(); }
});

it("the public page's real forms submit chat comments and changes review verdicts as annotations", async () => {
  const errors: string[] = [];
  async function submit(body: object, field: string, fields: Record<string, string>) {
    const share = await call("POST", route("/shares"), { ...body, chat: "main" });
    const response = await fetch(share.url), html = await response.text();
    const vc = new VirtualConsole();
    vc.on("jsdomError", e => { if (!/^Not implemented: navigation (?:\(except hash changes\)|to another Document)$/.test(e.message)) errors.push(e.message); });
    const page = new JSDOM(html, { url: share.url, runScripts: "dangerously", virtualConsole: vc, beforeParse(w) { w.fetch = ((p: string, init?: RequestInit) => fetch(new URL(p, share.url), init)) as typeof w.fetch; } });
    mounted.push({ close: () => page.window.close() });
    const form = page.window.document.querySelector(`[name="${field}"]`)!.closest("form")!;
    for (const [name, value] of Object.entries(fields)) (form.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitUntil(async () => (await call("GET", route("/annotations/main"))).annotations.some((a: any) => a.shareId === share.id && a.text === fields.text));
  }
  await submit({}, "messageId", { name: "Browser visitor", text: "A comment from the page", messageId: String(messageId) });
  await submit({ review: "@bob" }, "verdict", { name: "Bob", text: "Approved in the browser", verdict: "approve" });
  expect(errors).toEqual([]);
});

it("preserves selected Orchestra run sharing with expiry controls and revocation", async () => {
  const run = (await call("POST", `/api/projects/${pid}/orchestra`, { goal: "Share this run", orchestrator: "plannerbot", workers: ["execbot"] })).run;
  const m = mount(); await m.click('.tab[data-tab="orchestra"]');
  await waitUntil(() => !!m.q('[data-run]')); await m.click('#oshare');
  await m.fill('[data-expiry-preset]', '7d'); await m.click('[data-create-share]');
  await waitUntil(() => !!m.q('[aria-label="Read-only share link"]'));
  const url = (m.q('[aria-label="Read-only share link"]') as HTMLInputElement).value;
  expect(await (await fetch(url)).text()).toContain('Read-only Orchestra run');
  expect(m.q('[data-share-result]')?.textContent).toMatch(/6d|7d/);
  await m.click('[data-revoke]'); await waitUntil(async () => (await fetch(url)).status === 404);
  await call("POST", `/api/projects/${pid}/orchestra/${run.id}/abort`, {});
  expect(m.errors).toEqual([]);
});

it("sends browser file previews only for a following guest and resends immediately on follow", () => {
  const dom = new JSDOM('<div id="pane-thread"></div><div id="dockpane" class="open"></div><div id="docktabs"><div class="dtab on" data-dtab="f:code.txt" title="code.txt"></div></div><div id="pane-changes"><div class="filepreview"><span class="lc">private file text</span></div></div>', { runScripts: "outside-only" });
  const w = dom.window, frames: any[] = [];
  const socket = new w.EventTarget() as EventTarget & { readyState: number; send: (data: string) => void };
  socket.readyState = 1; socket.send = data => frames.push(JSON.parse(data));
  const source = fs.readFileSync(path.join(process.cwd(), "src/web/presence.js"), "utf8").replace(/^import .*;$/m, "").replaceAll("export function", "function");
  w.eval(source);
  let chat = "main";
  const tracker = (w as any).trackPresence(socket, () => chat, null);
  const presence = (following: boolean, current = "main") => socket.dispatchEvent(new w.MessageEvent("message", { data: JSON.stringify({ type: "presence", chat: current, people: [{ kind: "guest", following }] }) }));
  try {
    expect(frames.at(-1)).not.toHaveProperty("view");
    presence(false); tracker.poke(); expect(frames.at(-1)).not.toHaveProperty("view");
    presence(true);
    expect(frames.at(-1).view).toMatchObject({ file: "code.txt", preview: "private file text" });
    presence(false); tracker.poke(); expect(frames.at(-1)).not.toHaveProperty("view");
    presence(true); chat = "private"; tracker.poke(); expect(frames.at(-1)).not.toHaveProperty("view");
    presence(true, "main"); tracker.poke(); expect(frames.at(-1)).not.toHaveProperty("view");
    chat = "main"; tracker.poke(); expect(frames.at(-1)).not.toHaveProperty("view");
    tracker.stop(); const count = frames.length; presence(true, "private"); expect(frames).toHaveLength(count);
  } finally { tracker.stop(); dom.window.close(); }
});
