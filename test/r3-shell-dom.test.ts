/** Issue #422: the bundled shell against a real echo-only daemon. */
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, token: string, pid: string, other: string, otherChat: string;
const mounted: ReturnType<typeof mount>[] = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-shell");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  base = `http://${cfg.host}:${cfg.port}`; token = cfg.adminToken;
  client = new DaemonClient(cfg);
  pid = (await client.addProject(makeProjectDir({ name: "shell alpha" }))).project.id;
  other = (await client.addProject(makeProjectDir({ name: "shell beta" }))).project.id;
  otherChat = (await client.createChat(other, "r3 planning")).chat.id;
  await client.send(other, "r3 needle <safe>", undefined, { chat: otherChat });
  await waitUntil(async () => (await client.searchAll("r3 needle")).hits.length > 0);
});
afterEach(() => { while (mounted.length) mounted.pop()!.close(); });
afterAll(async () => { await daemon.close(); });

function mount(saved: Record<string, string> = {}, hash = `#p/${pid}`) {
  const errors: string[] = [], sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const vc = new VirtualConsole(); vc.on("jsdomError", (e: Error) => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, {
    url: `${base}/app${hash}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), base), init).then(r => closed ? never : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token);
      w.localStorage.setItem("loomSetupSeen", "1"); w.localStorage.setItem("loomDevMode", "1");
      for (const [k, v] of Object.entries(saved)) w.localStorage.setItem(k, v);
      w.confirm = () => true;
    },
  });
  const w = dom.window;
  const m = { w, errors, doc: w.document,
    click(selector: string) { const el = w.document.querySelector<HTMLElement>(selector); expect(el, selector).toBeTruthy(); el!.click(); },
    key(key: string, extra = {}) { w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, ...extra })); },
    saved() { return Object.fromEntries(Object.keys(w.localStorage).map(k => [k, w.localStorage.getItem(k)!])); },
    close() { closed = true; for (const s of sockets) { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); } w.close(); },
  };
  mounted.push(m); return m;
}
async function ready(m: ReturnType<typeof mount>) { await waitUntil(() => !!m.doc.querySelector("#box")); }
async function palette(m: ReturnType<typeof mount>) { m.key("k"); await waitUntil(() => !!m.doc.querySelector("#pq")); }
async function command(m: ReturnType<typeof mount>, text: string) {
  await palette(m);
  const input = m.doc.querySelector<HTMLInputElement>("#pq")!;
  input.value = text; input.dispatchEvent(new m.w.Event("input", { bubbles: true }));
  const row = [...m.doc.querySelectorAll<HTMLElement>(".prow")].find(r => r.querySelector(".plabel")?.textContent === text);
  expect(row, text).toBeTruthy(); row!.click();
}

it("edits bindings, rejects conflicts, disables old bindings and persists defaults/reset", async () => {
  const m = mount(); await ready(m);
  await command(m, "Keyboard shortcuts");
  const input = m.doc.querySelector<HTMLInputElement>('[data-shortcut="palette"]')!;
  input.dispatchEvent(new m.w.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  expect(m.doc.querySelector("#shortcut-error")!.textContent).toContain("Already used");
  input.dispatchEvent(new m.w.KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }));
  m.click("#sclose"); m.key("k"); expect(m.doc.querySelector("#pq")).toBeNull();
  m.key("j"); expect(m.doc.querySelector("#pq")).toBeTruthy(); m.key("Escape", { ctrlKey: false });
  const n = mount(m.saved()); await ready(n); n.key("j"); expect(n.doc.querySelector("#pq")).toBeTruthy();
  expect(m.errors).toEqual([]); expect(n.errors).toEqual([]);
});

it("puts recent commands first, deduplicates them and keeps a bounded toast history", async () => {
  const m = mount(); await ready(m);
  await command(m, "Toggle sidebar"); await palette(m);
  expect(m.doc.querySelector(".psec")!.textContent).toBe("Recent commands");
  expect(m.doc.querySelector(".prow")!.textContent).toContain("Toggle sidebar");
  m.key("Escape", { ctrlKey: false });
  await command(m, "Toggle sidebar");
  expect(JSON.parse(m.w.localStorage.getItem("loomRecentCommands:v1")!)).toEqual(["toggle-sidebar"]);
  m.w.localStorage.setItem("loomNotifications:v1", JSON.stringify([{ text: '<b>past toast</b>', at: Date.now(), project: pid, chat: 'main' }]));
  await command(m, "Notification history");
  expect(m.doc.querySelector(".notification-entry")!.textContent).toContain("<b>past toast</b>");
  expect(m.doc.querySelector(".notification-entry b")).toBeNull();
  m.click('[data-clear]'); expect(m.doc.querySelector('[data-history]')!.textContent).toContain("No notifications yet");
  expect(m.errors).toEqual([]);
});

it("searches all projects from the palette and opens the matching chat", async () => {
  const m = mount(); await ready(m); await palette(m);
  const input = m.doc.querySelector<HTMLInputElement>("#pq")!;
  input.value = "r3 needle"; input.dispatchEvent(new m.w.Event("input", { bubbles: true }));
  await waitUntil(() => [...m.doc.querySelectorAll(".psub")].some(r => r.textContent?.includes("shell beta")));
  const hit = [...m.doc.querySelectorAll<HTMLElement>(".prow")].find(r => r.textContent?.includes("shell beta"))!;
  expect(hit.querySelector("safe")).toBeNull(); hit.click();
  await waitUntil(() => m.w.location.hash === `#p/${other}`);
  await ready(m);
  await waitUntil(() => m.doc.querySelector(".crow.cur")?.getAttribute("data-chat") === otherChat);
  expect(m.errors).toEqual([]);
});

it("restores project, chat, active tab and split mode; explicit links win", async () => {
  const m = mount(); await ready(m); m.click('[data-tab="brain"]');
  await waitUntil(() => !!m.doc.querySelector("#memory-start"));
  m.click("#memory-start"); expect(m.doc.activeElement?.id).toBe("decbox");
  const n = mount(m.saved(), ""); await ready(n);
  expect(n.w.location.hash).toBe(`#p/${pid}`);
  await waitUntil(() => !!n.doc.querySelector("#memory-start"));
  const split = JSON.stringify({ layout: { direction: "row", children: [{ id: "a" }, { id: "b" }] }, panes: { a: { hash: `#p/${pid}` }, b: { hash: `#p/${other}` } }, focus: "b" });
  const s = mount({ "loomSplit:v1": split }, "");
  expect(s.w.location.search).toBe("?split=1"); expect(s.doc.querySelectorAll("iframe.wsframe")).toHaveLength(2);
  const explicit = mount({ "loomSplit:v1": split }); await ready(explicit); expect(explicit.w.location.search).toBe("");
  expect(m.errors).toEqual([]); expect(n.errors).toEqual([]);
});

it("applies persisted accessibility and accent preferences", async () => {
  const m = mount({ "loomPref:motion": "reduce", "loomPref:textsize": "xl", "loomPref:accent": "violet" }); await ready(m);
  expect(m.doc.documentElement.classList.contains("reduced-motion")).toBe(true);
  expect(m.doc.documentElement.style.getPropertyValue("--tz")).toBe("1.16");
  expect(m.doc.documentElement.style.getPropertyValue("--thread")).toBe("#c4b5fd");
  await command(m, "Keyboard shortcuts"); m.click('[data-sec="preferences"]'); m.click('[data-seg="motion"] [data-val="system"]');
  expect(m.doc.documentElement.classList.contains("reduced-motion")).toBe(false); expect(m.errors).toEqual([]);
});

it("follows another window's selection without republishing it", async () => {
  const m = mount(); await ready(m);
  const eventValue = JSON.stringify({ project: other, chat: otherChat, nonce: 1 });
  m.w.dispatchEvent(new m.w.StorageEvent("storage", { key: "loomSelection:v1", newValue: eventValue }));
  await waitUntil(() => m.w.location.hash === `#p/${other}`); await ready(m);
  expect(JSON.parse(m.w.localStorage.getItem("loomSelection:v1")!).project).toBe(pid);
  await waitUntil(() => m.doc.querySelector(".crow.cur")?.getAttribute("data-chat") === otherChat);
  const reopened = mount(m.saved(), ""); await ready(reopened);
  await waitUntil(() => reopened.doc.querySelector(".crow.cur")?.getAttribute("data-chat") === otherChat);
  const pane = mount({}, `?pane=independent#p/${pid}`); await ready(pane);
  pane.w.dispatchEvent(new pane.w.StorageEvent("storage", { key: "loomSelection:v1", newValue: eventValue }));
  expect(pane.w.location.hash).toBe(`#p/${pid}`);
  expect(m.errors).toEqual([]); expect(reopened.errors).toEqual([]); expect(pane.errors).toEqual([]);
});

it("creates a task from the empty Board and records its real toast across reloads", async () => {
  const old = Array.from({ length: 100 }, (_, i) => ({ text: `old-${i}`, at: Date.now() - i }));
  const m = mount({ "loomNotifications:v1": JSON.stringify(old) }); await ready(m); m.click('[data-tab="board"]');
  await waitUntil(() => !!m.doc.querySelector('[data-add="working"]'));
  expect(m.doc.querySelector('[data-add="working"]')!.textContent).toBe("+ Add task");
  m.click('[data-add="working"]');
  const title = m.doc.querySelector<HTMLTextAreaElement>("#bmtitle")!;
  title.value = "r3 empty board action"; title.dispatchEvent(new m.w.Event("input", { bubbles: true }));
  m.click("#bmcreate");
  await waitUntil(() => !m.doc.querySelector("#bmtitle") && !!m.w.localStorage.getItem("loomNotifications:v1"));
  const history = JSON.parse(m.w.localStorage.getItem("loomNotifications:v1")!);
  expect(history).toHaveLength(100);
  expect(history.some((r: { text: string }) => r.text === "old-99")).toBe(false);
  expect(history[0]).toMatchObject({ project: pid, chat: "main", text: expect.any(String) });
  const n = mount(m.saved()); await ready(n); await command(n, "Notification history");
  expect(n.doc.querySelector("[data-history]")!.textContent).toContain(history[0].text);
  expect(n.doc.querySelector("[data-history]")!.textContent).not.toContain("Cannot read");
  n.click('[data-open-notification="0"]'); await waitUntil(() => !n.doc.querySelector('.scrim'));
  expect(m.errors).toEqual([]); expect(n.errors).toEqual([]);
});

it("keeps the existing Team create/join actions and resets disabled shortcuts", async () => {
  const m = mount(); await ready(m); m.click('[data-tab="team"]');
  await waitUntil(() => !!m.doc.querySelector('[data-tjoin]'));
  expect(m.doc.querySelector('#fteam')!.textContent).toMatch(/Join|Sign in/);
  await command(m, "Keyboard shortcuts");
  const input = m.doc.querySelector<HTMLInputElement>('[data-shortcut="palette"]')!;
  input.dispatchEvent(new m.w.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  expect(JSON.parse(m.w.localStorage.getItem("loomShortcuts:v1")!).palette).toBe("");
  m.click('#shortcut-reset'); expect(m.w.localStorage.getItem("loomShortcuts:v1")).toBeNull();
  m.click('#sclose'); await palette(m); expect(m.errors).toEqual([]);
});

it("offers agent setup for an empty roster", async () => {
  const empty = (await client.addProject(makeProjectDir({ name: "r3 no agents", agents: [] }))).project.id;
  const m = mount({}, `#p/${empty}`); await ready(m);
  m.click('[data-tab="fleet"]'); await waitUntil(() => !!m.doc.querySelector('#fleet-start'));
  expect(m.doc.querySelector('#fleet-start')!.textContent).toBe('Set up agents');
  expect(m.errors).toEqual([]);
});

it("records shifted punctuation by its base key and ignores corrupt bindings", async () => {
  const m = mount({ "loomShortcuts:v1": '{"palette":"j"}' }); await ready(m);
  await command(m, "Keyboard shortcuts");
  const input = m.doc.querySelector<HTMLInputElement>('[data-shortcut="palette"]')!;
  input.dispatchEvent(new m.w.KeyboardEvent("keydown", { key: ">", code: "Period", ctrlKey: true, shiftKey: true, bubbles: true }));
  expect(m.doc.querySelector('#shortcut-error')!.textContent).toContain('Already used');
  input.dispatchEvent(new m.w.KeyboardEvent("keydown", { key: ":", code: "Semicolon", ctrlKey: true, shiftKey: true, bubbles: true }));
  m.click('#sclose'); m.key(':', { code: 'Semicolon', shiftKey: true });
  expect(m.doc.querySelector('#pq')).toBeTruthy(); expect(m.errors).toEqual([]);
});
