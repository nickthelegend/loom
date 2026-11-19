import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let id: string;
let rt: ProjectRuntime;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-queue-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen();
  baseUrl = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  id = (await client.addProject(makeProjectDir({ agents: [{ id: "echo", kind: "echo" }] }))).project.id;
  rt = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(id);
});
afterAll(async () => { await daemon?.close(); });

// The inlined page, live HTTP and WebSocket connections, and browser shims used by app-orchestra-dom.
function mount(chat: string) {
  const errors: string[] = [];
  const sockets: WebSocket[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => errors.push(error.message));
  virtualConsole.on("error", (error: string) => errors.push(String(error)));
  let closed = false;
  const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app#p/${id}/c/${chat}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => closed ? never :
        fetch(new URL(String(input), baseUrl), init).then(r => closed ? never : r)) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", token);
      window.confirm = () => true;
    },
  });
  return { document: dom.window.document, errors, close() {
    closed = true;
    for (const socket of sockets) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); }
    dom.window.close();
  } };
}

it("shows a refused prompt, resumes it once, and holds a follow-up after chat Stop", async () => {
  const chat = rt.createChat("queue recovery").id;
  const page = mount(chat);
  const find = (selector: string) => page.document.querySelector(selector) as HTMLElement | null;
  try {
    await waitUntil(() => !!find('#box[data-bound="1"]'));
    rt.baton.acquire("echo");
    rt.log.append({ kind: "status", agentId: "echo", payload: { state: "turn_cost", costUsd: 2 } });
    rt.setBudget("echo", 1);
    await client.queueAdd(id, { text: "retained <prompt>", target: "echo", chat });
    await waitUntil(() => find('#cqueue [data-q="pause"]')?.textContent === "Resume");
    expect(find("#cqueue .cqtext")?.textContent).toBe("retained <prompt>");
    expect(find("#cqueue .cqwait")?.textContent).toMatch(/wasn't sent/);
    rt.setBudget("echo", 10);
    find('#cqueue [data-q="pause"]')!.click();
    await waitUntil(() => rt.log.list({ chat, kinds: ["message"] }).some(e => e.agentId && String(e.payload.text).includes("retained <prompt>")));
    expect(rt.log.list({ chat, kinds: ["message"] }).filter(e => e.agentId && String(e.payload.text).includes("retained <prompt>"))).toHaveLength(1);
    await rt.sendMessage("sleep:5000 work", "echo", { chat });
    await client.queueAdd(id, { text: "after Stop", target: "echo", chat });
    await waitUntil(() => find("#stop")?.style.display !== "none" && !!find("#cqueue .cqitem"));
    find("#stop")!.click();
    await waitUntil(() => find('#cqueue [data-q="pause"]')?.textContent === "Resume");
    expect(find("#cqueue .cqwait")?.textContent).toMatch(/Stop/);
    expect(rt.queue.snapshot().items.map(item => item.text)).toEqual(["after Stop"]);
    expect(page.errors).toEqual([]);
  } finally { page.close(); }
});
