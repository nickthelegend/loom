/**
 * The Crew tab (Agent Teams P1) of the web app, actually executed.
 *
 * Same harness as app-orchestra-dom.test.ts — the real APP_HTML in jsdom,
 * against a real daemon on an ephemeral port — with a project that is a git
 * repository, because a crew builds each goal in its own worktree.
 *
 * Every teammate is `echo`. As a Lead echo answers without a ```loom block, so
 * after two tries the goal becomes one card; echo writes a file when its prompt
 * says `write:<path>`, sleeps on `sleep:<ms>` and asks on `ask: <q>` — enough to
 * walk a goal through every state the tab has a button for.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let clientToken: string;
let projectId: string;
let client: DaemonClient;
let projectDir: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-crew-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;

  projectDir = makeProjectDir({ name: "crewdom" });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: projectDir });
  git("init", "-q");
  fs.writeFileSync(path.join(projectDir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(projectDir, "README.md"), "# crewdom\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");

  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(projectDir)).project.id;

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
  // One goal at a time per crew: never leave one running for the next test.
  const { crews } = await rest<{ crews: Crew[] }>("GET", "/crews");
  for (const c of crews) {
    const g = c.state.goal;
    if (g && !["completed", "failed", "stopped"].includes(g.status)) await rest("POST", `/crews/${c.id}/stop`).catch(() => {});
  }
});

afterAll(async () => {
  await daemon.close();
});

interface Crew {
  id: string;
  name: string;
  teammates: Array<{ id: string; role: string; agent: string }>;
  state: { channel: string; goal?: { id: string; status: string; branch: string; applied?: { into: string } } };
}

async function rest<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}${p}`, {
    method,
    headers: { Authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  close: () => void;
}

function mount(): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app#p/${projectId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver;
      // desktop layout: the tab strip is where the Crew tab lives
      window.matchMedia = ((q: string) => ({
        matches: /min-width/.test(q),
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
        return fetch(new URL(String(input), baseUrl), init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", clientToken);
      window.confirm = () => true;
    },
  });

  const m: Mounted = {
    window: dom.window,
    errors,
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
const ready = (m: Mounted, sel: string) =>
  waitUntil(() => {
    const el = $(m, sel) as (HTMLElement & { onclick?: unknown }) | null;
    return !!el?.onclick;
  });
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};
const shown = (el: Element | null) => !!el && (el as HTMLElement).style.display !== "none";
const pill = (m: Mounted) => text(m, "#pane-crew .crewgoal .opill");
const act = (m: Mounted, name: string) => $(m, `#pane-crew [data-crew-act="${name}"]`) as HTMLButtonElement | null;

/** Type into the say box and send it, the way you would. */
function say(m: Mounted, words: string) {
  const box = $(m, "#crewsaytext") as HTMLTextAreaElement;
  box.value = words;
  const form = $(m, "#crewsay") as HTMLFormElement;
  form.dispatchEvent(new m.window.Event("submit", { bubbles: true, cancelable: true }));
}

/**
 * Every toast, kept. A teammate that asks raises its own needs-you toast at
 * once, which would otherwise replace the one that says where your words went.
 */
function recordToasts(m: Mounted): string[] {
  const seen: string[] = [];
  new m.window.MutationObserver(() => seen.push(text(m, "#toast"))).observe($(m, "#toast")!, { childList: true, characterData: true, subtree: true });
  return seen;
}

async function openCrewTab(m: Mounted) {
  await ready(m, '.tab[data-tab="crew"]');
  click($(m, '.tab[data-tab="crew"]'));
  await waitUntil(() => shown($(m, "#pane-crew")) && !!$(m, "#pane-crew .crewview") && !$(m, "#pane-crew .loader"));
}

