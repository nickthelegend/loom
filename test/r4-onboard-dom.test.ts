import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

let daemon: LoomDaemon, client: DaemonClient, project: string, token: string, provider: Server, providerUrl: string;
const mounted: Array<{ dom: JSDOM; errors: string[]; close: () => void }> = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, setup: { agents: async () => [] } }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  const cfg = readDaemonConfig()!; cfg.projectsRoot = tmpDir("r4-dom-projects"); writeDaemonConfig(cfg);
  process.env.LOOM_DEMO_DURATION_MS = "50";
  provider = createServer((req, res) => { res.setHeader("content-type", "application/json"); if (req.headers.authorization === "Bearer ui-test-key") res.end('{"data":[{"id":"tiny"}]}'); else { res.statusCode = 401; res.end('{"error":"bad key"}'); } });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r)); providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const dir = makeProjectDir(); fs.writeFileSync(path.join(dir, "package.json"), '{"dependencies":{"react":"1"},"scripts":{"test":"node --test"}}'); project = (await client.addProject(dir)).project.id;
});
afterEach(() => { while (mounted.length) { const m = mounted.pop()!; m.close(); expect(m.errors).toEqual([]); } });
afterAll(async () => { await daemon.close(); if (provider) await new Promise<void>(r => provider.close(() => r())); });
function mount(hash = `#p/${project}`, release = "2.1.0", opts: { fresh?: boolean; simple?: boolean; releaseVersion?: string; beforeFetch?: (path: string) => Promise<void> } = {}) {
  const errors: string[] = [], sockets: WebSocket[] = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message));
  let closed = false; const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, { url: `${client.baseUrl}/app${hash}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
    w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof w.matchMedia;
    w.fetch = (async (input: string, init?: RequestInit) => {
      if (opts.beforeFetch) await opts.beforeFetch(new URL(String(input), client.baseUrl).pathname);
      return closed ? never : opts.releaseVersion && String(input).includes('/api/help/whatsnew') ? new Response(JSON.stringify({ version: opts.releaseVersion, highlights: [{ text: 'New features', topic: 'getting-started' }] }), { headers: { 'content-type': 'application/json' } }) : fetch(new URL(String(input), client.baseUrl), init).then(r => closed ? never : r);
    }) as typeof w.fetch;
    w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
    w.localStorage.setItem("loomClientToken", token);
    if (!opts.fresh) { w.localStorage.setItem("loomDevMode", opts.simple ? "0" : "1"); w.localStorage.setItem("loomSetupSeen", "1"); w.localStorage.setItem("loomTourDone", "1"); }
    const rect = w.HTMLElement.prototype.getBoundingClientRect;
    w.HTMLElement.prototype.getBoundingClientRect = function() {
      if (this.matches('.tab[data-tab="orchestra"],.tab[data-tab="brain"],.triggersmodal,.rail')) return { x: 100, y: 200, left: 100, top: 200, right: 220, bottom: 240, width: 120, height: 40, toJSON() {} };
      return rect.call(this);
    };
    if (release) w.localStorage.setItem("loomReleaseSeen", release);
    w.confirm = () => true;
  } });
  const m = { dom, errors, close: () => { closed = true; for (const socket of sockets) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); } dom.window.close(); } }; mounted.push(m); return dom.window;
}
function click(w: JSDOM["window"], selector: string) { const b = w.document.querySelector<HTMLElement>(selector); expect(b, selector).not.toBeNull(); b!.click(); }
it("opens Help from the status bar and palette, searches guides and reopens release highlights", async () => {
  const w = mount(); await waitUntil(() => !!w.document.querySelector('[data-open-help]'));
  click(w, '[data-open-help]'); await waitUntil(() => w.document.querySelectorAll('.r4help details').length > 0);
  const input = w.document.querySelector<HTMLInputElement>('[data-help-search]')!; input.value = "copper"; input.dispatchEvent(new w.Event("input"));
  expect(w.document.querySelectorAll('.r4help details').length).toBe(0);
  input.value = "memory"; input.dispatchEvent(new w.Event("input")); expect(w.document.querySelector('.r4help')!.textContent).toContain("Brain");
  click(w, '[data-whatsnew]'); await waitUntil(() => !!w.document.querySelector('[data-highlight]'));
  click(w, '[data-highlight]'); await waitUntil(() => !!w.document.querySelector('.r4help details[open]'));
  click(w, '.r4help .iconbtn');
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await waitUntil(() => !!w.document.querySelector('#pq'));
  const query = w.document.querySelector<HTMLInputElement>('#pq')!; query.value = "Help"; query.dispatchEvent(new w.Event("input", { bubbles: true }));
  await waitUntil(() => Array.from(w.document.querySelectorAll('.prow')).some(r => r.textContent?.includes("Help")));
  (Array.from(w.document.querySelectorAll<HTMLElement>('.prow')).find(r => r.textContent?.includes("Help"))!).click();
  await waitUntil(() => !!w.document.querySelector('[data-help-search]'));
});
it("shows an update once per device and records the installed version", async () => {
  const w = mount(` #p/${project}`.trim(), "2.0.0");
  await waitUntil(() => !!w.document.querySelector('[data-highlight]'));
  expect(w.localStorage.getItem('loomReleaseSeen')).toBe('2.1.0'); click(w, '.r4help .iconbtn');
  expect(w.document.querySelector('[data-highlight]')).toBeNull();
});
it.each(['Setup', 'What’s new'])("opens project agent settings when automatic %s rendered before the sidebar", async (dialog) => {
  let releaseProjects!: () => void;
  const projectsReady = new Promise<void>(resolve => { releaseProjects = resolve; });
  const w = mount(undefined, dialog === 'Setup' ? '' : '2.0.0', {
    fresh: dialog === 'Setup',
    beforeFetch: p => p === '/api/projects' ? projectsReady : Promise.resolve(),
  });
  await waitUntil(() => !!w.document.querySelector(dialog === 'Setup' ? '#setpane' : '[data-highlight]'));
  releaseProjects();
  await waitUntil(() => !!w.document.querySelector<HTMLButtonElement>(`[data-pset="${project}"]`)?.onclick);
  click(w, `[data-pset="${project}"]`);
  expect(w.document.querySelector('#psbody')).not.toBeNull();
  await waitUntil(() => w.document.querySelectorAll('#psbody .psrow [data-avatar]').length === 2);
  expect(w.document.querySelectorAll('.scrim')).toHaveLength(1);
  expect(w.document.querySelector('#setpane,[data-highlight]')).toBeNull();
  // The displaced dialog must also release its Escape handler.
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(w.document.querySelector('.scrim')).toBeNull();
});
it("keeps project settings when the release check finishes after the click", async () => {
  let releaseCheck!: () => void;
  const checkReady = new Promise<void>(resolve => { releaseCheck = resolve; });
  let checking = false;
  const w = mount(undefined, '2.0.0', {
    beforeFetch: p => { if (p === '/api/help/whatsnew') { checking = true; return checkReady; } return Promise.resolve(); },
  });
  await waitUntil(() => checking && !!w.document.querySelector<HTMLButtonElement>(`[data-pset="${project}"]`)?.onclick);
  click(w, `[data-pset="${project}"]`);
  await waitUntil(() => w.document.querySelectorAll('#psbody .psrow [data-avatar]').length === 2);
  releaseCheck();
  // Allow the real response and the existing deferred startup check to run.
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(w.document.querySelectorAll('.scrim')).toHaveLength(1);
  expect(w.document.querySelector('[data-highlight]')).toBeNull();
  click(w, '#psx');
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(w.document.querySelector('.scrim')).toBeNull();
  // Suppressing an automatic suggestion does not disable the explicit action.
  click(w, '[data-open-help]');
  click(w, '[data-whatsnew]');
  await waitUntil(() => !!w.document.querySelector('[data-highlight]'));
});
it("records the legacy release without treating the same version as an update or blocking Setup", async () => {
  const w = mount('#home', "", { releaseVersion: "2.1.0" });
  await waitUntil(() => w.localStorage.getItem('loomReleaseSeen') === '2.1.0');
  expect(w.document.querySelector('[data-highlight]')).toBeNull();
  click(w, '#setupbtn');
  await waitUntil(() => !!w.document.querySelector('#setpane'));
});
it("replaces generic suggestions with stack-aware prompts that fill the composer without sending", async () => {
  const w = mount(); await waitUntil(() => w.document.querySelectorAll('[data-starter]').length === 5);
  expect(w.document.querySelector('[data-starter]')!.textContent).toContain("React"); click(w, '[data-starter]');
  expect(w.document.querySelector<HTMLTextAreaElement>('#box')!.value).toContain('React');
  expect((await client.events(project)).events.filter(e => e.kind === 'message')).toHaveLength(0);
});
it.each([
  ["brain", "Teach a decision", "Use and maintain memory"],
  ["orchestra", "Give a fleet a goal", "Follow the plan"],
  ["triggers", "Create a schedule", "Inspect a run"],
  ["review", "Ask independent reviewers", "Decide on findings"],
])("reuses the demo engine for the resumable %s tour", async (id, first, second) => {
  const w = mount(undefined, undefined, { simple: true });
  await waitUntil(() => !!w.document.querySelector('[data-open-help]')); click(w, '[data-open-help]'); await waitUntil(() => !!w.document.querySelector('[data-tour="' + id + '"]')); click(w, '[data-tour="' + id + '"]');
  await waitUntil(() => !!w.document.querySelector('#tourcard')); expect(w.document.querySelector('#tourcard')!.textContent).toContain(first);
  const label = id === 'brain' ? 'Brain' : id[0]!.toUpperCase() + id.slice(1);
  expect(w.document.querySelector('.tourstep')!.textContent).toBe(label + ' · 1 of 2');
  expect(w.document.querySelector<HTMLElement>('#tourshade')!.style.left).toBe('94px');
  expect(w.localStorage.getItem('loomDevMode')).toBe(id === 'orchestra' ? '1' : '0');
  if (id === 'orchestra' || id === 'brain') expect(w.document.querySelector('.tab[data-tab="' + id + '"]')!.classList.contains('active')).toBe(true);
  if (id === 'triggers') expect(w.document.querySelector('.triggersmodal')).not.toBeNull();
  if (id === 'review') expect(w.document.querySelector('#railtitle')!.textContent).toContain('Source control');
  click(w, '#tournext'); expect(w.document.querySelector('.tourstep')!.textContent).toBe(label + ' · 2 of 2'); expect(w.document.querySelector<HTMLElement>('#tourshade')!.style.left).toBe('94px'); expect(w.localStorage.getItem('loomFeatureTour:' + id)).toBe('1');
  click(w, '#tourskip'); await waitUntil(() => !w.document.querySelector('#tourcard'));
  await waitUntil(() => !!w.document.querySelector('[data-open-help]')); click(w, '[data-open-help]'); await waitUntil(() => !!w.document.querySelector('[data-tour="' + id + '"]')); expect(w.document.querySelector('[data-tour="' + id + '"]')!.textContent).toContain('Resume');
  click(w, '[data-tour="' + id + '"]'); await waitUntil(() => !!w.document.querySelector('#tourcard')); expect(w.document.querySelector('#tourcard')!.textContent).toContain(second); expect(w.document.querySelector('.tourstep')!.textContent).toBe(label + ' · 2 of 2');
  click(w, '#tournext'); await waitUntil(() => !w.document.querySelector('#tourcard')); expect(w.localStorage.getItem('loomFeatureTour:' + id)).toBe('2');
});
it("installs examples from Home and exposes the provider guide from Setup", async () => {
  const w = mount('#home'); await waitUntil(() => !!w.document.querySelector('[data-example="explain-code"]'));
  click(w, '[data-example="explain-code"]'); await waitUntil(() => w.document.querySelector('[data-example="explain-code"]')!.parentElement!.textContent!.includes('Installed'));
  click(w, '#setupbtn'); await waitUntil(() => !!w.document.querySelector('[data-provider-guide]'));
  click(w, '[data-provider-guide]'); expect(w.document.querySelector('#r4key')!.getAttribute('type')).toBe('password');
  click(w, '[data-provider-next]'); await waitUntil(() => w.document.querySelector('.r4help [role=status]')!.textContent!.includes('key is required'));
});
it("offers readiness fixes in project Settings with a preview", async () => {
  const w = mount(); await waitUntil(() => !!w.document.querySelector('#box'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await waitUntil(() => !!w.document.querySelector('#pq'));
  const q = w.document.querySelector<HTMLInputElement>('#pq')!; q.value = 'Project settings'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitUntil(() => Array.from(w.document.querySelectorAll('.prow')).some(r => r.textContent?.includes('Project settings')));
  Array.from(w.document.querySelectorAll<HTMLElement>('.prow')).find(r => r.textContent?.includes('Project settings'))!.click();
  await waitUntil(() => !!w.document.querySelector('[data-ready-fix]')); expect(w.document.querySelector('.r4readiness')!.textContent).toContain('AGENTS'); click(w, '[data-ready-fix]');
  await waitUntil(() => w.document.querySelector('.r4readiness')!.textContent!.includes('Drafted AGENTS.md'));
});

it("finishes the provider guide through its real four-step form", async () => {
  const w = mount(); await waitUntil(() => !!w.document.querySelector('#setupbtn')); click(w, '#setupbtn');
  await waitUntil(() => !!w.document.querySelector('[data-provider-guide]')); click(w, '[data-provider-guide]');
  w.document.querySelector<HTMLInputElement>('#r4provider')!.value = 'r4ui';
  w.document.querySelector<HTMLInputElement>('#r4key')!.value = 'ui-test-key';
  w.document.querySelector<HTMLInputElement>('#r4url')!.value = providerUrl;
  click(w, '[data-provider-next]'); await waitUntil(() => w.document.querySelector('.r4help')!.textContent!.includes('Step 2'));
  expect(w.document.querySelector('.r4help')!.textContent).not.toContain('ui-test-key');
  click(w, '[data-provider-next]'); await waitUntil(() => !!w.document.querySelector('#r4model'));
  expect(w.document.querySelector('#r4model')!.textContent).toContain('tiny'); click(w, '[data-provider-next]');
  await waitUntil(() => !!w.document.querySelector('#r4project')); w.document.querySelector<HTMLSelectElement>('#r4project')!.value = project;
  click(w, '[data-provider-next]'); await waitUntil(() => w.document.querySelector('.r4help')!.textContent!.includes('project’s default agent'));
  expect((await client.project(project)).project.agents.some(a => a.kind === 'model')).toBe(true);
});
it("offers all four additional starters in the existing picker", async () => {
  const w = mount('#home'); await waitUntil(() => !!w.document.querySelector('#homenew')); click(w, '#homenew');
  await waitUntil(() => !!w.document.querySelector('#nptemplate option[value="python"]'));
  for (const name of ['api','cli','static','python']) expect(w.document.querySelector('#nptemplate option[value="' + name + '"]')).not.toBeNull();
});
it("runs an offline scenario from Home and opens its result conversation", async () => {
  const w = mount('#home'); await waitUntil(() => !!w.document.querySelector('[data-scenario="memory"]')); click(w, '[data-scenario="memory"]');
  await waitUntil(() => w.document.querySelector('#feed')?.textContent?.includes('The release codename is copper lantern') ?? false);
  expect(w.document.querySelector('#feed')!.textContent).toContain('shared decision');
});

it("records a fresh browser's release without interrupting its requested demo walkthrough", async () => {
  const { project: demo } = await client.tryProject();
  const w = mount(`?tour=1#p/${demo.id}`, "", { fresh: true, releaseVersion: "2.2.0" });
  await waitUntil(() => w.localStorage.getItem('loomReleaseSeen') === '2.2.0');
  expect(w.document.querySelector('[data-highlight]')).toBeNull();
  await waitUntil(() => !!w.document.querySelector('#tourcard'));
  expect(w.document.querySelector('.tourstep')!.textContent).toBe('Try Loom · 1 of 5');
});
it("shows a legacy browser's update after the requested demo has ended", async () => {
  const { project: demo } = await client.tryProject();
  const w = mount(`?tour=1#p/${demo.id}`, "", { releaseVersion: "2.2.0" });
  await waitUntil(() => !!w.document.querySelector('#tourcard'));
  expect(w.document.querySelector('[data-highlight]')).toBeNull();
  expect(w.localStorage.getItem('loomReleaseSeen')).toBeNull();
  click(w, '#tourskip');
  await waitUntil(() => !!w.document.querySelector('[data-highlight]'));
  expect(w.localStorage.getItem('loomReleaseSeen')).toBe('2.2.0');
});
