import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, pid: string, token: string;
const live: Array<ReturnType<typeof mount>> = [];
const rest = async (route: string, method = "GET", body?: unknown) => {
  const r = await fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(await r.text()); return r.json();
};
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r3-chat-dom")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  pid = (await client.addProject(makeProjectDir({ name: "Composer" }))).project.id;
});
afterEach(() => { while (live.length) live.pop()!.close(); });
afterAll(async () => { await daemon.close(); vi.unstubAllEnvs(); });

/** The real inlined page and daemon; only browser capabilities missing from jsdom are supplied. */
function mount(chat: string, seen?: number) {
  const errors: string[] = [], copied: string[] = [], scrolled: string[] = [], sockets: WebSocket[] = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message)); vc.on("error", e => errors.push(String(e)));
  let closed = false;
  const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, {
    url: `${client.baseUrl}/app#p/${pid}/c/${chat}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = function(){ scrolled.push(this.className); };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), client.baseUrl), init).then(r => closed ? never : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
      w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1"); w.localStorage.setItem("loomSetupSeen", "1"); w.localStorage.setItem("loomTourDone", "1");
      w.localStorage.setItem(`loomChat:${pid}`, chat);
      if (seen !== undefined) w.localStorage.setItem("loomSeen", JSON.stringify({ [`${pid}:${chat}`]: seen }));
      w.confirm = () => true;
    },
  });
  const m = { w: dom.window, errors, copied, scrolled, close: () => {
    closed = true; sockets.forEach(s => { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); }); dom.window.close();
  } };
  live.push(m); return m;
}
type Mounted = ReturnType<typeof mount>;
const $ = (m: Mounted, sel: string) => m.w.document.querySelector(sel);
const click = (m: Mounted, el: Element | null) => { expect(el).toBeTruthy(); el!.dispatchEvent(new m.w.MouseEvent("click", { bubbles: true })); };
const menuItem = (m: Mounted, name: string) => Array.from(m.w.document.querySelectorAll('.menuitem')).find(e => e.textContent?.trim() === name) ?? Array.from(m.w.document.querySelectorAll('[role="menuitem"]')).find(e => e.textContent?.includes(name));
async function action(m: Mounted, id: number, name: string) {
  await waitUntil(() => !!$(m, `.msg[data-id="${id}"] .msgmore`));
  click(m, $(m, `.msg[data-id="${id}"] .msgmore`));
  await waitUntil(() => !!menuItem(m, name)); click(m, menuItem(m, name)!);
}
async function seeded(text = "**Markdown** with `code`") {
  const { chat } = await client.createChat(pid, "Batch chat", { agentId: "execbot" });
  await client.send(pid, text, undefined, { chat: chat.id });
  await waitUntil(async () => (await client.chatEvents(pid, chat.id)).events.some(e => e.kind === "run_complete"));
  const events = (await client.chatEvents(pid, chat.id)).events;
  return { chat, events, message: events.find(e => e.payload.author === "user")! };
}

it("pins and bookmarks messages, copies source Markdown and inserts a linked quote", async () => {
  const { chat, message } = await seeded(); const m = mount(chat.id);
  await waitUntil(() => !!$(m, `.msg[data-id="${message.id}"] .msgmore`));
  await action(m, message.id, "Pin message");
  await waitUntil(() => !!$(m, '#chat-pins [data-pin]'));
  expect($(m, '#chat-pins')!.textContent).toContain("Markdown");
  await action(m, message.id, "Bookmark");
  await waitUntil(async () => (await client.bookmarks(pid)).bookmarks.some(b => b.event.id === message.id));
  await action(m, message.id, "Copy as Markdown");
  await waitUntil(() => m.copied.length > 0); expect(m.copied[0]).toBe(message.payload.text);
  await action(m, message.id, "Quote reply");
  await waitUntil(() => ($(m, '#box') as HTMLTextAreaElement).value.includes("Reply to message"));
  expect(($(m, '#box') as HTMLTextAreaElement).value).toContain("> **Markdown** with `code`");
  click(m, $(m, '#morebtn'));
  await waitUntil(() => !!menuItem(m, 'Copy chat as Markdown'));
  click(m, menuItem(m, 'Copy chat as Markdown')!);
  await waitUntil(() => m.copied.length === 2);
  expect(m.copied[1]).toContain('## You'); expect(m.copied[1]).toContain('**Markdown** with `code`');
  m.w.document.dispatchEvent(new m.w.KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }));
  await waitUntil(() => !!$(m, '#pq'));
  const search = $(m, '#pq') as HTMLInputElement; search.value = 'Bookmarks'; search.dispatchEvent(new m.w.Event('input', { bubbles: true }));
  await waitUntil(() => Array.from(m.w.document.querySelectorAll('.prow')).some(e => e.textContent?.includes('Bookmarks')));
  click(m, Array.from(m.w.document.querySelectorAll('.prow')).find(e => e.textContent?.includes('Bookmarks'))!);
  await waitUntil(() => !!$(m, '#loommenu')?.textContent?.includes('Batch chat'));
  expect(m.errors).toEqual([]);
});

it("restores daemon drafts, asks for template variables, and keeps tool folds and totals", async () => {
  const { chat, events } = await seeded("run: echo details");
  const base = `/api/projects/${pid}/chats/${chat.id}`;
  await rest(base + '/draft', 'PUT', { draft: 'from phone', revision: 0 });
  await client.saveTemplate('review', 'Review {{file}} for {{topic}}');
  const m = mount(chat.id);
  await waitUntil(() => ($(m, '#box') as HTMLTextAreaElement)?.value === 'from phone');
  const box = $(m, '#box') as HTMLTextAreaElement;
  box.value = '/template review'; box.dispatchEvent(new m.w.Event('input', { bubbles: true }));
  $(m, '#cform')!.dispatchEvent(new m.w.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => !!$(m, '.template-form'));
  const fields = m.w.document.querySelectorAll('.template-form input'); expect(fields).toHaveLength(2);
  (fields[0] as HTMLInputElement).value = '<unsafe>.ts'; (fields[1] as HTMLInputElement).value = '$& bugs';
  $(m, '.template-form')!.dispatchEvent(new m.w.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => box.value === 'Review <unsafe>.ts for $& bugs');
  await waitUntil(async () => (await rest(base + '/draft')).draft === box.value);
  const tool = events.find(e => e.kind === 'tool_call')!;
  click(m, $(m, `.tool[data-event-id="${tool.id}"]`));
  await waitUntil(async () => (await rest(base + '/presentation')).expanded[tool.id] === true);
  expect($(m, '#chat-totals')!.textContent).toContain('1 turns');
  const second = mount(chat.id);
  await waitUntil(() => !!$(second, `.tool[data-event-id="${tool.id}"].open`));
  expect(($(second, '#box') as HTMLTextAreaElement).value).toBe('Review <unsafe>.ts for $& bugs');
  expect([...m.errors, ...second.errors]).toEqual([]);
});

it("opens at the first unread reply with a divider", async () => {
  const { chat, message } = await seeded();
  for (let i = 0; i < 18; i++) {
    await client.send(pid, 'Later turn ' + i, undefined, { chat: chat.id });
    await waitUntil(async () => (await client.chatEvents(pid, chat.id, { limit: 1000 })).events.filter(e => e.kind === 'run_complete').length === i + 2);
  }
  const all = (await client.chatEvents(pid, chat.id, { limit: 1000 })).events;
  expect(all.length).toBeGreaterThan(80);
  const m = mount(chat.id, message.id);
  await waitUntil(() => !!$(m, '.unread-divider'));
  expect($(m, '.unread-divider')!.nextElementSibling!.getAttribute('data-id')).toBe(String(all.find(e => e.kind === 'message' && e.agentId)!.id));
  expect(m.scrolled).toContain('unread-divider'); expect(m.errors).toEqual([]);
});
