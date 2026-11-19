import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { beforeAll, afterAll, it, expect } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { mcpRequest } from "../src/core/mcp-server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, project: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-dom"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  project = (await client.addProject(makeProjectDir({ name: "Tools DOM" }))).project.id;
}, 30_000);
afterAll(async () => { await daemon?.close(); });

function mount() {
  const sockets: WebSocket[] = [], errors: string[] = [];
  let closed = false;
  const never = new Promise<Response>(() => {});
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(APP_HTML, { url: `${client.baseUrl}/app#p/${project}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
      w.matchMedia = ((query: string) => ({ matches: /min-width/.test(query), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as any;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), client.baseUrl), init).then(r => closed ? never : r)) as any;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string[]) { super(url, protocols); sockets.push(this); } } as any;
      w.localStorage.setItem("loomClientToken", readDaemonConfig()!.adminToken);
      w.localStorage.setItem("loomDevMode", "1");
      w.prompt = () => "web-skill"; w.confirm = () => true;
    },
  });
  return { window: dom.window, errors, close() { closed = true; for (const socket of sockets) socket.close(); dom.window.close(); } };
}
it("switches a project tool, shows real call records and toggles hooks from Preferences", async () => {
  const m = mount(), doc = m.window.document;
  const click = (selector: string) => (doc.querySelector(selector) as HTMLElement).click();
  try {
    await waitUntil(() => !!doc.querySelector("#setupbtn")); click("#setupbtn");
    await waitUntil(() => !!doc.querySelector('[data-sec="preferences"]')); click('[data-sec="preferences"]');
    await waitUntil(() => !!doc.querySelector('[data-r4-tool="loom_costs"]'));
    click('[data-r4-tool="loom_costs"]');
    await waitUntil(async () => (await client.api<any>("GET", `/api/projects/${project}/r4/tools`)).disabledTools.includes("loom_costs"));
    await mcpRequest(client, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "loom_costs", arguments: { project } } });
    await waitUntil(() => !(doc.querySelector('[data-r4-tool="loom_costs"]') as HTMLInputElement).disabled);
    click('[data-r4-refresh]');
    await waitUntil(() => !!doc.querySelector('[data-r4-log]')?.textContent?.includes("disabled for this project"));
    expect(doc.querySelector('[data-r4-log]')?.textContent).toContain("owner");
    click('[data-r4-hooks]');
    await waitUntil(async () => (await client.api<any>("GET", `/api/projects/${project}/r4/hooks`)).enabled);
    await client.api("PUT", `/api/projects/${project}/r4/hooks`, { enabled: false });
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
it("offers Save as skill in a finished message menu and creates a draft", async () => {
  await mcpRequest(client, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "loom_send", arguments: { project, text: "Steps to save from the browser", agent: "plannerbot", wait: true } } });
  const m = mount(), doc = m.window.document;
  try {
    await waitUntil(() => !!doc.querySelector('#feed .msg[data-id]'));
    const msg = doc.querySelector('#feed .msg[data-id]')!;
    msg.dispatchEvent(new m.window.MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
    await waitUntil(() => [...doc.querySelectorAll('button')].some(b => b.textContent?.trim() === "Save as skill"));
    ([...doc.querySelectorAll('button')].find(b => b.textContent?.trim() === "Save as skill") as HTMLElement).click();
    await waitUntil(async () => (await client.api<any>("GET", `/api/projects/${project}/skills/catalog`)).skills.some((s: any) => s.id === "web-skill"));
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
