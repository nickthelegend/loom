import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { writeModelRouting } from "../src/core/model-routing.js";
import { costSettings, priceOverrides } from "../src/core/cost-r4/settings.js";
import { listFleets } from "../src/core/fleets.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, base: string, token: string, pid: string, dir: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  token = readDaemonConfig()!.adminToken;
  writeModelRouting({ aliases: { cheap: "echo-a" }, caps: {}, mondayDigest: false });
  dir = makeProjectDir({ name: "r4 costs", agents: [{ id: "echo", kind: "echo", role: "general" }] });
  pid = (await new DaemonClient(readDaemonConfig()!).addProject(dir)).project.id;
  const rt = await daemon.runtime(pid);
  rt.log.append({ kind: "run_complete", agentId: "echo", chat: "main", payload: { model: "echo-a", costUsd: 0.2, inputTokens: 100000, cachedInputTokens: 50000 } });
});
afterAll(async () => { await daemon.close(); });
// The same small real-daemon mount as app-orchestra-dom, with browser-only capabilities supplied.
function mount() {
  let closed = false;
  const sockets: WebSocket[] = [], errors: string[] = [], downloads: Blob[] = [], costRequests: number[] = [];
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
        if (pathname.endsWith("/costs/settings") && (!init?.method || init.method === "GET")) costRequests.push(Date.now());
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
  return { $, click, value, errors, downloads, costRequests, window: dom.window, close() { closed = true; sockets.forEach(s => s.terminate()); dom.window.close(); } };
}

it("edits price overrides, monthly and alert settings in Models; sets a chat cap and re-prices its tokens", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.$('#box[data-bound="1"]'));
    if (!m.$("#sclose")) m.click("#setupbtn");
    await waitUntil(() => !!m.$('[data-sec="models"]')); m.click('[data-sec="models"]');
    await waitUntil(() => !!m.$('[data-r4="prices-save"]') && !!m.$('[data-r4="budget-save"]'));
    m.value('[data-r4="prices"]', '{"echo-a":{"in":2,"out":4,"cacheRead":0.5}}'); m.click('[data-r4="prices-save"]');
    await waitUntil(() => priceOverrides()["echo-a"]?.in === 2);
    m.value('[data-r4="month"]', "5"); m.value('[data-r4="alias"]', "cheap"); m.click('[data-channel="push"]'); m.click('[data-r4="budget-save"]');
    await waitUntil(() => costSettings(dir).monthlyUsd === 5);
    expect(costSettings(dir)).toMatchObject({ alerts: ["push"], saver: { alias: "cheap", share: 0.8 } });
    m.click('#sclose');
    await waitUntil(() => !!m.$('[data-r4="chat-cap"]'));
    m.value('[data-r4="chat-cap"]', '0.1'); m.click('[data-r4="raise"]');
    await waitUntil(() => !!m.$('[data-cost-panel="chat"] [role="alert"]'));
    expect(m.$('[data-cost-panel="chat"]')!.textContent).toContain('Needs you');
    m.value('[data-r4="chat-cap"]', '2'); m.click('[data-r4="raise"]');
    await waitUntil(() => !m.$('[data-cost-panel="chat"] [role="alert"]'));
    m.value('[data-r4="what-model"]', 'echo-a'); m.click('[data-r4="whatif"]');
    await waitUntil(() => !!m.$('[data-what-result]')?.textContent?.includes('$0.1250'));
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});

