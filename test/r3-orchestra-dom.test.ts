import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { APP_HTML } from "../src/daemon/app-page.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import type { OrchestraRun } from "../src/core/orchestra.js";

let daemon: LoomDaemon, client: DaemonClient, project: string, token: string;
let mounted: ReturnType<typeof mount> | undefined;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-dom-home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const config = readDaemonConfig()!;
  client = new DaemonClient(config); token = config.adminToken;
  const dir = makeProjectDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q"); fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n"); git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  project = (await client.addProject(dir)).project.id;
});
afterEach(async () => {
  mounted?.close(); mounted = undefined;
  for (const r of (await client.orchestraRuns(project)).runs) if (!["completed", "failed", "aborted"].includes(r.status)) await client.orchestraAction(project, r.id, "abort");
});
afterAll(async () => { await daemon.close(); });

// The same small real-page/real-daemon mount used by app-orchestra-dom.test.ts.
function mount() {
  let closed = false, copied = "", answer = "";
  const sockets: WebSocket[] = [], errors: string[] = [];
  const observers: MutationObserver[] = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message + "\n" + ((e as Error & { cause?: Error }).cause?.stack ?? "")));
  const dom = new JSDOM(APP_HTML, { url: `${client.baseUrl}/app#p/${project}`, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      const Observer = w.MutationObserver;
      w.MutationObserver = class extends Observer { constructor(callback: MutationCallback) { super(callback); observers.push(this); } };
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof w.ResizeObserver;
      w.matchMedia = ((q: string) => ({ matches: /min-width/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as typeof w.matchMedia;
      w.fetch = ((input: string, init?: RequestInit) => closed ? new Promise(() => {}) : fetch(new URL(input, client.baseUrl), init).then(r => closed ? new Promise<Response>(() => {}) : r)) as typeof fetch;
      w.WebSocket = class extends WebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } as unknown as typeof w.WebSocket;
      w.localStorage.setItem("loomClientToken", token); w.localStorage.setItem("loomDevMode", "1");
      w.prompt = () => answer;
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (s: string) => { copied = s; } } });
    },
  });
  const $ = (selector: string) => dom.window.document.querySelector(selector) as HTMLElement | null;
  return { $, errors, copied: () => copied, answer: (s: string) => { answer = s; }, window: dom.window,
    ready: (sel: string) => waitUntil(() => Boolean($(sel)?.onclick)),
    click: (sel: string) => { if (!$(sel)) throw new Error(`missing ${sel}`); $(sel)!.click(); },
    close: () => { closed = true; for (const observer of observers) observer.disconnect(); for (const ws of sockets) { ws.removeAllListeners(); ws.on("error", () => {}); ws.terminate(); } dom.window.close(); },
  };
}

it("starts with options, previews and approves, copies Mermaid, saves and launches a recipe", async () => {
  const m = mounted = mount();
  await m.ready('[data-cmode="orch"]'); m.click('[data-cmode="orch"]');
  await m.ready("#orchsend");
  const change = (selector: string, value: string | boolean) => {
    const input = m.$(selector) as HTMLInputElement;
    if (typeof value === "boolean") input.checked = value; else input.value = value;
    input.dispatchEvent(new m.window.Event("change", { bubbles: true }));
  };
  change('[data-ooption="planOnly"]', true);
  change('[data-ooption="maxUsd"]', "2");
  change('[data-ooption="stallMinutes"]', "1");
  change('[data-kind-limit="echo"]', "1");
  (m.$("#box") as HTMLTextAreaElement).value = "R3 preview goal";
  m.click("#orchsend");
  let run!: OrchestraRun;
  await waitUntil(async () => {
    const current = (await client.orchestraRuns(project)).runs.find(r => r.goal === "R3 preview goal");
    if (current) run = current;
    return current?.status === "waiting_human";
  });
  expect(run).toMatchObject({ planOnly: true, budgetUsd: 2, stallMinutes: 1, kindLimits: { echo: 1 } });
  await client.orchestraAction(project, run.id, "reply", { text: '```loom\n{"actions":[{"type":"spawn","id":"ui-task","title":"<b>literal title</b>","agent":"execbot","prompt":"sleep\\u003a2000"}]}\n```' });
  await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks.length === 1);
  await m.ready('.tab[data-tab="orchestra"]'); m.click('.tab[data-tab="orchestra"]');
  await m.ready("#oapproveplan");
  expect(m.$("#pane-orchestra")!.textContent).toContain("sleep:2000");
  expect(m.$(".ott b")).toBeNull();
  m.click("#ographcopy"); await waitUntil(() => m.copied().includes("flowchart TD"));
  m.answer("R3 UI recipe"); m.click("#osaverecipe");
  await waitUntil(async () => (await client.orchestraRecipes()).recipes.some(r => r.name === "R3 UI recipe"));
  m.click("#oapproveplan");
  await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks[0]!.attempts === 1);
  await waitUntil(() => Boolean(m.$(".orch-events")));
  expect(m.$(".orch-events")!.textContent).toContain("started");
  await client.orchestraAction(project, run.id, "abort");
  m.close(); mounted = undefined;
  const next = mounted = mount();
  await next.ready('[data-cmode="orch"]'); next.click('[data-cmode="orch"]');
  await next.ready('[data-run-recipe="R3 UI recipe"]'); next.click('[data-run-recipe="R3 UI recipe"]');
  await waitUntil(async () => (await client.orchestraRuns(project)).runs.filter(r => r.goal === "R3 preview goal").length === 2);
  expect(m.errors).toEqual([]); expect(next.errors).toEqual([]);
}, 40_000);

it("reassigns a stalled worker from the run view with a new model", async () => {
  const { run } = await client.startOrchestra(project, { goal: "sleep:10000", workers: ["execbot", "plannerbot"], race: true, stallMinutes: 0.005 });
  const m = mounted = mount();
  await m.ready('.tab[data-tab="orchestra"]'); m.click('.tab[data-tab="orchestra"]');
  await waitUntil(() => Boolean(m.$("[data-oretry]")?.onclick));
  m.answer("plannerbot@alternate"); m.click("[data-oretry]");
  await waitUntil(async () => (await client.orchestraRun(project, run.id)).run.tasks[0]!.attempts === 2);
  expect((await client.orchestraRun(project, run.id)).run.tasks[0]!.model).toBe("alternate");
  expect(m.errors).toEqual([]);
});
