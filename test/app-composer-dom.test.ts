/**
 * The composer's newer controls, and the views that grew with them, executed.
 *
 * Same harness as app-orchestra-dom.test.ts — the real APP_HTML in jsdom,
 * against a real daemon on an ephemeral port — plus a record of every request
 * the page makes, because some of what's under test (plan mode above all) is
 * a flag on a request whose visible result an echo agent can't show: echo
 * replies with the text it was sent, not the briefing plan mode wraps it in.
 *
 * Covered: the prompt manager, the Plan switch in both modes, the permission
 * dropdown (including OpenCode's honest "ask" gap), an approval card answered
 * from the thread, the Fleet tab, and the status bar's git delivery toggle.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approvalEndpoint } from "../src/core/approvals.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let clientToken: string;
/** Two echo agents, in a git repository (an orchestra refuses anything else). */
let projectId: string;
/** An OpenCode agent beside an echo one — status lists it, CLI or not. */
let ocProjectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-composer-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;

  const dir = makeProjectDir({ name: "quill" });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# quill\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");

  const ocDir = makeProjectDir({
    name: "inkwell",
    agents: [
      { id: "scribe", kind: "echo", role: "planner" },
      { id: "oc", kind: "opencode", role: "executor" },
    ],
  });

  const client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(dir)).project.id;
  ocProjectId = (await client.addProject(ocDir)).project.id;

  const { token } = await client.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

const live: Mounted[] = [];
afterEach(async () => {
  while (live.length) live.pop()!.close();
  // One run at a time per project: never leave one active for the next test.
  const { runs } = await rest<{ runs: Run[] }>("GET", "/orchestra");
  for (const r of runs) {
    if (!["completed", "failed", "aborted"].includes(r.status)) await rest("POST", `/orchestra/${r.id}/abort`);
  }
});

afterAll(async () => {
  await daemon.close();
});

interface Run {
  id: string;
  goal: string;
  status: string;
  chat: string;
  plan?: boolean;
}

async function api<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { Authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}
const rest = <T = unknown>(method: string, p: string, body?: unknown, pid = projectId) =>
  api<T>(method, `/api/projects/${pid}${p}`, body);

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
interface Mounted {
  window: JSDOM["window"];
  /** Uncaught exceptions thrown by the page's own JavaScript. */
  errors: string[];
  /** Every request the page made, in order, with its JSON body. */
  sent: Sent[];
  close: () => void;
}

/** Boot the app in a DOM, desktop or phone, optionally onto a conversation. */
function mount({ desktop = true, hash = "", chat = "", pid = projectId } = {}): Mounted {
  const errors: string[] = [];
  const sent: Sent[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {}); // settles never, so nothing runs post-teardown

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app${hash}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // Capabilities a browser has and jsdom doesn't (see app-dom.test.ts).
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({
        matches: /min-width/.test(q) ? desktop : false,
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        const url = new URL(String(input), baseUrl);
        let body: Record<string, unknown> | null = null;
        try {
          body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
        } catch {
          body = null;
        }
        sent.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, body });
        return fetch(url, init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", clientToken);
      // the first-run setup dialog is a modal, and shortcuts rightly defer to it
      window.localStorage.setItem("loomSetupSeen", "1");
      if (chat) window.localStorage.setItem(`loomChat:${pid}`, chat);
      window.confirm = () => true;
    },
  });

  const m: Mounted = {
    window: dom.window,
    errors,
    sent,
    close: () => {
      closed = true;
      for (const s of sockets) {
        try {
          s.removeAllListeners();
          s.on("error", () => {});
          s.terminate();
        } catch {
          /* already gone */
        }
      }
      dom.window.close();
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const $$ = (m: Mounted, sel: string) => [...m.window.document.querySelectorAll(sel)];
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
const shown = (el: Element | null) => !!el && (el as HTMLElement).style.display !== "none";
const box = (m: Mounted) => $(m, "#box") as HTMLTextAreaElement;
/** Wait for a control to be wired, not merely present (see app-orchestra-dom). */
const ready = (m: Mounted, sel: string) =>
  waitUntil(() => {
    const el = $(m, sel) as (HTMLElement & { onclick?: unknown }) | null;
    return !!el?.onclick;
  });
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(
    new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }),
  );
};
const mousedown = (m: Mounted, el: Element | null) => {
  if (!el) throw new Error("no such element");
  el.dispatchEvent(new m.window.MouseEvent("mousedown", { bubbles: true }));
};
const key = (m: Mounted, el: Element | null, k: string, mods: KeyboardEventInit = {}) => {
  if (!el) throw new Error("no such element");
  el.dispatchEvent(new m.window.KeyboardEvent("keydown", { key: k, bubbles: true, ...mods }));
};
/** Type into the composer and press Enter — the way a person sends. */
async function sendFromComposer(m: Mounted, words: string) {
  box(m).value = words;
  key(m, box(m), "Enter");
}
/** Mount desktop onto a project, once its composer is wired. */
async function opened(pid = projectId) {
  const m = mount({ hash: `#p/${pid}`, pid });
  await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
  return m;
}

