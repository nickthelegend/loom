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
  process.env.LOOM_HOME = tmpDir("r3-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
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
function mount() {
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
      window.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), base), init).then(response => closed ? never : response)) as typeof window.fetch;
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

it("filters real memories and persists pin, archive, scope, and history/revert actions", async () => {
  const memory = (await rest<{ memory: Memory }>("/brain", "POST", { text: "dom419 Use sqlite <script>unsafe()</script>", kind: "decision" })).memory;
  await rest("/brain", "POST", { text: "dom419 A task for later", kind: "task" });
  const m = mount();
  await waitUntil(() => !!m.$('.tab[data-tab="brain"]')); m.click('.tab[data-tab="brain"]');
  await waitUntil(() => !!m.$('#brain-filters'));
  expect(m.$('.bmem script')).toBeNull();
  const input = m.$('#brain-filters input[name="q"]') as HTMLInputElement; input.value = "dom419";
  (m.$('#brain-filters input[name="agent"]') as HTMLInputElement).value = "user";
  m.$('#brain-filters')!.dispatchEvent(new m.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitUntil(() => !!m.$(`[data-mid="${memory.id}"]`));
  m.click('.bkind[data-kind="decision"]');
  await waitUntil(() => m.$('.bkind[data-kind="decision"]')?.classList.contains("on") === true);
  const row = `[data-mid="${memory.id}"]`;
  m.click(row + ' [data-memory-action="pin"]');
  await waitUntil(() => m.$(row + ' [data-memory-action="pin"]')?.textContent === "Unpin");
  m.click(row + ' [data-memory-action="history"]');
  await waitUntil(() => !!m.$('.brain-history [data-revert]'));
  expect(m.$('.brain-history')?.textContent).toContain('"pinned": true');
  m.click('.brain-history [data-revert]');
  await waitUntil(() => m.$(row + ' [data-memory-action="pin"]')?.textContent === "Pin");
  m.click(row + ' [data-memory-action="scope"]');
  await waitUntil(() => !!m.$('.cfmodal input'));
  (m.$('.cfmodal input') as HTMLInputElement).value = "main";
  m.$('.cfmodal input')!.dispatchEvent(new m.dom.window.Event("input", { bubbles: true }));
  m.click('.cfmodal .primary');
  await waitUntil(() => m.$(row)?.textContent?.includes("Chat: main") === true);
  m.click(row + ' [data-memory-action="archive"]');
  await waitUntil(() => !m.$(row));
  const q = m.$('#brain-filters input[name="q"]') as HTMLInputElement; q.value = "";
  (m.$('#brain-filters input[name="archived"]') as HTMLInputElement).checked = true;
  m.$('#brain-filters')!.dispatchEvent(new m.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitUntil(() => !!m.$(row));
  m.click(row + ' [data-memory-action="archive"]');
  await waitUntil(() => m.$(row + ' [data-memory-action="archive"]')?.textContent === "Archive");
  expect(m.errors).toEqual([]);
});

it("offers duplicate merge review, imports Markdown URL input, and explains recorded turns", async () => {
  await rest("/brain", "POST", { text: "dom419 The database connections use the shared sqlite database file.", kind: "fact" });
  await rest("/brain", "POST", { text: "dom419 The database connections use the shared sqlite database file!", kind: "fact" });
  const m = mount();
  await waitUntil(() => !!m.$('.tab[data-tab="brain"]')); m.click('.tab[data-tab="brain"]');
  await waitUntil(() => !!m.$('[data-merge]'));
  m.click('[data-merge]');
  await waitUntil(() => !!m.$('.cfmodal textarea'));
  expect((m.$('.cfmodal textarea') as HTMLTextAreaElement).value).toContain("sqlite");
  m.click('.cfmodal .primary');
  await waitUntil(() => !m.$('[data-merge]'));
  expect((m.$('#bimportf') as HTMLInputElement).accept).toContain(".md");
  m.click('[data-url]');
  await waitUntil(() => !!m.$('.cfmodal input'));
  expect(m.$('.cfmodal')?.textContent).toContain("public Markdown URL");
  m.click('.cfmodal .ghost');
  await rest("/messages", "POST", { text: "dom419 sqlite", agentId: "echo" });
  await waitUntil(async () => (await rest<{ injections: unknown[] }>("/brain/injections")).injections.length > 0);
  m.click('[data-why]');
  await waitUntil(() => !!m.$('[data-injections] details'));
  expect(m.$('[data-injections]')?.textContent).toContain("score");
  expect(m.$('[data-injections]')?.textContent).toContain("sqlite");
  expect(m.errors).toEqual([]);
});
