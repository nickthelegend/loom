import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { readTriggers } from "../src/core/triggers.js";
import { readControl } from "../src/core/auto-r4/state.js";
import { queueWebhooks, readWebhooks } from "../src/core/auto-r4/webhooks.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, base: string, token: string, pid: string, dir: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("a4-dom"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  const client = new DaemonClient(readDaemonConfig()!); base = client.baseUrl; token = readDaemonConfig()!.adminToken;
  dir = makeProjectDir(); pid = (await client.addProject(dir)).project.id;
});
afterAll(async () => { await daemon?.close(); });

/** The application bundle runs against a real daemon, with only missing browser APIs supplied. */
function mount() {
  const errors: string[] = [], sockets: WebSocket[] = []; let closed = false;
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, { url: `${base}/app#p/${pid}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: q.includes("min-width"), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia;
      w.fetch = ((url: string, init?: RequestInit) => closed ? new Promise(() => {}) : fetch(new URL(String(url), base), init).then(r => closed ? new Promise(() => {}) : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1"); w.confirm = () => true;
    },
  });
  return { window: dom.window, errors, close() { closed = true; sockets.forEach(s => { s.on("error", () => {}); s.close(); }); dom.window.close(); } };
}

it("creates previewed schedules and watches, pauses automation, and resends webhook deliveries", async () => {
  const m = mount(), w = m.window, doc = w.document;
  const el = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const click = (id: string) => el(id).click();
  const set = (id: string, value: string, event = "input") => { el(id).value = value; el(id).dispatchEvent(new w.Event(event, { bubbles: true })); };
  try {
    await waitUntil(() => Boolean(el("box")));
    doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await waitUntil(() => Boolean(el("pq"))); set("pq", "Triggers");
    await waitUntil(() => doc.getElementById("pbody")?.textContent?.includes("Triggers") ?? false);
    doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitUntil(() => Boolean(el("a4-save")));
    set("a4-name", '<img src=x onerror="alert(1)">'); set("a4-prompt", "Check docs"); click("a4-save");
    expect(el("a4-next").textContent).toContain("Preview"); expect(readTriggers(dir).triggers).toHaveLength(0);
    click("a4-preview"); await waitUntil(() => el("a4-next").textContent?.includes("0 9 * * 1-5") ?? false);
    expect(el("a4-next").textContent?.split("\n")).toHaveLength(6);
    click("a4-save"); await waitUntil(() => readTriggers(dir).triggers.length === 1);
    await waitUntil(() => el("a4-edit")?.querySelectorAll("option").length === 2);
    expect(doc.querySelector(".trrow img")).toBeNull();
    set("a4-kind", "file", "change"); set("a4-when", "docs/**"); set("a4-prompt", "Review {{files}}"); click("a4-save");
    await waitUntil(() => readTriggers(dir).triggers.some(t => t.kind === "file"));
    await waitUntil(() => el("a4-edit")?.querySelectorAll("option").length === 3); click("a4-pause");
    await waitUntil(() => readControl().paused === true);
    await waitUntil(() => el("a4-status")?.textContent?.includes("paused") ?? false);
    set("a4-url", "https://example.com/hook"); click("a4-hook-add");
    await waitUntil(() => readWebhooks(dir).webhooks.length === 1);
    await waitUntil(() => Boolean(doc.querySelector("[data-hook-remove]")));
    // A durable failed delivery can be retried from the same UI after a restart.
    queueWebhooks(dir, pid, "turn_finished", { message: "done" }, "dom");
    const state = readWebhooks(dir); state.deliveries[0]!.status = "failed";
    const { writeWebhooks } = await import("../src/core/auto-r4/webhooks.js"); writeWebhooks(dir, state);
    click("a4-quiet-off"); await waitUntil(() => Boolean(doc.querySelector("[data-resend]")));
    (doc.querySelector("[data-resend]") as HTMLButtonElement).click();
    await waitUntil(() => readWebhooks(dir).deliveries.length === 2);
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
}, 60_000);
