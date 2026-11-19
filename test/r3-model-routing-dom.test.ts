import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { readModelRouting, writeModelRouting } from "../src/core/model-routing.js";
import { setPriceBook } from "../src/core/prices.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, base: string, token: string, pid: string, dir: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken;
  writeModelRouting({ aliases: { fast: "echo-1" }, caps: {}, mondayDigest: false });
  dir = makeProjectDir({ name: "r3 models", agents: [{ id: "echo", kind: "echo", role: "general", options: { model: "fast" } }] });
  pid = (await new DaemonClient(readDaemonConfig()!).addProject(dir)).project.id;
  setPriceBook({ at: Date.now(), models: { "echo-1": { in: 0.00001, out: 0.00002 } } });
  fs.writeFileSync(path.join(process.env.LOOM_HOME!, "model-health.json"), JSON.stringify([{ model: "echo-1", latencyMs: 12, checkedAt: Date.now(), ok: false, lastError: '<svg onload="bad()">' }]));
});
afterAll(async () => { await daemon.close(); setPriceBook(undefined); });

// The same small real-daemon mount as app-orchestra-dom, with browser-only capabilities supplied.
function mount() {
  let closed = false;
  const sockets: WebSocket[] = [], errors: string[] = [], downloads: Blob[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (e: unknown) => errors.push(String(e)));
  const never = new Promise<Response>(() => {});
  const dom = new JSDOM(APP_HTML, { url: `${base}/app#p/${pid}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {}; window.HTMLElement.prototype.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        // Setup is unrelated to routing and probes installed CLIs; keep this mount offline.
        const pathname = new URL(String(input), base).pathname;
        if (pathname === "/api/setup") return Promise.resolve(new Response(JSON.stringify({ agents: [], providers: [], tools: [], platform: process.platform })));
        if (pathname === "/api/setup/requirements") return Promise.resolve(new Response(JSON.stringify({ error: "not used in this test" }), { status: 503 }));
        return fetch(new URL(String(input), base), init).then(r => closed ? never : r);
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", token); window.localStorage.setItem("loomDevMode", "1");
      window.URL.createObjectURL = ((blob: Blob) => { downloads.push(blob); return "blob:r3"; }) as typeof window.URL.createObjectURL;
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = () => {};
      window.confirm = () => true;
    } });
  const $ = (q: string) => dom.window.document.querySelector(q) as HTMLElement | null;
  const click = (q: string) => { const el = $(q); if (!el) throw new Error(`missing ${q}`); el.click(); };
  const value = (q: string, text: string) => { const el = $(q) as HTMLInputElement; el.value = text; el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return { $, click, value, errors, downloads, window: dom.window, close() { closed = true; sockets.forEach(s => s.terminate()); dom.window.close(); } };
}

it("r3 Settings saves aliases, caps, effort and options, surfaces validation, and escapes health errors", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.$('#box[data-bound="1"]'));
    if (!m.$("#sclose")) m.click("#setupbtn");
    await waitUntil(() => !!m.$('[data-sec="models"]'));
    m.click('[data-sec="models"]');
    await waitUntil(() => !!m.$("#mrsave") && !!m.$("#mrsaveagent"));
    expect(m.$("#mrhealth")!.textContent).toContain('<svg onload="bad()">');
    expect(m.$("#mrhealth svg")).toBeNull();
    m.value("#mraliases", '{"fast":"echo-1","cheap":"echo-2"}');
    m.value("#mrcaps", '{"fast":{"usd":2,"tokens":100000}}');
    m.click("#mrmonday"); m.click("#mrsave");
    await waitUntil(() => m.$("#mrstatus")!.textContent!.includes("saved"));
    expect(readModelRouting()).toMatchObject({ aliases: { cheap: "echo-2" }, caps: { "echo-1": { usd: 2, tokens: 100000 } }, mondayDigest: true });
    const effort = m.$("#mreffort") as HTMLSelectElement; effort.value = "high"; effort.dispatchEvent(new m.window.Event("change", { bubbles: true }));
    await waitUntil(() => readProjectConfig(dir)?.defaultEffort === "high");
    await waitUntil(() => (m.$("#mrargs") as HTMLTextAreaElement).value === "[]");
    m.value("#mrargs", '[42]'); m.click("#mrsaveagent");
    await waitUntil(() => m.$("#mrprojectstatus")!.textContent!.includes("extraArgs"));
    expect(readProjectConfig(dir)!.agents[0]!.options?.extraArgs).toBeUndefined();
    m.value("#mrargs", '["--label","two words"]'); m.click("#mrsaveagent");
    await waitUntil(() => m.$("#mrprojectstatus")!.textContent!.includes("Agent options saved"));
    expect(readProjectConfig(dir)!.agents[0]!.options?.extraArgs).toEqual(["--label", "two words"]);
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});

it("r3 composer shows a price estimate and scoreboard supplies digest and CSV download", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.$('#box[data-bound="1"]'));
    if (m.$("#sclose")) m.click("#sclose");
    m.value("#box", "Estimate this message");
    await waitUntil(() => !!m.$("#ctok")?.textContent?.includes("~$"));
    expect(m.$("#ctok")!.textContent).toContain("input tokens");
    m.click('#cmode [data-cmode="orch"]');
    await waitUntil(() => !!m.$('#corch [data-scoreboard]'));
    if (m.$("#sclose")) m.click("#sclose");
    m.click('#corch [data-scoreboard]');
    await waitUntil(() => !!m.$("#sbdigest"));
    m.click("#sbdigest");
    await waitUntil(() => !!m.$("#sbtable")?.textContent?.includes("Weekly scoreboard"));
    m.click("#sbcsv");
    await waitUntil(() => m.downloads.length === 1);
    expect(m.downloads[0]!.type).toBe("text/csv;charset=utf-8");
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
