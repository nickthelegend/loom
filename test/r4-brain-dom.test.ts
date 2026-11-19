import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import type { Memory } from "../src/core/brain.js";

let daemon: LoomDaemon, base: string, token: string, project: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken;
  const client = new DaemonClient(readDaemonConfig()!);
  project = (await client.addProject(makeProjectDir({ agents: [{ id: "echo", kind: "echo", role: "worker" }] }))).project.id;
});
afterAll(async () => { await daemon.close(); });
async function rest<T = unknown>(route: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(`${base}/api/projects/${project}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
const live: Array<() => void> = [];
afterEach(() => { live.splice(0).forEach(close => close()); });

// The same small real-daemon harness used by app-orchestra-dom, kept local to this batch.
function mount(intercept?: (url: URL, init: RequestInit | undefined, response: Response) => Promise<Response>) {
  const errors: string[] = [], sockets: WebSocket[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => errors.push(error.message));
  let closed = false;
  const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, {
    url: `${base}/app#p/${project}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.prompt = undefined as unknown as typeof window.prompt;
      window.scrollTo = () => {}; window.HTMLElement.prototype.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((media: string) => ({ matches: /min-width/.test(media), media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), base), init).then(response => closed ? never : intercept ? intercept(new URL(String(input), base), init, response) : response)) as typeof window.fetch;
      window.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", token);
      window.localStorage.setItem("loomDevMode", "1");
    },
  });
  live.push(() => { closed = true; for (const socket of sockets) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); } dom.window.close(); });
  const $ = (selector: string) => dom.window.document.querySelector<HTMLElement>(selector);
  const click = (selector: string) => { const el = $(selector); expect(el, selector).toBeTruthy(); el!.click(); };
  return { dom, $, click, errors };
}

