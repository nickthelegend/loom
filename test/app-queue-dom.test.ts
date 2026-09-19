/**
 * The prompt queue in the web app, actually executed.
 *
 * Same harness as app-dom.test.ts — the real APP_HTML in jsdom, against a real
 * daemon on an ephemeral port. The agent is `echo`, so a turn really is busy
 * for as long as the prompt says, which is the whole point here: what you type
 * while it's working lines up in the composer, stays editable, and goes when
 * the turn ends.
 */

import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let clientToken: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-queue-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;

  const dir = makeProjectDir({ name: "lineup", agents: [{ id: "echo", kind: "echo" }, { id: "other", kind: "echo" }] });
  const client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(dir)).project.id;
  const { token } = await client.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

interface QueueView {
  queue: Array<{ id: string; text: string; target: { kind: string; agentId?: string } }>;
  paused: boolean;
  waitingFor?: string;
}

async function rest<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}${p}`, {
    method,
    headers: { Authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const live: Mounted[] = [];
afterEach(async () => {
  while (live.length) live.pop()!.close();
  await rest("DELETE", "/queue");
});
afterAll(async () => {
  await daemon.close();
});

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  close: () => void;
}

function mount(): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app#p/${projectId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({
        matches: /min-width/.test(q),
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        return fetch(new URL(String(input), baseUrl), init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", clientToken);
      window.confirm = () => true;
    },
  });

  const m: Mounted = {
    window: dom.window,
    errors,
    close: () => {
      closed = true;
      for (const s of sockets) {
        try {
          s.removeAllListeners();
          s.on("error", () => {});
          s.terminate();
        } catch {
          /* already gone */
        }
      }
      dom.window.close();
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const all = (m: Mounted, sel: string) => [...m.window.document.querySelectorAll(sel)];
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(
    new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }),
  );
};
const box = (m: Mounted) => $(m, "#box") as HTMLTextAreaElement;

/** Type into the composer and send, the way a person does. */
function type(m: Mounted, s: string) {
  const b = box(m);
  b.value = s;
  b.dispatchEvent(new m.window.Event("input", { bubbles: true }));
}
async function sendPrompt(m: Mounted, s: string) {
  type(m, s);
  ($(m, "#cform") as HTMLFormElement).dispatchEvent(new m.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitUntil(() => box(m).value === "", { timeoutMs: 10_000 });
}

async function ready(m: Mounted) {
  await waitUntil(() => !!$(m, '#box[data-bound="1"]'), { timeoutMs: 20_000 });
}

describe("web app · the prompt queue", () => {
  it("lines up what you type while an agent is working, and shows who takes it", async () => {
    const m = mount();
    await ready(m);
    await sendPrompt(m, "sleep:2500 working");
    await sendPrompt(m, "second in line");
    await sendPrompt(m, "third in line");

    await waitUntil(() => all(m, "#cqueue .cqitem").length === 2, { timeoutMs: 15_000 });
    expect(text(m, "#cqueue .cqhead")).toContain("Queue · 2");
    expect(all(m, "#cqueue .cqtext").map((e) => e.textContent)).toEqual(["second in line", "third in line"]);
    // the head says what it's waiting for, in the app's own words
    expect(text(m, "#cqueue .cqwait")).toMatch(/waiting for echo/);
    // and the server agrees: nothing was lost, nothing was sent early
    const view = await rest<QueueView>("GET", "/queue");
    expect(view.queue.map((i) => i.text)).toEqual(["second in line", "third in line"]);
    expect(view.queue[0]!.target).toEqual({ kind: "agent", agentId: "echo" });

    // when the turn ends they run in order, and the queue empties itself
    await waitUntil(() => all(m, "#cqueue .cqitem").length === 0, { timeoutMs: 30_000 });
    expect((await rest<QueueView>("GET", "/queue")).queue).toEqual([]);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("edits, reorders, drops and pauses — all before it runs", async () => {
    const m = mount();
    await ready(m);
    await sendPrompt(m, "sleep:6000 working");
    await sendPrompt(m, "one");
    await sendPrompt(m, "two");
    await sendPrompt(m, "three");
    await waitUntil(() => all(m, "#cqueue .cqitem").length === 3, { timeoutMs: 15_000 });

    // edit: click the text, change it, save
    click($(m, "#cqueue .cqitem .cqtext"));
    await waitUntil(() => !!$(m, "#cqueue .cqedit"));
    const edit = $(m, "#cqueue .cqedit") as HTMLTextAreaElement;
    edit.value = "one, edited";
    click($(m, '#cqueue [data-q="save"]'));
    await waitUntil(() => (queuedTexts(m))[0] === "one, edited", { timeoutMs: 10_000 });

    // reorder: send the head down one
    click(all(m, "#cqueue .cqitem")[0]!.querySelector('[data-q="down"]'));
    await waitUntil(() => (queuedTexts(m))[0] === "two", { timeoutMs: 10_000 });
    expect(queuedTexts(m)).toEqual(["two", "one, edited", "three"]);

    // drop the last one
    click(all(m, "#cqueue .cqitem")[2]!.querySelector('[data-q="rm"]'));
    await waitUntil(() => all(m, "#cqueue .cqitem").length === 2, { timeoutMs: 10_000 });

    // and hold the whole queue where it is
    click($(m, '#cqueue [data-q="pause"]'));
    await waitUntil(() => text(m, '#cqueue [data-q="pause"]') === "Resume", { timeoutMs: 10_000 });
    const held = await rest<QueueView>("GET", "/queue");
    expect(held.paused).toBe(true);
    expect(held.queue.map((i) => i.text)).toEqual(["two", "one, edited"]);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("sends a queued prompt to another agent when you change its target", async () => {
    const m = mount();
    await ready(m);
    await sendPrompt(m, "sleep:2000 working");
    await sendPrompt(m, "for someone else");
    await waitUntil(() => all(m, "#cqueue .cqitem").length === 1, { timeoutMs: 15_000 });

    const sel = $(m, '#cqueue [data-q="target"]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["auto", "orchestra", "echo", "other"]);
    sel.value = "other";
    sel.dispatchEvent(new m.window.Event("change", { bubbles: true }));

    await waitUntil(async () => {
      const v = await rest<QueueView>("GET", "/queue");
      return v.queue.length === 0 || v.queue[0]!.target.agentId === "other";
    }, { timeoutMs: 10_000 });
    // it runs on the agent you moved it to, and the baton goes with it
    await waitUntil(async () => {
      const p = await rest<{ project: { holder: string | null } }>("GET", "");
      return p.project.holder === "other";
    }, { timeoutMs: 30_000 });
    expect(m.errors).toEqual([]);
  }, 60_000);
});

/** The queued prompts as the page currently shows them. */
function queuedTexts(m: Mounted): string[] {
  return all(m, "#cqueue .cqtext").map((e) => e.textContent ?? "");
}
