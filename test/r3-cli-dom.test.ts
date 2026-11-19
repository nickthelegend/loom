import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, writeDaemonConfig } from "../src/core/registry.js";
import { ADES } from "../src/core/ades.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, project: string, dir: string;
const originalAdes = [...ADES];
const mounted: Array<() => void> = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  ADES.splice(0, ADES.length, { kind: "echo", label: "Echo", tier: "adapter", probe: async () => true });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  writeDaemonConfig({ ...readDaemonConfig()!, projectsRoot: tmpDir("r3-dom-projects") });
  client = new DaemonClient(readDaemonConfig()!);
  dir = makeProjectDir({ name: "r3 DOM", agents: [{ id: "solo", kind: "echo", role: "worker" }] });
  project = (await client.addProject(dir)).project.id;
});
afterEach(() => { while (mounted.length) mounted.pop()!(); });
afterAll(async () => { await daemon?.close(); ADES.splice(0, ADES.length, ...originalAdes); });

// The real bundled page, REST API and websocket, with only missing browser capabilities supplied.
function mount() {
  const errors: string[] = [], sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const vc = new VirtualConsole(); vc.on("jsdomError", (e: Error) => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, {
    url: `${client.baseUrl}/app#p/${project}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
      w.matchMedia = ((q: string) => ({ matches: q.includes("min-width"), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as any;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(input, client.baseUrl), init).then(r => closed ? never : r)) as any;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as any;
      w.localStorage.setItem("loomClientToken", readDaemonConfig()!.adminToken);
      w.localStorage.setItem("loomSetupSeen", "1"); w.localStorage.setItem("loomDevMode", "1");
      w.confirm = () => true;
    },
  });
  mounted.push(() => { closed = true; for (const socket of sockets) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); } dom.window.close(); });
  const find = (selector: string) => dom.window.document.querySelector(selector) as HTMLElement | null;
  const click = (selector: string) => { const el = find(selector); expect(el, selector).toBeTruthy(); el!.click(); };
  const fill = (selector: string, value: string) => { const el = find(selector) as HTMLInputElement; el.value = value; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return { dom, errors, find, click, fill };
}

it("validates a malformed disk edit from project settings and escapes diagnostic text", async () => {
  const m = mount();
  await waitUntil(() => !!m.find(`[data-pset="${project}"]`));
  m.click(`[data-pset="${project}"]`);
  await waitUntil(() => !!m.find("#psvalidate"));
  const file = path.join(dir, ".loom/config.json"), original = fs.readFileSync(file, "utf8");
  try {
    fs.writeFileSync(file, JSON.stringify({ name: "test", agents: [], defaultAgent: "<img src=x onerror=alert(1)>" }));
    m.click("#psvalidate");
    await waitUntil(() => !!m.find("#psvalidation")?.textContent?.includes("defaultAgent"));
    expect(m.find("#psvalidation")?.textContent).toContain("invalid");
    expect(m.find("#psvalidation img")).toBeNull();
  } finally { fs.writeFileSync(file, original); }
  m.click("#psvalidate");
  await waitUntil(() => m.find("#psvalidation")?.textContent === ".loom/config.json is valid");
  expect(m.errors).toEqual([]);
});

it("creates a starter project through the form using an echo agent", async () => {
  const m = mount();
  await waitUntil(() => !!m.find("#newproj")); m.click("#newproj");
  await waitUntil(() => !!m.find('#nptemplate option[value="library"]'));
  expect(m.find("#nptemplate")?.textContent).toContain("web");
  m.fill("#npname", "Template DOM");
  (m.find("#nptemplate") as HTMLSelectElement).value = "library";
  await waitUntil(() => !!m.find('[data-np-on]'));
  m.click('[data-np-on]');
  m.click("#pcreate");
  let created: Awaited<ReturnType<DaemonClient["listProjects"]>>["projects"][number] | undefined;
  await waitUntil(async () => { created = (await client.listProjects()).projects.find(p => p.name === "Template DOM"); return !!created; });
  expect(fs.readFileSync(path.join(created!.dir, "index.js"), "utf8")).toContain("greet");
  expect(m.errors).toEqual([]);
});

it("manages persisted aliases from Settings with literal, escaped command arguments", async () => {
  const m = mount();
  await waitUntil(() => !!m.find("#setupbtn")); m.click("#setupbtn"); m.click('[data-sec="aliases"]');
  await waitUntil(() => !!m.find("#aliassave"));
  m.fill("#aliasname", "dom-review"); m.fill("#aliasargs", 'send\n<img src=x onerror=alert(1)>\n--wait'); m.click("#aliassave");
  await waitUntil(() => !!m.find('[data-alias-rm="dom-review"]'));
  expect((await client.aliases()).aliases["dom-review"]).toEqual(["send", "<img src=x onerror=alert(1)>", "--wait"]);
  expect(m.find("#aliasrows img")).toBeNull();
  m.click('[data-alias-rm="dom-review"]');
  await waitUntil(async () => !(await client.aliases()).aliases["dom-review"]);
  expect(m.errors).toEqual([]);
});
