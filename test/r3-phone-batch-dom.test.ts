import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, client: DaemonClient, pid: string, token: string;
const live: Array<ReturnType<typeof mount>> = [];
beforeAll(async () => {
  vi.stubEnv("LOOM_HOME", tmpDir("r3-phone-dom")); vi.stubEnv("LOOM_NO_NOTIFY", "1");
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!); token = readDaemonConfig()!.adminToken;
  const dir = makeProjectDir({ name: "Phone batch" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "reviewed.txt"), "old line\n"); git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  fs.writeFileSync(path.join(dir, "reviewed.txt"), '<tag onclick="bad()">new line</tag>\n');
  pid = (await client.addProject(dir)).project.id;
});
afterEach(() => { while (live.length) live.pop()!.close(); });
afterAll(async () => { await daemon.close(); vi.unstubAllEnvs(); });

/** The Orchestra harness: real bundle and daemon, with only missing browser capabilities supplied. */
function mount(split = false) {
  const errors: string[] = [], sockets: WebSocket[] = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message)); vc.on("error", e => errors.push(String(e)));
  let closed = false; const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, {
    url: `${client.baseUrl}/app#p/${pid}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), client.baseUrl), init).then(r => closed ? never : r)) as typeof w.fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1"); w.localStorage.setItem("loomSetupSeen", "1"); w.localStorage.setItem("loomTourDone", "1");
      w.localStorage.setItem("loomDiffView", split ? "split" : "unified"); w.confirm = () => true;
    },
  });
  const m = { w: dom.window, errors, close: () => { closed = true; sockets.forEach(s => { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); }); dom.window.close(); } };
  live.push(m); return m;
}
const click = (m: ReturnType<typeof mount>, selector: string) => {
  const el = m.w.document.querySelector(selector); expect(el).toBeTruthy(); el!.dispatchEvent(new m.w.MouseEvent("click", { bubbles: true }));
};
async function changes(m: ReturnType<typeof mount>) {
  await waitUntil(() => !!m.w.document.querySelector('.rvbtn[data-view="scm"]'));
  click(m, '.rvbtn[data-view="scm"]');
  await waitUntil(() => !!m.w.document.querySelector('.scmname[data-open="reviewed.txt"]'));
  click(m, '.scmname[data-open="reviewed.txt"]');
  await waitUntil(() => !!m.w.document.querySelector('[data-ask-file]'));
}
it("long-presses a deleted line into the existing draft without sending or creating a review comment", async () => {
  const m = mount(); await changes(m);
  const box = m.w.document.querySelector("#box") as HTMLTextAreaElement; box.value = "Existing draft";
  const row = m.w.document.querySelector('[data-ask-side="old"]')!;
  row.dispatchEvent(new m.w.MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }));
  await waitUntil(() => box.value.includes("Explain this diff line"));
  row.dispatchEvent(new m.w.MouseEvent("pointerup", { bubbles: true }));
  row.dispatchEvent(new m.w.MouseEvent("click", { bubbles: true }));
  expect(box.value).toBe("Existing draft\n\nExplain this diff line in reviewed.txt:1 (old):\n\nold line\n");
  expect(m.w.document.querySelector(".cmteditor")).toBeNull();
  expect((await client.chatEvents(pid, "main")).events.filter(e => e.payload.author === "user")).toHaveLength(0);
  expect(m.errors).toEqual([]);
});
it("supports the split view keyboard action and keeps code escaped", async () => {
  const m = mount(true); await changes(m);
  const row = m.w.document.querySelector('.sc[data-ask-side="new"]')!;
  expect(row.querySelector("tag")).toBeNull();
  row.dispatchEvent(new m.w.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true }));
  const box = m.w.document.querySelector("#box") as HTMLTextAreaElement;
  expect(box.value).toContain('reviewed.txt:1 (new):\n\n<tag onclick="bad()">new line</tag>');
  expect(m.errors).toEqual([]);
});
it("cancels a hold when scrolling and leaves the existing click-to-review interaction intact", async () => {
  const m = mount(); await changes(m);
  const row = m.w.document.querySelector('[data-ask-side="new"]')!;
  row.dispatchEvent(new m.w.MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
  row.dispatchEvent(new m.w.MouseEvent("pointermove", { bubbles: true, clientX: 0, clientY: 30 }));
  await new Promise(r => setTimeout(r, 550));
  // The chat draft is saved on the daemon, so an earlier test's text may come back; the cancelled hold adds nothing.
  expect((m.w.document.querySelector("#box") as HTMLTextAreaElement).value).not.toContain("reviewed.txt:1 (new)");
  row.dispatchEvent(new m.w.MouseEvent("click", { bubbles: true }));
  expect(m.w.document.querySelector(".cmteditor input")).not.toBeNull();
});