interface Prompts {
  saved: Array<{ id: string; title: string; text: string; pinned: boolean; uses: number }>;
  recent: Array<{ text: string; mode?: string }>;
}

describe("web app · prompt manager", () => {
  it("saves the composer's prompt, lists it, and inserts it back", async () => {
    const m = await opened();
    await ready(m, "#promptbtn");
    const words = `refactor the parser ${Date.now()}\nkeep every test green`;
    box(m).value = words;

    click($(m, "#promptbtn"));
    await waitUntil(() => !!$(m, "#cmenu.pmgr #pmq") && !!$(m, "#pmsave"));
    expect($(m, "#promptbtn")?.classList.contains("on")).toBe(true);
    expect(text(m, "#cmenu .pmfoot")).toContain("insert & send");
    // the search box has focus, so the arrows and Enter are the list's
    expect(m.window.document.activeElement?.id).toBe("pmq");

    click($(m, "#pmsave"));
    await waitUntil(() => $$(m, "#pmlist .pmrow").some((r) => r.textContent?.includes("refactor the parser")));
    const saved = (await api<Prompts>("GET", "/api/prompts")).saved.find((p) => p.text === words)!;
    expect(saved, "POST /api/prompts reached the daemon").toBeTruthy();
    expect(text(m, "#pmlist .pmsec")).toMatch(/^Saved/);
    // title from the first line, the rest as the snippet
    const row = $$(m, "#pmlist .pmrow").find((r) => r.textContent?.includes("refactor the parser"))!;
    expect(row.querySelector(".pmtt")?.textContent).toContain("refactor the parser");
    expect(row.querySelector(".pmsn")?.textContent).toBe("keep every test green");

    // Pin floats it into its own section
    mousedown(m, row.querySelector('[data-pma="pin"]'));
    await waitUntil(() => text(m, "#pmlist .pmsec").startsWith("Pinned"));
    await waitUntil(async () => (await api<Prompts>("GET", "/api/prompts")).saved.find((p) => p.id === saved.id)!.pinned);

    // Esc closes and hands focus back to the composer
    key(m, $(m, "#pmq"), "Escape");
    await waitUntil(() => !shown($(m, "#cmenu")));
    expect($(m, "#promptbtn")?.classList.contains("on")).toBe(false);

    // Insert: an empty composer takes the whole prompt, and its use is counted
    box(m).value = "";
    click($(m, "#promptbtn"));
    await waitUntil(() => $$(m, "#pmlist .pmrow").length > 0);
    const pmq = $(m, "#pmq") as HTMLInputElement;
    pmq.value = "refactor the parser";
    pmq.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await waitUntil(() => $$(m, "#pmlist .pmrow").length === 1);
    key(m, pmq, "Enter");
    await waitUntil(() => box(m).value === words);
    expect(shown($(m, "#cmenu"))).toBe(false);
    await waitUntil(async () => (await api<Prompts>("GET", "/api/prompts")).saved.find((p) => p.id === saved.id)!.uses === 1);
    expect(m.sent.some((s) => s.method === "PATCH" && s.path === `/api/prompts/${saved.id}` && s.body?.used === true)).toBe(true);
    expect(m.errors.join("\n")).toBe("");
  });

  it("lists what you sent under Recent, opens on ⌘⇧V, and ⌘Enter inserts and sends", async () => {
    const m = await opened();
    await ready(m, "#promptbtn");
    const words = `recent one ${Date.now()}`;
    await sendFromComposer(m, words);
    await waitUntil(async () => (await api<Prompts>("GET", "/api/prompts")).recent.some((r) => r.text === words));

    // the shortcut, from the composer itself
    key(m, box(m), "V", { ctrlKey: true, shiftKey: true });
    await waitUntil(() => $$(m, "#pmlist .pmsec").some((s) => s.textContent?.startsWith("Recent")));
    const recent = $$(m, "#pmlist .pmrow").find((r) => r.textContent?.includes(words))!;
    expect(recent, "the sent prompt is under Recent").toBeTruthy();
    expect(recent.querySelector(".pmi")?.innerHTML).toContain("svg"); // the clock
    // a recent row offers to save it
    expect(recent.querySelector('[data-pma="save"]')).toBeTruthy();
    // the shortcut toggles it shut again
    key(m, $(m, "#pmq"), "V", { ctrlKey: true, shiftKey: true });
    await waitUntil(() => !shown($(m, "#cmenu")));

    // ↓ to the row, ⌘Enter: inserted and sent in one go
    key(m, box(m), "V", { ctrlKey: true, shiftKey: true });
    await waitUntil(() => $$(m, "#pmlist .pmrow").length > 0);
    const rows = $$(m, "#pmlist .pmrow");
    const idx = rows.findIndex((r) => r.textContent?.includes(words));
    for (let i = 0; i < idx; i++) key(m, $(m, "#pmq"), "ArrowDown");
    await waitUntil(() => !!$(m, "#pmlist .pmrow.sel")?.textContent?.includes(words));
    const before = m.sent.filter((s) => s.path.endsWith("/messages")).length;
    key(m, $(m, "#pmq"), "Enter", { metaKey: true });
    await waitUntil(() => m.sent.filter((s) => s.path.endsWith("/messages")).length === before + 1);
    expect(m.sent.filter((s) => s.path.endsWith("/messages")).pop()?.body?.text).toBe(words);
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · plan mode", () => {
  it("is a real switch, remembered per project, and sends a chat turn with plan: true", async () => {
    const m = await opened();
    await ready(m, "#planbtn");
    const sw = $(m, "#planbtn")!;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");

    click(sw);
    await waitUntil(() => sw.getAttribute("aria-checked") === "true");
    expect(sw.classList.contains("on")).toBe(true);
    expect($(m, ".cbox")?.classList.contains("planon")).toBe(true);
    expect(m.window.localStorage.getItem(`loomPlan:${projectId}`)).toBe("1");
    await waitUntil(() => text(m, "#hint").includes("agent writes a plan to plans/"));
    expect(text(m, "#hint")).toContain("no code changes");

    const words = `plan the cache ${Date.now()}`;
    await sendFromComposer(m, words);
    await waitUntil(() => m.sent.some((s) => s.path.endsWith("/messages") && s.body?.text === words));
    const req = m.sent.find((s) => s.path.endsWith("/messages") && s.body?.text === words)!;
    expect(req.body?.plan).toBe(true);
    // and the daemon took it as a plan turn
    await waitUntil(async () => (await api<Prompts>("GET", "/api/prompts")).recent.some((r) => r.text === words && r.mode === "plan"));

    // off again: storage forgets it, and a send goes without the flag
    const m2 = m;
    click($(m2, "#planbtn"));
    await waitUntil(() => $(m2, "#planbtn")?.getAttribute("aria-checked") === "false");
    expect(m2.window.localStorage.getItem(`loomPlan:${projectId}`)).toBeNull();
    const plain = `no plan ${Date.now()}`;
    await sendFromComposer(m2, plain);
    await waitUntil(() => m2.sent.some((s) => s.path.endsWith("/messages") && s.body?.text === plain));
    expect(m2.sent.find((s) => s.body?.text === plain)?.body?.plan).toBeUndefined();
    expect(m2.errors.join("\n")).toBe("");
  });

  it("orchestrates in plan mode: PLAN.md + a spec per task, on the run", async () => {
    const m = await opened();
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await ready(m, "#orchsend");
    click($(m, "#planbtn"));
    await waitUntil(() => text(m, "#orchsend") === "Write plan");
    expect(text(m, "#hint")).toContain("orchestrator writes PLAN.md + a spec per task that any agent can pick up");

    const goal = `plan a rewrite ${Date.now()}`;
    box(m).value = goal;
    click($(m, "#orchsend"));
    await waitUntil(() => m.sent.some((s) => s.path.endsWith("/orchestra") && s.method === "POST"));
    expect(m.sent.find((s) => s.path.endsWith("/orchestra") && s.method === "POST")?.body?.plan).toBe(true);
    await waitUntil(async () => (await rest<{ runs: Run[] }>("GET", "/orchestra")).runs.some((r) => r.goal === goal));
    const run = (await rest<{ runs: Run[] }>("GET", "/orchestra")).runs.find((r) => r.goal === goal)!;
    expect(run.plan).toBe(true);
    // the run view says where the plan lives
    await waitUntil(() => text(m, "#pane-orchestra .oline.plan").includes(`plans/${run.id}/PLAN.md`));
    expect(text(m, "#pane-orchestra .oline.plan")).toContain("loom/");
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · permissions", () => {
  it("shows the chosen agent's mode as a chip, and changes it from the dropdown", async () => {
    const m = await opened();
    await ready(m, "#cperm");
    await waitUntil(() => shown($(m, "#cperm")) && text(m, "#cperm") === "Auto");
    click($(m, "#cperm"));
    await waitUntil(() => $$(m, "#cmenu [data-pm]").length === 3);
    expect($$(m, "#cmenu [data-pm] b").map((b) => b.textContent)).toEqual(["Bypass", "Auto", "Always ask"]);
    // the current mode is ticked, and only it
    expect($$(m, "#cmenu [data-pm] .tick").length).toBe(1);
    expect($(m, '#cmenu [data-pm="auto"] .tick')).toBeTruthy();

    mousedown(m, $(m, '#cmenu [data-pm="bypass"]'));
    await waitUntil(() => $(m, "#cperm")?.classList.contains("bypass") ?? false);
    await waitUntil(async () =>
      (await rest<{ project: { agents: Array<{ id: string; permissions: string }> } }>("GET", "")).project.agents.some(
        (a) => a.permissions === "bypass",
      ),
    );
    expect(m.sent.some((s) => /\/agents\/[^/]+\/permissions$/.test(s.path) && s.body?.permissions === "bypass")).toBe(true);

    // Orchestrate: each worker chip wears its mode, and the badge opens the same menu
    click($(m, '#cmode [data-cmode="orch"]'));
    // .pbdg is now worn by the mode badge and the model badge alike; this
    // test is about the mode one.
    await waitUntil(() => $$(m, "#cowk .cowchip .pbdg[data-permof]").length === 2);
    expect(shown($(m, "#cperm"))).toBe(false);
    const badge = $(m, '#cowk [data-wk="execbot"] .pbdg[data-permof]')!;
    expect(badge.textContent).toBe("auto");
    click(badge);
    await waitUntil(() => $$(m, "#cmenu [data-pm]").length === 3);
    expect(text(m, "#cmenu .cmhead")).toContain("execbot");
    // opening the badge didn't toggle the worker off
    expect($(m, '#cowk [data-wk="execbot"]')?.classList.contains("on")).toBe(true);
    mousedown(m, $(m, '#cmenu [data-pm="ask"]'));
    await waitUntil(() => $(m, '#cowk [data-wk="execbot"] .pbdg[data-permof]')?.textContent === "ask");
    await waitUntil(async () =>
      (await rest<{ project: { agents: Array<{ id: string; permissions: string }> } }>("GET", "")).project.agents.find(
        (a) => a.id === "execbot",
      )!.permissions === "ask",
    );
    // put the roster back for the other tests
    await rest("POST", "/agents/execbot/permissions", { permissions: "auto" });
    await rest("POST", "/agents/plannerbot/permissions", { permissions: "auto" });
    expect(m.errors.join("\n")).toBe("");
  });

  it("shows OpenCode's Always ask disabled, with the reason, and refuses it", async () => {
    const m = await opened(ocProjectId);
    await ready(m, "#cagent");
    click($(m, "#cagent"));
    await waitUntil(() => $$(m, "#cmenu [data-ai]").length === 2);
    const ocRow = $$(m, "#cmenu [data-ai]").find((r) => r.textContent?.includes("OpenCode"))!;
    mousedown(m, ocRow);
    await waitUntil(() => text(m, "#cagent").includes("OpenCode"));
    await waitUntil(() => shown($(m, "#cperm")));
    click($(m, "#cperm"));
    await waitUntil(() => $$(m, "#cmenu [data-pm]").length === 3 && !!$(m, '#cmenu [data-pm="ask"].off'));
    const ask = $(m, '#cmenu [data-pm="ask"]')!;
    expect(ask.getAttribute("aria-disabled")).toBe("true");
    expect(ask.getAttribute("title")).toMatch(/opencode/i);
    expect(ask.textContent).toContain("Unavailable");
    // the others are live, and carry what they run with
    expect($(m, '#cmenu [data-pm="bypass"]')?.classList.contains("off")).toBe(false);
    expect(text(m, '#cmenu [data-pm="bypass"] code')).toContain("permission");
    mousedown(m, ask);
    await waitUntil(() => text(m, "#toast").length > 0);
    expect(m.sent.some((s) => s.method === "POST" && s.path.endsWith("/permissions"))).toBe(false);
    const oc = (await rest<{ project: { agents: Array<{ id: string; permissions: string }> } }>("GET", "", undefined, ocProjectId))
      .project.agents.find((a) => a.id === "oc")!;
    expect(oc.permissions).not.toBe("ask");
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · approvals", () => {
  it("renders a request as a card, answers it with Allow, and folds it", async () => {
    const m = await opened();
    await waitUntil(() => !!$(m, "#feed") && !$(m, "#feed .loader"));
    const ep = approvalEndpoint()!;
    expect(ep, "the daemon registered its approval endpoint").toBeTruthy();
    // The agent's side: blocks until a human decides. Not awaited.
    const decision = fetch(`${ep.url}/api/approvals/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-approval": ep.secret },
      body: JSON.stringify({ project: projectId, agent: "plannerbot", tool: "Bash", input: { command: "rm -rf build", description: "clean" } }),
    }).then((r) => r.json() as Promise<{ behavior: string; message?: string }>);

    await waitUntil(() => !!$(m, '#feed .apcard [data-apact="allow"]'));
    const card = $(m, "#feed .apcard")!;
    expect(card.querySelector(".aptool")?.textContent).toBe("Bash");
    expect(card.textContent).toContain("plannerbot");
    // the input, pretty-printed, not a one-line blob
    expect(card.querySelector(".apin pre")?.textContent).toContain('"command": "rm -rf build"');
    // the badge counts it
    await waitUntil(() => shown($(m, "#apbadge")) && text(m, "#apbadge .apn") === "1");

    click(card.querySelector('[data-apact="allow"]'));
    expect(await decision).toEqual({ behavior: "allow" });
    await waitUntil(() => card.classList.contains("done"));
    expect(text(m, "#feed .apcard .apres")).toContain("✓ allowed");
    await waitUntil(() => !shown($(m, "#apbadge")));
    expect((await rest<{ approvals: unknown[] }>("GET", "/approvals")).approvals).toEqual([]);
    expect(m.errors.join("\n")).toBe("");
  });

  it("denies with a reason from the badge's list, and a stale card folds on a 404", async () => {
    const m = await opened();
    await waitUntil(() => !!$(m, "#feed") && !$(m, "#feed .loader"));
    const ep = approvalEndpoint()!;
    const file = (tool: string) =>
      fetch(`${ep.url}/api/approvals/request`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-loom-approval": ep.secret },
        body: JSON.stringify({ project: projectId, agent: "execbot", tool, input: { path: "a.txt" } }),
      }).then((r) => r.json() as Promise<{ behavior: string; message?: string }>);
    const first = file("Write");
    await waitUntil(() => text(m, "#apbadge .apn") === "1");
    click($(m, "#apbadge"));
    await waitUntil(() => !!$(m, "#appop .apcard"));
    const firstId = $(m, "#appop .apcard")!.getAttribute("data-approval")!;
    ($(m, "#appop .apwhy") as HTMLInputElement).value = "not that file";
    click($(m, '#appop [data-apact="deny"]'));
    expect(await first).toEqual({ behavior: "deny", message: "not that file" });
    await waitUntil(() => text(m, "#appop").includes("Nothing waiting"));
    // the thread's copy of the card folded too
    await waitUntil(() => text(m, `#feed .apcard.done[data-approval="${firstId}"] .apres`).includes("✕ denied"));
    expect(text(m, `#feed .apcard[data-approval="${firstId}"] .apres`)).toContain("not that file");

    // someone else answers first: the POST 404s and the card still folds
    const second = file("Edit");
    await waitUntil(() => $$(m, "#feed .apcard:not(.done)").length === 1);
    const id = $(m, "#feed .apcard:not(.done)")!.getAttribute("data-approval")!;
    await rest("POST", `/approvals/${id}`, { decision: "allow" });
    expect(await second).toEqual({ behavior: "allow" });
    await waitUntil(() => $(m, `#feed .apcard[data-approval="${id}"]`)?.classList.contains("done") ?? false);
    expect(text(m, `#feed .apcard[data-approval="${id}"] .apres`)).toContain("allowed");
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · fleet", () => {
  it("has its own tab listing every open project's agents", async () => {
    const m = await opened();
    await ready(m, '.tab[data-tab="fleet"]');
    const tabs = $$(m, "#tabsbox .tab").map((t) => t.getAttribute("data-tab"));
    expect(tabs.slice(0, 3)).toEqual(["thread", "orchestra", "fleet"]);
    click($(m, '.tab[data-tab="fleet"]'));
    await waitUntil(() => shown($(m, "#pane-fleet")) && !!$(m, '#pane-fleet .frow[data-fagent="plannerbot"]'));
    // this project leads, marked as such; the other open project is there too
    expect($(m, "#pane-fleet .fproj .fcur")?.closest(".fproj")?.getAttribute("data-fproj")).toBe(projectId);
    expect($(m, `#pane-fleet .fproj[data-fproj="${ocProjectId}"]`)).toBeTruthy();
    const row = $(m, '#pane-fleet .frow[data-fagent="plannerbot"]')!;
    expect(row.querySelector(".fn b")?.textContent).toBe("plannerbot");
    expect(row.querySelector(".pbdg")?.textContent).toMatch(/^(bypass|auto|ask)$/);
    expect(text(m, "#pane-fleet .fsum")).toMatch(/\d+ working/);
    // the composer stays with Thread
    expect(shown($(m, "#composerwrap"))).toBe(false);

    // it polls while visible: a turn shows up without a click
    const words = `fleet ping ${Date.now()}`;
    const holder = (await rest<{ project: { holder: string } }>("GET", "")).project.holder;
    const polls = () => m.sent.filter((s) => s.path === "/api/activity").length;
    const before = polls();
    await rest("POST", "/messages", { text: words });
    // echo's turn ends in run_complete, which is the row's latest line
    await waitUntil(() => polls() >= before + 2 && text(m, `#pane-fleet .frow[data-fagent="${holder}"] .fline`).includes("finished its turn"),
      { timeoutMs: 10_000 });
    // the baton holder is marked
    expect($(m, `#pane-fleet .frow[data-fagent="${holder}"] .fbaton`)).toBeTruthy();
    // a thread title jumps to that conversation
    const thr = $(m, `#pane-fleet .frow[data-fagent="${holder}"] [data-fchat]`)!;
    click(thr);
    await waitUntil(() => shown($(m, "#pane-thread")) && $(m, '.tab[data-tab="thread"]')?.classList.contains("active") === true);
    expect(m.errors.join("\n")).toBe("");
  });

  it("opens as a sheet on the phone", async () => {
    const m = mount({ desktop: false, hash: `#p/${projectId}` });
    await ready(m, "#fleetbtn");
    click($(m, "#fleetbtn"));
    await waitUntil(() => !!$(m, '#fleetsheet .frow[data-fagent="plannerbot"]'));
    click($(m, "#fleetbtn"));
    await waitUntil(() => !$(m, "#fleetsheet"));
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · git delivery", () => {
  it("reads the project's policy into the status bar and PATCHes a new one", async () => {
    await rest("PATCH", "/config", { git: { delivery: "none" } });
    const m = await opened();
    await waitUntil(() => !!$(m, "#gitdel"));
    expect(text(m, "#gitdel")).toBe("no commit");
    // it sits beside the GitHub indicator's slot, in the status bar
    expect($(m, "#gitdel")?.closest("#statusbar")).toBeTruthy();

    click($(m, "#gitdel"));
    await waitUntil(() => $$(m, "#gdmenu [data-gd]").length === 4);
    expect($$(m, "#gdmenu [data-gd] b").map((b) => b.textContent)).toEqual([
      "Commit & push",
      "Commit & open PR",
      "Commit only",
      "No commit",
    ]);
    expect($(m, '#gdmenu [data-gd="none"]')?.getAttribute("aria-checked")).toBe("true");
    click($(m, '#gdmenu [data-gd="push"]'));
    await waitUntil(() => text(m, "#gitdel") === "⇡ push");
    expect(m.sent.some((s) => s.method === "PATCH" && s.path.endsWith("/config") &&
      (s.body?.git as { delivery?: string })?.delivery === "push")).toBe(true);
    await waitUntil(async () => (await rest<{ git: { delivery: string } }>("GET", "/config")).git.delivery === "push");

    click($(m, "#gitdel"));
    await waitUntil(() => !!$(m, '#gdmenu [data-gd="pr"]'));
    click($(m, '#gdmenu [data-gd="pr"]'));
    await waitUntil(() => text(m, "#gitdel") === "⇡ PR");
    await waitUntil(async () => (await rest<{ git: { delivery: string } }>("GET", "/config")).git.delivery === "pr");
    await rest("PATCH", "/config", { git: { delivery: "none" } });
    expect(m.errors.join("\n")).toBe("");
  });
});
