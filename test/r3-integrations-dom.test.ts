import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, base: string, id: string;
const mounted: Array<() => void> = [];
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); client = new DaemonClient(readDaemonConfig()!); base = client.baseUrl;
  id = (await client.addProject(makeProjectDir({ name: "Integrations" }))).project.id;
});
afterEach(() => { while (mounted.length) mounted.pop()!(); });
afterAll(async () => { await daemon.close(); });

// The same small browser mount as app-orchestra-dom: actual bundle and daemon, browser gaps supplied.
function mount() {
  const errors: string[] = [], sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {}), console = new VirtualConsole();
  console.on("jsdomError", e => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, { url: `${base}/app#p/${id}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: q.includes("min-width"), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(input, base), init).then(r => closed ? never : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", readDaemonConfig()!.adminToken); w.localStorage.setItem("loomDevMode", "1"); w.confirm = () => true;
    } });
  mounted.push(() => { closed = true; for (const s of sockets) s.close(); dom.window.close(); });
  const el = (selector: string) => dom.window.document.querySelector(selector) as HTMLElement;
  const input = (selector: string, value: string) => { const e = el(selector) as HTMLInputElement; e.value = value; e.dispatchEvent(new dom.window.Event("input", { bubbles: true })); e.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  return { dom, el, input, errors };
}
it("renders templates, previews escaped payload text, creates the command trigger and exposes calendar controls", async () => {
  const m = mount();
  await waitUntil(() => !!m.el(`.srow[data-id="${id}"]`));
  m.el(`.srow[data-id="${id}"]`).dispatchEvent(new m.dom.window.MouseEvent("contextmenu", { bubbles: true }));
  const trigger = [...m.dom.window.document.querySelectorAll("button")].find(b => b.textContent?.includes("Triggers…"))!;
  trigger.click(); await waitUntil(() => !!m.el("#trtemplate"));
  m.input("#trtemplate", "issue");
  expect((m.el("#trkind") as HTMLInputElement).value).toBe("webhook");
  m.input("#trpayload", JSON.stringify({ issue: { number: 42, title: '<img src=x onerror="bad()">', body: "fix" } }));
  m.el("#trpreview").click(); await waitUntil(() => Boolean(m.el("#trpreviewout")?.textContent?.includes("<img")));
  expect(m.el("#trpreviewout img")).toBeNull();
  m.input("#trpayload", "bad JSON"); m.el("#trpreview").click(); expect(m.el("#trpreviewout").textContent).toContain("valid JSON");
  (m.el("#trgithub") as HTMLInputElement).click(); m.el("#tradd").click();
  await waitUntil(async () => (await client.triggers(id)).triggers.some(t => t.githubCommand === true));
  await waitUntil(() => !!m.el(".trsecret"));
  expect(m.el("#trcalendar")).toBeTruthy(); expect(m.el("#trsubscribe")).toBeTruthy(); expect(m.errors).toEqual([]);
});
it("saves provider and SMTP settings, previews a digest, and shows bridge controls", async () => {
  const m = mount(); await waitUntil(() => !!m.el("#setupbtn")); m.el("#setupbtn").click();
  await waitUntil(() => !!m.el('[data-sec="integrations"]')); m.el('[data-sec="integrations"]').click();
  await waitUntil(() => !!m.el("#email-save"));
  m.input('[data-provider-url="jira"]', "https://example.atlassian.net"); m.input('[data-provider-key="jira"]', "owner:secret"); m.el('[data-provider-save="jira"]').click();
  await waitUntil(async () => (await client.providers()).providers.some(p => p.id === "jira" && p.configured));
  m.input("#email-host", "smtp.example.com"); m.input("#email-from", "me@example.com"); m.input("#email-to", "you@example.com"); m.input("#email-password", "smtp-secret"); m.el("#email-save").click();
  await waitUntil(async () => (await client.integrationEmail()).host === "smtp.example.com");
  m.el("#email-preview").click(); await waitUntil(() => Boolean(m.el("#email-output").textContent?.includes("Loom digest")));
  expect(m.el("#email-output").textContent).not.toContain("smtp-secret");
  m.el('[data-sec="bridges"]').click(); await waitUntil(() => !!m.el('[data-b="discord-orchestra"]'));
  expect(m.el("#setpane").textContent).toContain("/loom"); expect(m.errors).toEqual([]);
});