describe("web app · crew tab", () => {
  it("creates a crew from the empty state, then takes a goal through approve, diff and apply", async () => {
    const m = mount();
    await openCrewTab(m);
    // Right after Orchestra in the strip.
    const tabs = $$(m, "#tabsbox .tab").map((t) => t.getAttribute("data-tab"));
    expect(tabs.slice(0, 4)).toEqual(["thread", "orchestra", "crew", "fleet"]);

    // Empty state: a template picker, a name and Create.
    await waitUntil(() => !!$(m, "#pane-crew .crewempty"));
    expect(text(m, "#pane-crew .crewempty")).toContain("No crew yet");
    expect($$(m, "#pane-crew [data-crew-tpl]").map((b) => b.getAttribute("data-crew-tpl"))).toEqual(["ship", "fix", "research", "solo"]);
    expect(text(m, '#pane-crew [data-crew-tpl="ship"]')).toContain("two builders");
    click($(m, '#pane-crew [data-crew-tpl="fix"]'));
    await waitUntil(() => $(m, '#pane-crew [data-crew-tpl="fix"]')?.classList.contains("on") === true);
    // who sits where: one picker per seat, filled from the roster; pick another agent for the builder
    await waitUntil(() => $$(m, "#pane-crew [data-crew-seat]").length === 3);
    const seat = $(m, '#pane-crew [data-crew-seat="builder"]') as HTMLSelectElement;
    expect([...seat.options].map((o) => o.value)).toEqual(["plannerbot", "execbot"]);
    seat.value = "execbot";
    seat.dispatchEvent(new m.window.Event("change", { bubbles: true }));
    await waitUntil(() => ($(m, '#pane-crew [data-crew-seat="builder"]') as HTMLSelectElement).value === "execbot");
    ($(m, "#crewname") as HTMLInputElement).value = "Fixers";
    click($(m, "#crewcreate"));

    // The roster strip: who's on it, in which role, as which agent.
    await waitUntil(() => $$(m, "#pane-crew .crewmate").length === 3);
    expect($$(m, "#pane-crew .crewmate").map((c) => c.getAttribute("data-mate"))).toEqual(["lead", "builder", "tester"]);
    expect(text(m, '#pane-crew .crewmate[data-mate="tester"]')).toMatch(/tester.*tester.*plannerbot/);
    expect(text(m, "#pane-crew .crewname")).toBe("Fixers");
    expect((await client.crews(projectId)).crews[0]!.teammates.find((t: { id: string }) => t.id === "builder")!.agent).toBe("execbot");
    // and a seat can be swapped later, from the teammate's card
    const swap = $(m, '#pane-crew [data-crew-swap="tester"]') as HTMLSelectElement;
    swap.value = "execbot";
    swap.dispatchEvent(new m.window.Event("change", { bubbles: true }));
    await waitUntil(async () => (await client.crews(projectId)).crews[0]!.teammates.find((t: { id: string }) => t.id === "tester")!.agent === "execbot");
    swap.value = "plannerbot";
    swap.dispatchEvent(new m.window.Event("change", { bubbles: true }));
    await waitUntil(async () => (await client.crews(projectId)).crews[0]!.teammates.find((t: { id: string }) => t.id === "tester")!.agent === "plannerbot");
    expect(text(m, "#pane-crew .crewgoal, #pane-crew .crewnote")).toContain("No goal yet");
    expect(($(m, "#crewsaytext") as HTMLTextAreaElement).placeholder).toBe("What should Fixers build?");

    // Say a goal: it routes to "goal", the Lead plans (twice, no plan → one card)
    // and the plan waits for your OK.
    const toasts = recordToasts(m);
    say(m, "add a greeting write:hello.txt");
    await waitUntil(() => toasts.some((t) => /started as the goal/.test(t)));
    await waitUntil(() => !!act(m, "approve"), { timeoutMs: 30_000 });
    expect(pill(m)).toBe("needs your OK");
    expect(act(m, "stop")).toBeTruthy();
    expect(act(m, "apply")).toBeNull();
    expect(text(m, '#pane-crew .crewstage[data-stage="planned"] .cct')).toBe("add a greeting write:hello.txt");
    expect(text(m, "#pane-crew .crewmeta")).toContain("loom/crew/fixers/");

    // Approve: the builder builds, the tester passes it, the goal completes.
    click(act(m, "approve"));
    await waitUntil(() => !!act(m, "apply"), { timeoutMs: 30_000 });
    expect(pill(m)).toBe("completed");
    expect(act(m, "approve")).toBeNull();
    expect(act(m, "stop")).toBeNull();
    expect($$(m, '#pane-crew .crewstage[data-stage="done"] .crewcard').length).toBe(1);
    expect(text(m, '#pane-crew .crewstage[data-stage="done"] .ccm')).toContain("builder");

    // The channel carries what you said and the crew's phases.
    await waitUntil(() => !!$(m, '#pane-crew .crewev.cphase[data-phase="completed"]'));
    expect(text(m, "#pane-crew .crewev.cmine")).toContain("add a greeting");
    expect(text(m, '#pane-crew .crewev.cphase[data-phase="planned"]')).toContain("Planned 1 card");
    const crew = (await rest<{ crews: Crew[] }>("GET", "/crews")).crews[0]!;
    expect($(m, "#pane-crew [data-crew-chan]")?.getAttribute("data-crew-chan")).toBe(crew.state.channel);

    // View diff, then Apply merges the branch into the project's.
    click(act(m, "diff"));
    await waitUntil(() => !!$(m, "#pane-crew .crewdiff .dcode"));
    expect(text(m, "#pane-crew .crewdiff")).toContain("hello.txt");
    click(act(m, "apply"));
    await waitUntil(() => !!$(m, "#pane-crew .crewapplied"));
    expect(text(m, "#pane-crew .crewapplied")).toMatch(/applied to \S+/);
    expect(act(m, "apply")).toBeNull();
    expect(fs.existsSync(path.join(projectDir, "hello.txt"))).toBe(true);
    expect(m.errors.join("\n")).toBe("");
  }, 90_000);

  it("Stop and Resume follow a working goal; a teammate's question shows as a banner and your answer routes to it", async () => {
    // Runs alone too: the crew comes from the API when the first test didn't make one.
    if (!(await rest<{ crews: Crew[] }>("GET", "/crews")).crews.length) await rest("POST", "/crews", { name: "Fixers", template: "fix" });
    const m = mount();
    await openCrewTab(m);
    await waitUntil(() => $$(m, "#pane-crew .crewmate").length > 0);

    // A Lead that takes its time: planning, the lead's chip live, Stop on offer.
    say(m, "think it over sleep:8000");
    await waitUntil(() => pill(m) === "planning" && !!act(m, "stop"));
    await waitUntil(() => !!$(m, '#pane-crew .crewmate.live[data-mate="lead"] [data-live]'));
    expect(act(m, "resume")).toBeNull();
    click(act(m, "stop"));
    await waitUntil(() => pill(m) === "stopped" && !!act(m, "resume"));
    expect(act(m, "stop")).toBeNull();
    expect($(m, "#pane-crew .crewmate.live")).toBeNull();
    click(act(m, "resume"));
    await waitUntil(() => pill(m) === "planning" && !!act(m, "stop"));
    click(act(m, "stop"));
    await waitUntil(() => pill(m) === "stopped");

    // A Lead that asks: the banner names who asks what, and your reply answers it.
    say(m, "pick a palette ask: which colour?");
    await waitUntil(() => pill(m) === "needs you" && !!$(m, "#pane-crew .crewask"), { timeoutMs: 30_000 });
    expect(text(m, "#pane-crew .crewask .cwbt")).toBe("lead asks: which colour?");
    expect(($(m, "#crewsaytext") as HTMLTextAreaElement).placeholder).toMatch(/Answer lead/);
    expect(act(m, "stop")).toBeTruthy();
    // The "to" select names every teammate.
    expect($$(m, "#crewsayto option").map((o) => (o as HTMLOptionElement).value)).toEqual(["", "lead", "builder", "tester"]);
    const toasts = recordToasts(m);
    say(m, "teal");
    await waitUntil(() => toasts.some((t) => /sent as the answer/.test(t)));
    // The answer is in the channel as yours, and the Lead (which asks every turn) asked again.
    await waitUntil(() => $$(m, "#pane-crew .crewev.cmine").some((e) => /teal/.test(e.textContent ?? "")));
    await waitUntil(() => $$(m, '#pane-crew .crewev.cphase[data-phase="asks"]').length >= 2);
    expect(m.errors.join("\n")).toBe("");
  }, 90_000);
});
