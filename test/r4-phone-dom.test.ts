import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
let daemon: LoomDaemon, base: string, token: string, project: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-phone-dom"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); const address = await daemon.listen(); base = `http://${address.host}:${address.port}`;
  const client = new DaemonClient(readDaemonConfig()!); project = (await client.addProject(makeProjectDir({ name: '<phone & computer>' }))).project.id;
  const pairing = await client.newPairingToken(); const claimed = await fetch(base + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairing.token, name: "browser" }) }); token = (await claimed.json() as { clientToken: string }).clientToken;
  await client.send(project, "ask: <script>question</script>");
}, 30000);
afterAll(async () => { await daemon.close(); });
function mount(auth = token, timezone?: string) {
  const errors: string[] = [], sockets: WebSocket[] = []; let closed = false; const never = new Promise<Response>(() => {});
  const virtualConsole = new VirtualConsole(); virtualConsole.on("jsdomError", e => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, { url: base + "/app#p/" + project, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole, beforeParse(window) {
    if (timezone) {
      const original = window.Intl.DateTimeFormat.prototype.resolvedOptions;
      window.Intl.DateTimeFormat.prototype.resolvedOptions = function () { return { ...original.call(this), timeZone: timezone }; };
    }
    window.scrollTo = () => {}; window.HTMLElement.prototype.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
    window.matchMedia = ((query: string) => ({ matches: /min-width/.test(query), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    window.fetch = ((input: string, init?: RequestInit) => {
      if (closed) return never;
      const url = new URL(String(input), base);
      if (url.pathname === "/api/bootstrap") return Promise.resolve(new Response('{"error":"not local"}', { status: 403 }));
      if (url.pathname.endsWith("/agents/models")) return Promise.resolve(new Response('{"models":[]}'));
      return fetch(url, init).then(response => closed ? never : response);
    }) as typeof window.fetch;
    window.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof window.WebSocket;
    window.localStorage.setItem("loomClientToken", auth); window.localStorage.setItem("loomDevMode", "1"); window.localStorage.setItem("loomSetupSeen", "1"); window.confirm = () => true;
  } });
  return { window: dom.window, errors, close() { closed = true; for (const socket of sockets) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); } dom.window.close(); } };
}
it("mounts real Now, persists quiet hours and chat level, escapes row data, and inserts editable quick replies", async () => {
  const mounted = mount(), w = mounted.window, doc = w.document;
  const click = (selector: string) => { const el = doc.querySelector(selector) as HTMLElement | null; expect(el, selector).toBeTruthy(); el!.click(); };
  try {
    await waitUntil(() => !!doc.querySelector("#phone-r4-open") && !!doc.querySelector("#box"));
    await waitUntil(() => !!doc.querySelector("[data-quick-replies] button")); click("[data-quick-replies] button"); expect((doc.querySelector("#box") as HTMLTextAreaElement).value).toBe("Continue");
    click("#phone-r4-open"); await waitUntil(() => !!doc.querySelector("[data-now-row]"));
    expect(doc.querySelector("[data-now]")!.textContent).toContain("<script>question</script>"); expect(doc.querySelector("[data-now] script")).toBeNull();
    await waitUntil(() => (doc.querySelector('[name="start"]') as HTMLInputElement)?.value === "22:00");
    (doc.querySelector('[name="enabled"]') as HTMLInputElement).checked = true;
    (doc.querySelector('[name="start"]') as HTMLInputElement).value = "21:30";
    doc.querySelector("[data-quiet]")!.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await waitUntil(async () => { const res = await fetch(base + "/api/push/quiet", { headers: { authorization: `Bearer ${token}` } }); return (await res.json() as any).quiet.start === "21:30"; });
    const level = doc.querySelector('[aria-label="Chat notification level"]') as HTMLSelectElement; expect(level).toBeTruthy(); level.value = "none"; level.dispatchEvent(new w.Event("change", { bubbles: true }));
    await waitUntil(async () => { const res = await fetch(`${base}/api/projects/${project}/chats/main/notification-level`, { headers: { authorization: `Bearer ${token}` } }); return (await res.json() as any).level === "none"; });
    (doc.querySelector("[data-replies]") as HTMLTextAreaElement).value = "Explain that\nShip it"; click("[data-save-replies]");
    const scale = doc.querySelector("[data-scale]") as HTMLSelectElement; scale.value = "1.5"; scale.dispatchEvent(new w.Event("change"));
    const contrast = doc.querySelector("[data-contrast]") as HTMLInputElement; contrast.checked = true; contrast.dispatchEvent(new w.Event("change"));
    expect(doc.documentElement.classList.contains("phone-contrast")).toBe(true); expect(doc.documentElement.style.getPropertyValue("--phone-text-scale")).toBe("1.5");
    expect(JSON.parse(w.localStorage.getItem("loom.phone-r4")!).replies).toEqual(["Explain that", "Ship it"]);
    click("[data-close]"); await waitUntil(() => doc.querySelector("[data-quick-replies] button")?.textContent === "Explain that");
    expect(mounted.errors).toEqual([]);
  } finally { mounted.close(); }
});

it("adds Notifications to the real row menu after a macrotask and saves shared preferences", async () => {
  const mounted = mount(), w = mounted.window, doc = w.document;
  try {
    await waitUntil(() => !!doc.querySelector('.crow[data-chat][data-p]'));
    const row = doc.querySelector('.crow[data-chat][data-p]') as HTMLElement;
    row.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
    await new Promise(r => setTimeout(r, 0));
    const item = [...doc.querySelectorAll('#loommenu button')].find(b => b.textContent === "Notifications…") as HTMLElement;
    expect(item).toBeTruthy(); item.click();
    await waitUntil(() => [...doc.querySelectorAll('#loommenu button')].some(b => b.textContent?.includes("Mute (approvals still notify)")));
    ([...doc.querySelectorAll('#loommenu button')].find(b => b.textContent?.includes("Mute (approvals still notify)")) as HTMLElement).click();
    await waitUntil(async () => { const res = await fetch(`${base}/api/projects/${project}/chats/${row.dataset.chat}/notification-level`, { headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}` } }); return (await res.json() as any).level === "none"; });
  } finally { mounted.close(); }
});

it("admin web defaults to browser timezone and saves the same quiet settings the phone reads", async () => {
  const admin = readDaemonConfig()!.adminToken;
  await fetch(base + "/api/push/quiet", { method: "PUT", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false, start: "22:00", end: "07:00", timeZone: "UTC", allowApprovals: true, snoozeUntil: 0 }) });
  const mounted = mount(admin, "Asia/Kolkata"), doc = mounted.window.document;
  try {
    await waitUntil(() => !!doc.querySelector("#phone-r4-open")); (doc.querySelector("#phone-r4-open") as HTMLElement).click();
    await waitUntil(() => (doc.querySelector('[name="timeZone"]') as HTMLInputElement)?.value === "Asia/Kolkata");
    expect(doc.querySelector('[data-device]')).toBeNull();
    (doc.querySelector('[name="enabled"]') as HTMLInputElement).checked = true;
    doc.querySelector('[data-quiet]')!.dispatchEvent(new mounted.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitUntil(async () => { const res = await fetch(base + "/api/push/quiet", { headers: { authorization: `Bearer ${token}` } }); const q = (await res.json() as any).quiet; return q.enabled && q.timeZone === "Asia/Kolkata"; });
  } finally { mounted.close(); }
});