it("downloads grouped cost CSV in Usage, shows cache savings and compares models from the picker", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.$('#box[data-bound="1"]'));
    if (m.$('#sclose')) m.click('#sclose');
    m.click('[data-tab="observatory"]');
    await waitUntil(() => !!m.$('[data-obv="usage"]')); m.click('[data-obv="usage"]');
    await waitUntil(() => !!m.$('[data-r4="download"]'));
    expect(m.$('[data-cost-panel="usage"]')!.textContent).toContain('50% cached');
    expect(m.$('progress[aria-label="Monthly project budget"]')).toBeTruthy();
    m.value('[data-r4="by"]', 'chat'); m.click('[data-r4="download"]');
    await waitUntil(() => m.downloads.length === 1);
    m.click('[data-tab="thread"]'); m.click('#modelpick');
    await waitUntil(() => !!m.$('[data-r4="compare"]'));
    m.value('[data-r4="models"]', 'echo-a,<svg>'); m.click('[data-r4="compare"]');
    await waitUntil(() => !!m.$('[data-comparison] table'));
    expect(m.$('[data-comparison]')!.textContent).toContain('unknown'); expect(m.$('[data-comparison] svg')).toBeNull();
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});

it("suggests a fleet with reasons from the fleet editor and saves it for reuse", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.$('#box[data-bound="1"]'));
    if (m.$('#sclose')) m.click('#sclose');
    m.click('#cmode [data-cmode="orch"]');
    await waitUntil(() => !!m.$('#cowfleetadd')); m.click('#cowfleetadd');
    await waitUntil(() => !!m.$('[data-r4="suggest"]'));
    m.value('[data-r4="goal"]', 'Review the code'); m.value('[data-r4="size"]', '2'); m.click('[data-r4="suggest"]');
    await waitUntil(() => !!m.$('[data-r4="save-fleet"]'));
    expect(m.$('[data-picks]')!.textContent).toContain('100% finished');
    m.click('[data-r4="save-fleet"]'); await waitUntil(() => listFleets().some(f => f.name === 'suggested'));
    expect(listFleets()[0]?.spec).toBe('echo@echo-a,echo@echo-a');
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});


it("keeps chat panel edits and what-if results across streaming, fetching only on spend at most once a second", async () => {
  const m = mount(), rt = await daemon.runtime(pid);
  try {
    await waitUntil(() => !!m.$('[data-r4="chat-cap"]'));
    if (m.$('#sclose')) m.click('#sclose');
    const panel = m.$('[data-cost-panel="chat"]')!, details = panel.querySelectorAll('details')[1]!;
    details.open = true;
    m.value('[data-r4="what-model"]', 'echo-a'); m.click('[data-r4="whatif"]');
    await waitUntil(() => !!m.$('[data-what-result]')?.textContent);
    const result = m.$('[data-what-result]')!.textContent;
    m.value('[data-r4="chat-cap"]', '42'); m.$('#box')?.focus();
    // Initial history can arrive after the first settings response; let that
    // one debounced reconciliation finish before measuring live streaming.
    await new Promise(r => setTimeout(r, 1200));
    const before = m.costRequests.length;
    for (let i = 0; i < 50; i++) rt.log.append({ kind: "message", chat: "main", agentId: "echo", payload: { text: `stream-${i}` } });
    await waitUntil(() => !!m.$('#feed')?.textContent?.includes('stream-49'));
    await new Promise(r => setTimeout(r, 1100));
    expect(m.costRequests).toHaveLength(before);
    for (let i = 0; i < 20; i++) rt.log.append({ kind: "status", chat: "main", agentId: "echo", payload: { state: "turn_cost", costUsd: 0.001 } });
    await waitUntil(() => m.costRequests.length > before);
    await new Promise(r => setTimeout(r, 1100));
    expect(m.costRequests.length - before).toBeLessThanOrEqual(2);
    for (let i = before + 1; i < m.costRequests.length; i++) expect(m.costRequests[i]! - m.costRequests[i - 1]!).toBeGreaterThanOrEqual(990);
    expect(m.$('[data-cost-panel="chat"]')).toBe(panel); expect(details.open).toBe(true);
    expect((m.$('[data-r4="chat-cap"]') as HTMLInputElement).value).toBe('42');
    expect((m.$('[data-r4="what-model"]') as HTMLInputElement).value).toBe('echo-a');
    expect(m.$('[data-what-result]')!.textContent).toBe(result);
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
