import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, baseUrl: string, token: string, projectId: string, client: DaemonClient;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen(); baseUrl = `http://${host}:${port}`;
  const config = readDaemonConfig()!; token = config.adminToken; client = new DaemonClient(config);
  const dir = makeProjectDir({ name: "git-review" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "before\n"); git("add", "."); git("commit", "-qm", "seed");
  fs.writeFileSync(path.join(dir, "a.txt"), "after\n"); git("add", "a.txt");
  projectId = (await client.addProject(dir)).project.id;
  await fetch(`${baseUrl}/api/projects/${projectId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "Fix <parser> safely", agentId: "plannerbot" }) });
  await waitUntil(async () => (await client.events(projectId)).events.some(e => e.kind === "run_complete"));
});
afterAll(async () => { await daemon?.close(); });

// The small live-page harness from app-orchestra-dom: real HTTP/WS, only missing browser capabilities supplied.
function mount() {
  const sockets: WebSocket[] = [], errors: string[] = []; let closed = false;
  const never = new Promise<never>(() => {});
  const console = new VirtualConsole(); console.on("jsdomError", (e: Error) => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, { url: `${baseUrl}/app#p/${projectId}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = () => {}; window.HTMLElement.prototype.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => closed ? never : fetch(new URL(String(input), baseUrl), init).then(r => closed ? never : r)) as typeof window.fetch;
      window.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", token); window.localStorage.setItem("loomDevMode", "1"); window.confirm = () => true;
    },
  });
  return { dom, errors, close() { closed = true; for (const s of sockets) { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); } dom.window.close(); } };
}

it("drafts an escaped PR checklist and commit subject through source control", async () => {
  const m = mount(); const doc = m.dom.window.document;
  const click = async (selector: string) => {
    await waitUntil(() => Boolean((doc.querySelector(selector) as HTMLElement | null)?.onclick));
    (doc.querySelector(selector) as HTMLElement).click();
  };
  try {
    await click('.rvbtn[data-view="scm"]');
    await waitUntil(() => Boolean(doc.querySelector("#gittemplate")));
    (doc.querySelector("#gittemplate") as HTMLSelectElement).value = "security";
    await click("#gitdescribe");
    await waitUntil(() => Boolean(doc.querySelector("#gitdraft textarea")));
    const text = (doc.querySelector("#gitdraft textarea") as HTMLTextAreaElement).value;
    expect(text).toContain("Fix <parser> safely"); expect(text).toContain("- [ ] Authorization is enforced");
    expect(doc.querySelector("#gitdraft parser")).toBeNull();
    await click("#gitgen");
    await waitUntil(() => Boolean((doc.querySelector("#gmsg") as HTMLTextAreaElement)?.value));
    expect((doc.querySelector("#gmsg") as HTMLTextAreaElement).value).toContain("a.txt");
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
