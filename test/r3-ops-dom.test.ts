import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, phone: string, scoped: string, id: string;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom-home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const addr = await daemon.listen(); base = `http://${addr.host}:${addr.port}`;
  client = new DaemonClient(readDaemonConfig()!);
  id = (await client.addProject(makeProjectDir({ name: "Ops <img src=x>" }))).project.id;
  const pair = (projects?: string[]) => {
    const p = daemon["auth"].newPairingToken(projects);
    return daemon["auth"].claim(p.token, "phone")!.clientToken;
  };
  phone = pair(); scoped = pair([id]);
});
const live: Array<{ close: () => void }> = [];
afterEach(() => { for (const m of live.splice(0)) m.close(); vi.unstubAllGlobals(); });
afterAll(async () => { await daemon.close(); });

/** Same small browser-capability harness as app-orchestra-dom, backed by the daemon. */
function mount(token = phone) {
  const errors: string[] = [], sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, {
    url: `${base}/app`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        const url = new URL(String(input), base);
        // Capability discovery isn't under test and must never invoke installed agent CLIs.
        if (url.pathname === "/api/setup") return Promise.resolve(new Response(JSON.stringify({ platform: "linux", node: { ok: true, version: "22" }, ready: true, agents: [], bridges: [], permissions: [] })));
        if (url.pathname.endsWith("/agents/models")) return Promise.resolve(new Response('{"models":[]}'));
        if (url.pathname === "/api/bootstrap") return Promise.resolve(new Response('{"error":"remote phone"}', { status: 403 }));
        return fetch(url, init).then(r => closed ? never : r);
      }) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token);
      w.localStorage.setItem("loomDevMode", "1");
      w.confirm = () => true;
    },
  });
  const doc = dom.window.document;
  const get = (sel: string) => doc.querySelector(sel) as HTMLElement;
  const click = (sel: string) => { const el = get(sel); if (!el) throw new Error(`missing ${sel}`); el.click(); };
  const input = (sel: string, value: string) => { const el = get(sel) as HTMLInputElement; el.value = value; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const m = { doc, get, click, input, errors, close: () => { closed = true; for (const ws of sockets) ws.terminate(); dom.window.close(); } };
  live.push(m);
  return m;
}
async function open(m: ReturnType<typeof mount>, section = "ops") {
  await waitUntil(() => !!m.get("#setupbtn")?.onclick);
  m.click("#setupbtn");
  await waitUntil(() => !!m.get(`#setnav [data-sec="${section}"]`));
  m.click(`#setnav [data-sec="${section}"]`);
  await waitUntil(() => !!m.get(section === "ops" ? "#ops-fix" : "#updcheck"));
}

describe("R3 web operations", () => {
  it("a paired phone saves schedules, applies safe fixes, previews and saves retention", async () => {
    const m = mount(); await open(m);
    await waitUntil(() => !!m.get("#ops-save-backup"));
    expect(m.get("#ops-project").textContent).toContain("Ops <img src=x>");
    expect(m.doc.querySelector("#ops-project img")).toBeNull();
    m.input("#ops-every", "2h"); m.input("#ops-keep", "3"); m.click("#ops-save-backup");
    await waitUntil(async () => (await client.ops()).backup?.every === "2h");
    await waitUntil(() => m.get("#ops-machine").textContent!.includes("Next:"));
    m.click("#ops-fix");
    await waitUntil(() => m.get("#ops-result").textContent!.includes('Remaining failing checks: 0'));
    m.input("#ops-days", "10"); m.input("#ops-runs", "2"); m.click("#ops-policy");
    await waitUntil(() => m.get("#ops-result").textContent!.includes('Saved worktree policy: 10 days'));
    m.click("#ops-preview");
    await waitUntil(() => m.get("#ops-result").textContent!.includes('Dry run: 0 runs'));
    expect((m.get("#ops-prune") as HTMLButtonElement).disabled).toBe(true);
    m.click("#ops-off-backup");
    await waitUntil(async () => (await client.ops()).backup === null);
    expect(m.errors).toEqual([]);
  });
  it("reports a stale echo session and reaps it with one click", async () => {
    await client.send(id, "sleep:55000", "plannerbot");
    await waitUntil(async () => (await client.project(id)).project.agents.some(a => a.busy));
    daemon["runtimes"].get(id)!["turns"].busySince.set("plannerbot", Date.now() - 601_000);
    const m = mount(); await open(m);
    expect(m.get('[data-reap="plannerbot"]')).not.toBeNull();
    m.click('[data-reap="plannerbot"]');
    await waitUntil(() => m.get("#ops-detail").textContent!.includes("No stale sessions"));
    expect((await client.project(id)).project.holder).toBeNull();
    expect(m.errors).toEqual([]);
  });
  it("lets a scoped device use project operations while hiding refused machine controls", async () => {
    const m = mount(scoped); await open(m);
    await waitUntil(() => m.get("#ops-machine").textContent!.includes("unscoped"));
    expect(m.get("#ops-save-backup")).toBeNull();
    m.click("#ops-preview");
    await waitUntil(() => m.get("#ops-result").textContent!.includes('Dry run: 0 runs'));
    expect(m.errors).toEqual([]);
  });
  it("renders all intervening release notes as escaped text", async () => {
    vi.stubGlobal("fetch", ((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/")) return Promise.resolve(new Response(JSON.stringify({ tag_name: "v2.2.0", html_url: "https://github.com/nickthelegend/loom/releases/tag/v2.2.0" })));
      if (u.startsWith("https://raw.githubusercontent.com/")) return Promise.resolve(new Response('## [2.2.0]\n<img src=x onerror="window.bad=1">\n## [2.1.0]\nIntermediate fix\n## [2.0.0]\nOld notes\n'));
      return realFetch(url, init);
    }) as typeof fetch);
    const m = mount(); await open(m, "updates");
    m.click("#updcheck");
    await waitUntil(() => m.get("#setpane").textContent!.includes("Intermediate fix"));
    expect(m.get("#setpane").textContent).toContain('<img src=x onerror="window.bad=1">');
    expect(m.doc.querySelector("#setpane img")).toBeNull();
    expect(m.get("#setpane").textContent).not.toContain("Old notes");
    expect(m.errors).toEqual([]);
  });
});
