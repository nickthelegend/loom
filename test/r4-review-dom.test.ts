import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { saveReviewSettings, reviewSettings } from "../src/core/review-r4/verify.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon, baseUrl: string, token: string, projectId: string, client: DaemonClient, dir: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-dom-home"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen(); baseUrl = `http://${host}:${port}`;
  const config = readDaemonConfig()!; token = config.adminToken; client = new DaemonClient(config);
  dir = makeProjectDir({ name: "Review <project>" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); fs.writeFileSync(path.join(dir, "a.txt"), "before\n"); git("add", "."); git("commit", "-qm", "seed");
  projectId = (await client.addProject(dir)).project.id;
  await fetch(`${baseUrl}/api/projects/${projectId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "Create <module> write:module.ts", agentId: "plannerbot" }) });
  await waitUntil(async () => (await client.events(projectId)).events.some(e => e.kind === "turn_diff"));
});
afterAll(async () => { await daemon?.close(); });
// The small live-page harness from app-orchestra-dom: real HTTP/WS, only missing browser capabilities supplied.
function mount(hash = `#p/${projectId}`) {
  const sockets: WebSocket[] = [], errors: string[] = [], requests: string[] = []; let closed = false;
  const never = new Promise<never>(() => {});
  const console = new VirtualConsole(); console.on("jsdomError", (e: Error) => errors.push(e.message));
  const dom = new JSDOM(APP_HTML, { url: `${baseUrl}/app${hash}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = () => {}; window.HTMLElement.prototype.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => { requests.push(String(input)); return closed ? never : fetch(new URL(String(input), baseUrl), init).then(r => closed ? never : r); }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", token); window.localStorage.setItem("loomDevMode", "1"); window.confirm = () => true;
    },
  });
  return { dom, errors, requests, close() { closed = true; for (const s of sockets) { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); } dom.window.close(); } };
}

it("shows the Home inbox with escaped project labels", async () => {
  const m = mount("#home"), doc = m.dom.window.document;
  try {
    await waitUntil(() => !!doc.querySelector("[data-r4-inbox] a"));
    expect(doc.querySelector("[data-r4-inbox]")!.textContent).toContain("Review <project>");
    expect(doc.querySelector("[data-r4-inbox] project")).toBeNull(); expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
it("loads the review diff, updates viewed progress and saves verification and editable split proposals", async () => {
  const m = mount(), doc = m.dom.window.document;
  async function click(selector: string) { await waitUntil(() => !!doc.querySelector(selector)); (doc.querySelector(selector) as HTMLElement).click(); }
  try {
    await click('.rvbtn[data-view="scm"]');
    await waitUntil(() => !!doc.querySelector('[data-r4-panel]'));
    await click('[data-r4="open-review"]');
    await waitUntil(() => !!doc.querySelector('[data-r4-viewed]')).catch(e => { throw new Error(e.message + "\n" + doc.querySelector("[data-r4-panel]")?.outerHTML + "\n" + m.errors.join("\n")); });
    expect(doc.querySelector('[data-r4-progress]')!.textContent).toBe("0 of 1 viewed");
    expect(doc.querySelector('[data-r4-diff]')!.textContent).toContain("module.ts");
    await click('[data-r4-viewed]');
    await waitUntil(() => doc.querySelector('[data-r4-progress]')?.textContent === "1 of 1 viewed");
    const attribution = [...doc.querySelectorAll('[data-r4-run-diff] button')].find(b => b.textContent === "Who wrote this?") as HTMLElement;
    expect(attribution).toBeTruthy(); attribution.click(); await waitUntil(() => doc.body.textContent!.includes("plannerbot · chat main"));
    (doc.querySelector('[data-r4-verify]') as HTMLInputElement).value = 'node -e "console.log(123)"';
    await click('[data-r4="save-verify"]'); await waitUntil(() => doc.body.textContent!.includes("Verification saved"));
    await click('[data-r4="verify"]'); await waitUntil(() => doc.querySelector('[data-r4-output]')?.textContent?.includes("123") === true);
    await click('[data-r4="split"]'); await waitUntil(() => !!doc.querySelector('[data-r4-split]'));
    expect((doc.querySelector('[data-r4-split]') as HTMLTextAreaElement).value).toContain("module.ts");
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});
it("discards and undoes a hunk from the live web diff, then stages it", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "after\n");
  const m = mount(), doc = m.dom.window.document;
  async function click(selector: string) { await waitUntil(() => !!doc.querySelector(selector)); (doc.querySelector(selector) as HTMLElement).click(); }
  try {
    await click('.rvbtn[data-view="scm"]'); await click('[data-open="a.txt"]');
    await click('#pane-changes [data-discard]');
    await waitUntil(() => fs.readFileSync(path.join(dir, "a.txt"), "utf8") === "before\n");
    await click('#pane-changes [data-r4="undo"]');
    await waitUntil(() => fs.readFileSync(path.join(dir, "a.txt"), "utf8") === "after\n");
    await click('[data-open="a.txt"]'); await click('#pane-changes [data-stage]');
    await waitUntil(() => execFileSync("git", ["diff", "--cached", "--", "a.txt"], { cwd: dir, encoding: "utf8" }).includes("+after"));
    expect(m.errors).toEqual([]);
  } finally { m.close(); }
});

it("opens a visible conflict action and releases a resolution hold from the web", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("add", "."); git("commit", "-qm", "save test edits");
  git("checkout", "-qb", "conflict-ui"); fs.writeFileSync(path.join(dir, "a.txt"), "theirs\n"); git("commit", "-qam", "theirs");
  git("checkout", "main"); fs.writeFileSync(path.join(dir, "a.txt"), "ours\n"); git("commit", "-qam", "ours"); try { git("merge", "conflict-ui"); } catch {}
  saveReviewSettings(dir, { hold: true });
  const m = mount(), doc = m.dom.window.document;
  try {
    await waitUntil(() => !!doc.querySelector('.rvbtn[data-view="scm"]')); (doc.querySelector('.rvbtn[data-view="scm"]') as HTMLElement).click();
    await waitUntil(() => !!doc.querySelector('[data-r4="resolve-current"]'));
    const panel = doc.querySelector('[data-r4-panel]') as HTMLDetailsElement;
    expect(panel.open).toBe(true); expect(panel.querySelector('[data-r4-conflicts]')!.textContent).toContain("Conflicts in 1 files · Resolve with agent");
    (doc.querySelector('[data-r4="release-hold"]') as HTMLElement).click(); await waitUntil(() => !reviewSettings(dir).hold);
    expect(git("rev-parse", "MERGE_HEAD")).toBeTruthy();
    // The conflict banner acts on the existing merge even with a stale branch form.
    (doc.querySelector('[data-r4-conflict-branch]') as HTMLInputElement).value = "not-a-branch";
    (doc.querySelector('[data-r4="resolve-current"]') as HTMLElement).click();
    await waitUntil(() => reviewSettings(dir).hold === true);
    expect(m.requests.some(r => r.endsWith("/git/resolve"))).toBe(true); expect(m.errors).toEqual([]);
  } finally { m.close(); git("merge", "--abort"); saveReviewSettings(dir, { hold: false }); }
});
it("does not poll the Home inbox every five seconds", async () => {
  const m = mount("#home");
  try {
    await waitUntil(() => m.requests.some(r => r === "/api/review/inbox"));
    await new Promise(resolve => setTimeout(resolve, 5300));
    expect(m.requests.filter(r => r === "/api/review/inbox")).toHaveLength(1);
    (m.dom.window.document.querySelector('[data-r4-inbox] button') as HTMLElement).click();
    await waitUntil(() => m.requests.filter(r => r === "/api/review/inbox").length === 2);
  } finally { m.close(); }
}, 15000);