it("asks with escaped citations, filters tag chips, edits paths, teaches and shows changes", async () => {
  const memory = (await rest<{ memory: Memory }>("/brain", "POST", { text: "r4451dom Run npm test <script>unsafe()</script>", kind: "fact", tags: ["tests"] })).memory;
  const m = mount(); await waitUntil(() => !!m.$('.tab[data-tab="brain"]')); m.click('.tab[data-tab="brain"]');
  await waitUntil(() => !!m.$('[data-ask]'));
  const submit = (selector: string) => m.$(selector)!.dispatchEvent(new m.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  (m.$('[data-ask] input[name="question"]') as HTMLInputElement).value = "r4451dom npm test"; submit('[data-ask]');
  await waitUntil(() => !!m.$('[data-citation]')); expect(m.$('[data-answer]')?.textContent).toContain(memory.id); expect(m.$('[data-answer] script')).toBeNull();
  m.click('[data-tag="tests"]'); await waitUntil(() => (m.$('#brain-filters input[name="tag"]') as HTMLInputElement)?.value === "tests");
  m.click(`[data-mid="${memory.id}"] [data-memory-action="paths"]`);
  await waitUntil(() => !!m.$('.cfmodal input')); (m.$('.cfmodal input') as HTMLInputElement).value = 'src/web/**'; m.click('.cfmodal .primary');
  await waitUntil(() => m.$(`[data-mid="${memory.id}"]`)?.textContent?.includes('src/web/**') === true);
  (m.$('[data-teach] input[name="tests"]') as HTMLInputElement).value = 'npm run test:unit';
  (m.$('[data-teach] input[name="conventions"]') as HTMLInputElement).value = 'Always use ESM'; submit('[data-teach]');
  await waitUntil(async () => (await rest<{ memories: Memory[] }>('/brain?tag=interview')).memories.some(row => row.text.includes('Always use ESM')));
  await waitUntil(() => m.$('[data-changes]')?.textContent?.includes('Always use ESM') === true);
  expect(m.errors).toEqual([]);
});

it("reviews Wrong feedback through the project inbox and controls review-before-saving", async () => {
  const memory = (await rest<{ memory: Memory }>("/brain", "POST", { text: 'r4451dom Keep database fixtures.', kind: 'fact', pinned: true })).memory;
  await rest('/messages', 'POST', { text: 'database fixtures', agentId: 'echo' });
  await waitUntil(async () => (await rest<{ injections: unknown[] }>('/brain/injections')).injections.length > 0);
  const m = mount(); await waitUntil(() => !!m.$('.tab[data-tab="brain"]')); m.click('.tab[data-tab="brain"]'); await waitUntil(() => !!m.$('[data-review]'));
  m.click('[data-review]'); await waitUntil(async () => (await rest<{ reviewBeforeSaving: boolean }>('/brain/settings')).reviewBeforeSaving);
  m.click('[data-why]'); await waitUntil(() => !!m.$(`[data-feedback="wrong"][data-memory="${memory.id}"]`));
  m.click(`[data-feedback="wrong"][data-memory="${memory.id}"]`);
  await waitUntil(() => !!m.$('[data-review-action="edit"]'));
  await waitUntil(() => !m.$(`[data-mid="${memory.id}"]`)); m.click('[data-review-action="edit"]');
  await waitUntil(() => !!m.$('.cfmodal textarea')); (m.$('.cfmodal textarea') as HTMLTextAreaElement).value = 'Keep current database fixtures.'; m.click('.cfmodal .primary');
  await waitUntil(() => m.$('[data-inbox]')?.textContent?.includes('Keep current database fixtures.') === true);
  m.click('[data-review-action="approve"]');
  await waitUntil(() => m.$(`[data-mid="${memory.id}"]`)?.textContent?.includes('Keep current database fixtures.') === true);
  await waitUntil(() => m.$('[data-inbox]')?.textContent?.includes('No memories waiting') === true); expect(m.errors).toEqual([]);
});

it("saves and removes packs, and displays document source controls", async () => {
  const m = mount(); await waitUntil(() => !!m.$('.tab[data-tab="brain"]')); m.click('.tab[data-tab="brain"]'); await waitUntil(() => !!m.$('[data-pack-save]'));
  (m.$('[data-pack-save] input[name="name"]') as HTMLInputElement).value = 'dom-pack';
  m.$('[data-pack-save]')!.dispatchEvent(new m.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => !!m.$('[data-pack-rm="dom-pack"]')); expect(m.$('[data-pack-download]')).toBeTruthy();
  m.click('[data-pack-rm="dom-pack"]'); await waitUntil(() => !m.$('[data-pack-rm="dom-pack"]'));
  expect((m.$('[data-source-add] input[name="pattern"]') as HTMLInputElement).value).toBe('docs/**/*.md');
  m.$('[data-source-add]')!.dispatchEvent(new m.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => !!m.$('[data-source-action="refresh"]'));
  m.click('[data-source-action="rm"]'); await waitUntil(() => !m.$('[data-source-action="rm"]'));
  expect(m.errors).toEqual([]);
});


it("ignores a stale settings GET after a toggle and displays the saved PATCH value", async () => {
  await rest('/brain/settings', 'PATCH', { reviewBeforeSaving: false });
  let release!: () => void, captured = false, released = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const m = mount(async (url, init, response) => {
    if (url.pathname.endsWith('/brain/settings') && (!init?.method || init.method === 'GET')) {
      captured = true; await held; released = true;
    }
    return response;
  });
  await waitUntil(() => !!m.$('.tab[data-tab="brain"]')); m.click('.tab[data-tab="brain"]');
  await waitUntil(() => captured && !!m.$('[data-review]'));
  m.click('[data-review]');
  const checkbox = () => m.$('[data-review]') as HTMLInputElement;
  await waitUntil(() => !checkbox().disabled);
  expect((await rest<{ reviewBeforeSaving: boolean }>('/brain/settings')).reviewBeforeSaving).toBe(true);
  release(); await waitUntil(() => released);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(checkbox().checked).toBe(true);
  m.click('[data-review]'); await waitUntil(() => !checkbox().disabled);
  expect(checkbox().checked).toBe(false);
  expect((await rest<{ reviewBeforeSaving: boolean }>('/brain/settings')).reviewBeforeSaving).toBe(false);
  expect(m.errors).toEqual([]);
});
