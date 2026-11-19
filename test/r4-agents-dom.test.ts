import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, client: DaemonClient, id: string, chat: string, archived: string, token: string;
const request = async (route: string, body: unknown, method = "PUT") => {
  const r = await fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); expect(r.ok, await r.text()).toBe(true);
};
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r4-dom-home")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  id = (await client.addProject(makeProjectDir({ name: "Sessions" }))).project.id;
  chat = (await client.createChat(id, "Review <script>" )).chat.id; archived = (await client.createChat(id, "Archived history")).chat.id;
  await client.send(id, "deep history phrase", "execbot", { chat: archived });
  await waitUntil(async () => (await client.chatEvents(id, archived)).events.some(e => e.kind === "run_complete"));
  await request(`/api/projects/${id}/chats/${chat}/labels`, { labels: ["bug", "<img src=x>"] });
  await request(`/api/projects/${id}/chats/${archived}`, { archived: true }, "PATCH");
  await request("/api/profiles/test-model", { kind: "model", model: "test/model", instructions: "Be concise" });
  await client.send(id, "Unread evidence", "execbot"); await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.kind === "run_complete"));
});
afterAll(async () => { await daemon?.close(); vi.unstubAllEnvs(); });
function mount() {
  const errors: string[] = [], sockets: WebSocket[] = []; let closed = false;
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message)); vc.on("error", e => errors.push(String(e)));
  const dom = new JSDOM(APP_HTML, { url: `${client.baseUrl}/app#p/${id}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as any;
      const never = new Promise<never>(() => {});
      w.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        if (String(input).includes("/agents/models")) return Promise.resolve(new Response(JSON.stringify({ models: ["test/model"], profiles: [{ name: "test-model", model: "test/model" }] })));
        return fetch(new URL(String(input), client.baseUrl), init).then(r => closed ? never : r);
      }) as any;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as any;
      w.localStorage.setItem(`loomChat:${id}`, "main"); w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1"); w.localStorage.setItem("loomSeen", JSON.stringify({ [id + ":main"]: 0 }));
      w.confirm = () => true; w.prompt = () => "review, docs";
    } });
  return { w: dom.window, errors, q: (s: string) => dom.window.document.querySelector(s) as HTMLElement | null,
    close() { closed = true; sockets.forEach(s => { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); }); dom.window.close(); } };
}
it("filters chat labels and archives, escapes chips, and saves labels from the list", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.q('[data-r4-open]')); m.q('[data-r4-open]')!.click();
    await waitUntil(() => !!m.q(`[data-row="${chat}"]`));
    expect(m.q(`[data-row="${archived}"]`)).toBeNull(); expect(m.q('[data-chats] img')).toBeNull();
    const filter = m.q('[data-filter]') as HTMLSelectElement; filter.value = "bug"; filter.dispatchEvent(new m.w.Event("change", { bubbles: true }));
    expect(m.q('[data-chats]')!.textContent).toContain("Review <script>"); expect(m.q('[data-row="main"]')).toBeNull();
    filter.value = ""; filter.dispatchEvent(new m.w.Event("change", { bubbles: true }));
    m.q(`[data-label="${chat}"]`)!.click(); await waitUntil(() => !!m.q(`[data-row="${chat}"]`)?.textContent?.includes("docs"));
    const archive = m.q('[data-arch]') as HTMLInputElement; archive.checked = true; archive.dispatchEvent(new m.w.Event("change", { bubbles: true }));
    await waitUntil(() => !!m.q(`[data-row="${archived}"]`)); expect(m.q(`[data-row="${chat}"]`)).toBeNull();
    const search = m.q('[data-search]') as HTMLInputElement; search.value = "deep history phrase"; search.dispatchEvent(new m.w.Event("input", { bubbles: true }));
    await waitUntil(() => !!m.q(`[data-row="${archived}"]`));
    m.q(`[data-archive="${archived}"]`)!.click(); await waitUntil(() => !m.q(`[data-row="${archived}"]`));
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
it("edits settings, duplicates a session, and never renders environment values", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.q('[data-r4-open]')); m.q('[data-r4-open]')!.click(); m.q('[data-tab="agents"]')!.click();
    await waitUntil(() => !!m.q('[data-policy="execbot"]'));
    const form = m.q('[data-policy="execbot"]') as HTMLFormElement;
    (form.elements.namedItem("maxTurnMinutes") as HTMLInputElement).value = "7";
    form.dispatchEvent(new m.w.Event("submit", { bubbles: true, cancelable: true }));
    await waitUntil(async () => { const r = await fetch(client.baseUrl + `/api/projects/${id}/session-settings`, { headers: { authorization: `Bearer ${token}` } }); return (await r.json()).agents.execbot?.maxTurnMinutes === 7; });
    const env = m.q('[data-env-form="execbot"]') as HTMLFormElement;
    (env.elements.namedItem("key") as HTMLInputElement).value = "WEB_SECRET"; (env.elements.namedItem("value") as HTMLInputElement).value = "private-ui-value";
    env.dispatchEvent(new m.w.Event("submit", { bubbles: true, cancelable: true }));
    await waitUntil(() => !!m.q('[data-env="execbot"]')?.textContent?.includes("WEB_SECRET"));
    expect(m.w.document.body.innerHTML).not.toContain("private-ui-value");
    m.q('[data-clone="execbot"]')!.click(); await waitUntil(() => !!m.q('[data-policy="execbot-copy"]'));
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
it("offers profiles in Add agent and catches up from the unread divider", async () => {
  const m = mount();
  try {
    await waitUntil(() => !!m.q('[data-catchup]')); m.q('[data-catchup]')!.click();
    await waitUntil(() => !!m.q('[aria-label="Catch me up"] pre'));
    expect(m.q('[aria-label="Catch me up"] pre')!.textContent).toContain("Unread evidence"); m.q('[aria-label="Catch me up"] [data-close]')!.click();
    await waitUntil(() => !!m.q('#cmode [data-cmode="orch"]')); m.q('#cmode [data-cmode="orch"]')!.click();
    await waitUntil(() => !!m.q('#cowadd')); m.q('#cowadd')!.click();
    await waitUntil(() => !!m.q('#addprofile option[value="test-model"]'));
    const select = m.q('#addprofile') as HTMLSelectElement; select.value = "test-model"; select.dispatchEvent(new m.w.Event("change", { bubbles: true }));
    expect((m.q('#addmodel') as HTMLInputElement).value).toBe("test/model");
    m.q('.cfscrim [data-cancel]')!.click(); await new Promise(resolve => setImmediate(resolve)); await waitUntil(() => !(m.q('#cowadd') as HTMLButtonElement)?.disabled); expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
it("renders Continue on a time limit and sends it through the ordinary composer", async () => {
  await request(`/api/projects/${id}/agents/execbot/limits`, { maxTurnMinutes: 0.002 });
  const before = (await client.chatEvents(id, "main")).events.at(-1)!.id;
  await client.send(id, "sleep:1000", "execbot");
  await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.id > before && e.payload.reason === "turn_time_limit"));
  const m = mount();
  try {
    await waitUntil(() => !!m.q('[data-nipick="Continue from where you stopped."]'));
    m.q('[data-nipick="Continue from where you stopped."]')!.click();
    await waitUntil(async () => (await client.chatEvents(id, "main")).events.some(e => e.id > before && e.kind === "run_complete"));
    expect(m.errors).toEqual([]);
  } finally { m.close(); await request(`/api/projects/${id}/agents/execbot/limits`, { maxTurnMinutes: 0 }); }
});
