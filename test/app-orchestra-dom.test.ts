/**
 * The Orchestra surfaces of the web app, actually executed.
 *
 * Same harness as app-dom.test.ts — the real APP_HTML in jsdom, against a real
 * daemon on an ephemeral port — with a project that is a git repository,
 * because an orchestra works in worktrees and refuses a folder that isn't one.
 *
 * Both agents are `echo`. As an orchestrator echo answers without a ```loom
 * actions block, so a run it conducts ends up waiting_human with a question:
 * exactly the state the Reply box and the Abort button exist for.
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

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-orch-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;

  const dir = makeProjectDir({ name: "chorus" });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# chorus\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");

  const client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(dir)).project.id;

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
  /** True when the run borrowed an existing thread rather than opening one. */
  inPlace?: boolean;
  question?: string;
  tasks?: Array<{ id: string; status: string }>;
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

async function runStatus(id: string): Promise<Run> {
  return (await rest<{ run: Run }>("GET", `/orchestra/${id}`)).run;
}

interface Mounted {
  window: JSDOM["window"];
  /** Uncaught exceptions thrown by the page's own JavaScript. */
  errors: string[];
  close: () => void;
  /**
   * Simulate the daemon restarting with a new token under a live window: every
   * API call 401s until the page bootstraps a fresh one. Exactly what happens
   * when `loom up --restart` runs with the app already open.
   */
  expireToken: () => void;
}

/**
 * Boot the app in a DOM. `desktop` drives the same media query the app uses to
 * choose its layout, so both are reachable from a test.
 */
function mount({
  desktop = true,
  hash = "",
  token = clientToken as string | null,
  bootstrap = true,
  chat = "",
  helloDelayMs = 0,
} = {}): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));

  // The app is a live thing: it polls on intervals and holds a WebSocket. Both
  // outlive the assertion unless someone takes them away.
  const sockets: WebSocket[] = [];
  let closed = false;
  let stale = false;
  const never = new Promise<never>(() => {}); // settles never, so nothing runs post-teardown

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app${hash}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // Capabilities a browser has and jsdom doesn't. Supplied rather than
      // filtered out of `errors`: jsdom reports these as page errors, and a
      // test that ignores whole classes of error stops being able to tell you
      // when the app really throws. The app legitimately scrolls the thread to
      // the bottom and watches panes for resize.
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver;

      // jsdom has no matchMedia; the app picks its layout with one
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
      // relative paths, resolved against the real daemon. Once the window is
      // torn down, in-flight requests are dropped rather than resolved into a
      // document that no longer exists — that noise isn't the app's fault.
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        // `bootstrap: false` simulates a remote (non-loopback) visitor — a phone
        // on the tailnet — for whom the local admin bootstrap is refused. The
        // real daemon would 403 by socket address, which jsdom can't fake.
        if (!bootstrap && new URL(String(input), baseUrl).pathname === "/api/bootstrap") {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "not a local request" }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
          ) as unknown as Promise<Response>;
        }
        const p = new URL(String(input), baseUrl).pathname;
        if (p.endsWith("/agents/models")) {
          return Promise.resolve(new Response(JSON.stringify({ models: ["test/model"] })));
        }
        // A rotated daemon token: everything 401s until the page re-bootstraps,
        // at which point it is holding the new one and calls succeed again.
        if (stale && p.startsWith("/api/")) {
          if (p === "/api/bootstrap") stale = false;
          else
            return Promise.resolve(
              new Response(JSON.stringify({ error: "unauthorized" }), {
                status: 401,
                headers: { "content-type": "application/json" },
              }),
            ) as unknown as Promise<Response>;
        }
        return fetch(new URL(String(input), baseUrl), init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      // jsdom has no WebSocket either. A real one, remembered so close() can
      // hang up: an open socket keeps the daemon's server.close() waiting.
      window.WebSocket = class extends WebSocket {
        private helloSeen = helloDelayMs === 0;
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
        override emit(event: string | symbol, ...args: unknown[]): boolean {
          if (event === "message" && helloDelayMs) {
            const frame = JSON.parse(String(args[0]));
            if (frame.type === "hello") {
              setTimeout(() => { if (!closed) { this.helloSeen = true; super.emit(event, ...args); } }, helloDelayMs);
              return true;
            }
            // Events published before subscription aren't delivered to a real
            // socket. Reproduce that gap while the daemon starts a fast run.
            if (!this.helloSeen && frame.type === "event") return true;
          }
          return super.emit(event, ...args);
        }
      } as unknown as typeof window.WebSocket;
      if (token) window.localStorage.setItem("loomClientToken", token);
      // these exercise Developer mode's tools (Orchestra, Crew, the panel, the graph)
      window.localStorage.setItem("loomDevMode", "1");
      // open straight onto a conversation, the way a reload remembers one
      if (chat) window.localStorage.setItem(`loomChat:${projectId}`, chat);
      // Abort asks first; jsdom has no dialogs, and a test always means yes
      window.confirm = () => true;
    },
  });

  const m: Mounted = {
    window: dom.window,
    errors,
    expireToken: () => {
      stale = true;
    },
    close: () => {
      closed = true;
      for (const s of sockets) {
        try {
          // Drop the page's handlers first, then kill the socket outright.
          // A polite close() would fire the app's onclose into a document that
          // is about to stop existing. terminate() doesn't, but a socket killed
          // mid-handshake emits "closed before the connection was established" —
          // and with every listener gone, an emitted "error" on an EventEmitter
          // is thrown rather than delivered. Hence the deliberate empty ear.
          s.removeAllListeners();
          s.on("error", () => {});
          s.terminate();
        } catch {
          /* already gone */
        }
      }
      dom.window.close(); // stops the app's intervals
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
/**
 * Wait for a control to be *wired*, not merely present.
 *
 * renderProject writes its markup and binds handlers in the same pass, but it
 * can run more than once — a hashchange, a refresh — and the node you grabbed a
 * tick ago may have been replaced by one whose onclick hasn't been attached
 * yet. Clicking that is a no-op that looks exactly like a broken feature.
 */
const ready = (m: Mounted, sel: string) =>
  waitUntil(() => {
    // A form is wired by onsubmit, a button by onclick. Checking only onclick
    // means waiting eight seconds for a handler a <form> never has, then
    // blaming the feature.
    const el = $(m, sel) as (HTMLElement & { onclick?: unknown; onsubmit?: unknown }) | null;
    return !!(el?.onclick || el?.onsubmit);
  });

const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};


const box = (m: Mounted) => $(m, "#box") as HTMLTextAreaElement;
const shown = (el: Element | null) => !!el && (el as HTMLElement).style.display !== "none";
const mousedown = (m: Mounted, el: Element | null) => {
  if (!el) throw new Error("no such element");
  el.dispatchEvent(new m.window.MouseEvent("mousedown", { bubbles: true }));
};


describe("web app · composer modes", () => {
  it("chooses a model and count before adding Orchestra workers", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await ready(m, '#cowadd');
    click($(m, '#cowadd'));
    await ready(m, '.cfscrim form');
    await waitUntil(() => !!$(m, '#addmodels option'));
    expect(($(m, '#addmodels option') as HTMLOptionElement).value).toBe("test/model");
    expect(($(m, '#addcount') as HTMLInputElement).value).toBe("1");
    const model = $(m, '#addmodel') as HTMLInputElement;
    expect(model.required).toBe(true);
    click($(m, '.cfscrim [type="submit"]'));
    expect(model.checkValidity()).toBe(false);
    click($(m, '.cfscrim [data-cancel]'));
    await waitUntil(() => !($(m, '#cowadd') as HTMLButtonElement).disabled);
    expect($(m, '.cfscrim form')).toBeNull();
    expect(m.errors.join("\n")).toBe("");
  });

  it("Orchestrate swaps the agent picker for an orchestrator, workers and a parallel stepper", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '#cmode [data-cmode="orch"]');
    // Chat is the default: one agent, the arrow send, no orchestra controls
    expect($(m, '#cmode [data-cmode="chat"]')?.classList.contains("on")).toBe(true);
    expect(shown($(m, "#corch"))).toBe(false);

    click($(m, '#cmode [data-cmode="orch"]'));
    await waitUntil(() => shown($(m, "#corch")) && !!$(m, "#corchpick"));
    // no claude-code on this roster, so the first adapter conducts
    expect(text(m, "#corchpick")).toContain("plannerbot");
    // every adapter works by default, the orchestrator included
    // The workers are the chips that name one; the row also carries the
    // dashed "+ model" chip, which is an action rather than a worker.
    const chips = [...m.window.document.querySelectorAll("#cowk [data-wk]")];
    expect(chips.map((c) => c.getAttribute("data-wk"))).toEqual(["plannerbot", "execbot"]);
    expect($(m, "#cowadd")?.classList.contains("cowadd")).toBe(true);
    // Each chip says which model it will run, and so does the orchestrator.
    expect(chips.map((c) => c.querySelector("[data-modelof]")?.getAttribute("data-modelof"))).toEqual([
      "plannerbot",
      "execbot",
    ]);
    expect($(m, "#corchpick [data-modelof]")?.getAttribute("data-modelof")).toBe("plannerbot");
    expect(chips[0].textContent).toContain("plannerbot");
    expect(chips.every((c) => c.classList.contains("on"))).toBe(true);
    expect(text(m, "#cpar")).toBe("4");
    expect(shown($(m, "#orchsend"))).toBe(true);
    expect(text(m, "#orchsend")).toBe("Orchestrate");
    expect(shown($(m, "#send"))).toBe(false);
    expect(shown($(m, "#cagent"))).toBe(false);

    // the stepper moves, and stops at its bounds
    click($(m, '#corch [data-step="1"]'));
    await waitUntil(() => text(m, "#cpar") === "5");
    for (let i = 0; i < 12; i++) click($(m, '#corch [data-step="1"]'));
    await waitUntil(() => text(m, "#cpar") === "12");
    // a worker chip toggles off
    click($(m, '#cowk [data-wk="execbot"]'));
    await waitUntil(() => !$(m, '#cowk [data-wk="execbot"]')?.classList.contains("on"));

    // the orchestrator is a real dropdown over the roster
    click($(m, "#corchpick"));
    await waitUntil(() => m.window.document.querySelectorAll("#cmenu [data-oi]").length === 2);
    mousedown(m, m.window.document.querySelectorAll("#cmenu [data-oi]")[1]);
    await waitUntil(() => text(m, "#corchpick").includes("execbot"));

    // and back to Chat restores the one-agent composer
    click($(m, '#cmode [data-cmode="chat"]'));
    await waitUntil(() => !shown($(m, "#corch")));
    expect(shown($(m, "#cagent"))).toBe(true);
    expect(shown($(m, "#orchsend"))).toBe(false);
    expect(m.errors.join("\n")).toBe("");
  });

  it("the agent dropdown lists the roster with a disabled Cursor entry", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, "#cagent");
    click($(m, "#cagent"));
    await waitUntil(() => m.window.document.querySelectorAll("#cmenu [data-ai]").length === 2);
    const soon = $(m, "#cmenu .cmi.soon");
    expect(soon?.textContent).toContain("Cursor");
    expect(soon?.textContent).toContain("coming soon");
    expect(soon?.hasAttribute("data-ai"), "Cursor can't be picked yet").toBe(false);
    // every roster agent carries a glyph, brand or monogram — never a blank
    expect(m.window.document.querySelectorAll("#cmenu [data-ai] .ic > *").length).toBe(2);
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · orchestra", () => {
  it("orchestrates from the composer, then answers and aborts the run from its view", async () => {
    const m = mount({ hash: `#p/${projectId}`, helloDelayMs: 1000 });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await ready(m, "#orchsend");

    const goal = `tidy the readme ${Date.now()}`;
    box(m).value = goal;
    click($(m, "#orchsend"));

    // The run answers in the thread the goal was given in (#100): no new
    // thread, no jump to one, and the Thread tab stays in front.
    let run!: Run;
    await waitUntil(async () => {
      const { runs } = await rest<{ runs: Run[] }>("GET", "/orchestra");
      const hit = runs.find((r) => r.goal === goal);
      if (hit) run = hit;
      return !!hit;
    }, { timeoutMs: 30_000 });
    expect(run.chat).toBe("main");
    expect(run.inPlace).toBe(true);
    await waitUntil(() => text(m, "#feed").includes("Orchestra started")).catch(async (error) => {
      const events = await rest<{ events: unknown[] }>("GET", "/events?limit=30&chat=main");
      throw new Error(`${error.message}\nfeed: ${text(m, "#feed")}\npage errors: ${m.errors.join("; ")}\nevents: ${JSON.stringify(events.events)}`);
    });
    expect($(m, '.tab[data-tab="thread"]')?.classList.contains("active")).toBe(true);
    // …and the composer did not move you: still Main, stored or implied.
    expect([null, "main"]).toContain(m.window.localStorage.getItem(`loomChat:${projectId}`));

    // The Orchestra view still has it, for the parts of a run a thread can't
    // show — the board, Reply, Abort.
    click($(m, '.tab[data-tab="orchestra"]'));
    await waitUntil(() => shown($(m, "#pane-orchestra")) && text(m, "#pane-orchestra .ogoal") === goal);

    // echo never plans, so the orchestrator asks — the Reply box appears, live
    await waitUntil(() => !!$(m, "#pane-orchestra .oask #oreply"), { timeoutMs: 60_000 });
    expect(text(m, "#pane-orchestra .opill")).toBe("needs you");
    expect(text(m, "#pane-orchestra .oask .oq")).toContain((await runStatus(run.id)).question ?? "");
    expect(text(m, "#pane-orchestra .ometa")).toMatch(/Round\s*\d+\/\d+/);
    expect(text(m, "#pane-orchestra .ometa")).toContain("loom/");

    // A reply goes to the orchestrator, which turns another round. The view
    // redraws on every event the run emits, so the box can be replaced between
    // finding it and using it: fill and send inside one render, and retry.
    // 60s, like the waits either side of it: what this is waiting for is a
    // real orchestrator round, and on a saturated runner a round takes longer
    // than thirty seconds. (It failed here once on CI and nowhere else.)
    await waitUntil(() => {
      const box = $(m, "#oreply") as HTMLTextAreaElement | null;
      const send = $(m, "#oreplybtn");
      if (!box || !send) return false;
      box.value = "just stop after one task";
      click(send);
      return true;
    }, { timeoutMs: 60_000 });
    await waitUntil(async () => {
      const r = await runStatus(run.id);
      return r.status === "waiting_human" && (await rest<{ events: Array<{ kind: string; payload: { phase?: string } }> }>(
        "GET", `/events?limit=200&chat=${encodeURIComponent(run.chat)}`,
      )).events.filter((e) => e.kind === "orchestra" && e.payload.phase === "waiting").length >= 2;
    }, { timeoutMs: 60_000 });

    // Abort, while it's active
    await ready(m, "#oabort");
    click($(m, "#oabort"));
    await waitUntil(() => text(m, "#pane-orchestra .opill") === "aborted");
    expect((await runStatus(run.id)).status).toBe("aborted");
    // a finished run no longer offers Abort; this one ended before any task
    // finished, so there is nothing on its branch to Apply — only Clean up
    expect($(m, "#oabort")).toBeFalsy();
    expect($(m, "#oapply")).toBeFalsy();
    expect($(m, "#oclean")).toBeTruthy();
    expect(text(m, "#pane-orchestra .oruns")).toContain(goal.slice(0, 20));
    expect(m.errors.join("\n")).toBe("");
    // Two real orchestrator rounds and an abort, each an agent turn through the
    // daemon. On a loaded CI runner that is minutes, not seconds: the budget is
    // for "something is broken", not for "the machine is busy".
  }, 150_000);

  it("a race shows its entrants side by side, and Pick this one applies just that one", async () => {
    const { run } = await rest<{ run: Run }>("POST", "/orchestra", {
      goal: "write:raced.txt",
      race: true,
      workers: ["plannerbot", "execbot"],
    });
    await waitUntil(async () => (await runStatus(run.id)).status === "completed", { timeoutMs: 60_000 });
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '.tab[data-tab="orchestra"]');
    click($(m, '.tab[data-tab="orchestra"]'));
    await waitUntil(() => {
      const row = Array.prototype.find.call(m.window.document.querySelectorAll(".orun"), (e: Element) => (e.textContent ?? "").includes("write:raced.txt"));
      if (row && !$(m, "#pane-orchestra .raceboard")) click(row);
      return !!$(m, "#pane-orchestra .raceboard");
    });
    expect(m.window.document.querySelectorAll("#pane-orchestra .racecard").length).toBe(2);
    // a race has no orchestrator, rounds, or whole-run Apply — you pick an entrant
    expect(text(m, "#pane-orchestra .ometa")).toContain("Race");
    expect(text(m, "#pane-orchestra .ometa")).not.toMatch(/Round|Orchestrator/);
    expect($(m, "#oapply")).toBeFalsy();
    expect(m.window.document.querySelectorAll("[data-racepick]").length).toBe(2);

    // (the mount answers confirm() with yes)
    click($(m, "[data-racepick]"));
    await waitUntil(() => !!$(m, "#pane-orchestra .racecard.picked .rpicked"));
    expect($(m, "[data-racepick]")).toBeFalsy();
    expect((await runStatus(run.id)) as Run & { applied?: { task?: string } }).toMatchObject({ applied: { task: expect.stringMatching(/^race-/) } });
    expect(m.errors.join("\n")).toBe("");
  }, 90_000);

  it("Ask several sends the prompt to each entrant on its model; the cards show model and diff, and Keep this one applies it (#377)", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await ready(m, '[data-omode="race"]');
    expect(text(m, '[data-omode="race"]')).toContain("Ask several");
    click($(m, '[data-omode="race"]'));
    // plannerbot as itself, plus execbot on a pinned model
    click($(m, "#cowfleetadd"));
    await waitUntil(() => !!$(m, "#cmenu.cfleet #cfadd"));
    ($(m, "#cfagent") as HTMLSelectElement).value = "execbot";
    ($(m, "#cfmodel") as HTMLInputElement).value = "gpt-5.6-sol";
    ($(m, "#cfcount") as HTMLSelectElement).value = "1";
    click($(m, "#cfadd"));
    await waitUntil(() => m.window.document.querySelectorAll("#cowk .cowfleet").length === 1);
    // only plannerbot ticked among the plain agents
    // (chips redraw on every click, so look again each time)
    for (let i = 0; i < 6; i++) {
      const extra = [...m.window.document.querySelectorAll("#cowk [data-wk].on")].find((b) => b.getAttribute("data-wk") !== "plannerbot");
      if (!extra) break;
      click(extra);
    }
    const plain = $(m, '#cowk [data-wk="plannerbot"]');
    if (plain && !plain.classList.contains("on")) click(plain);
    (($(m, "#box")) as HTMLTextAreaElement).value = "write:compared.txt";
    click($(m, "#orchsend"));
    let runId = "";
    await waitUntil(async () => {
      const { runs } = await rest<{ runs: Array<Run & { compare?: boolean }> }>("GET", "/orchestra");
      const hit = runs.find((r) => r.goal === "write:compared.txt");
      if (hit) runId = hit.id;
      return Boolean(hit?.compare);
    }, { timeoutMs: 30_000 });
    try {
      await waitUntil(async () => (await runStatus(runId)).status === "completed", { timeoutMs: 60_000 });
      click($(m, '.tab[data-tab="orchestra"]'));
      await waitUntil(() => {
        const row = Array.prototype.find.call(m.window.document.querySelectorAll(".orun"), (e: Element) => (e.textContent ?? "").includes("write:compared.txt"));
        if (row && !$(m, "#pane-orchestra .raceboard")) click(row);
        return m.window.document.querySelectorAll("#pane-orchestra .racecard").length === 2;
      }, { timeoutMs: 20_000 });
      expect(text(m, "#pane-orchestra .ometa")).toContain("Ask several");
      expect(text(m, "#pane-orchestra .racecard .rmodel")).toBe("gpt-5.6-sol");
      // the view catches up with the finished run (diffs and Keep arrive with its last refresh)
      await waitUntil(() => !!$(m, "#pane-orchestra .racecard .rdiff .ins") && m.window.document.querySelectorAll("[data-racepick]").length === 2, { timeoutMs: 20_000 });
      const keep = [...m.window.document.querySelectorAll("[data-racepick]")];
      expect(keep.map((b) => b.textContent)).toEqual(["Keep this one", "Keep this one"]);
      click(keep[0]!);
      await waitUntil(() => !!$(m, "#pane-orchestra .racecard.picked .rpicked"), { timeoutMs: 20_000 });
      expect(m.errors.join("\n")).toBe("");
    } finally {
      m.window.localStorage.removeItem(`loomOrch:${projectId}`);
    }
  }, 120_000);

  it("renders orchestra events in the thread as sentences, not JSON", async () => {
    const goal = `thread rows ${Date.now()}`;
    const { run } = await rest<{ run: Run }>("POST", "/orchestra", { goal, maxParallel: 3 });
    await waitUntil(async () => (await runStatus(run.id)).status === "waiting_human", { timeoutMs: 30_000 });

    const m = mount({ hash: `#p/${projectId}`, chat: run.chat });
    await waitUntil(() => text(m, "#feed").includes("Orchestra started"));
    const feed = text(m, "#feed");
    expect(feed).toMatch(/Orchestra started — plannerbot is orchestrating plannerbot, execbot \(3 in parallel\)/);
    await waitUntil(() => text(m, "#feed").includes("Orchestrator asks:"));
    // the orchestra rows are system lines, and nothing leaks the payload shape.
    // (Only these rows: Loom's briefing to the orchestrator legitimately quotes
    // the ```loom {"actions": …} format it asks for.)
    const rows = [...m.window.document.querySelectorAll("#feed .sys.orch")].map((r) => r.textContent ?? "");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const leak of ['"phase"', '"runId"', "{", "[object Object]", "undefined"]) {
      expect(rows.join("\n"), `raw payload leaked: ${leak}`).not.toContain(leak);
    }
    // Loom's long briefing to the orchestrator is folded, not a wall of text
    expect($(m, "#feed details.orchbrief")).toBeTruthy();
    // in the orchestra's own thread, the composer talks to its orchestrator
    await waitUntil(() => text(m, "#hint").includes("orchestra thread"));
    // the tab strip marks a live run
    await waitUntil(() => shown($(m, "#orchtdot")));
    expect(m.errors.join("\n")).toBe("");
  });

  it("the phone opens the Orchestra view as a sheet", async () => {
    const goal = `phone sheet ${Date.now()}`;
    await rest("POST", "/orchestra", { goal });
    const m = mount({ desktop: false, hash: `#p/${projectId}` });
    await ready(m, "#orchbtn");
    click($(m, "#orchbtn"));
    await waitUntil(() => text(m, "#orchsheet .ogoal") === goal);
    expect($(m, "#orchsheet #oabort")).toBeTruthy();
    click($(m, "#orchbtn"));
    await waitUntil(() => !$(m, "#orchsheet"));
    expect(m.errors.join("\n")).toBe("");
  });

  it("queues a second goal behind the running one instead of refusing it", async () => {
    // one goal runs at a time — a direct second start is still a 400, so the
    // composer lines it up rather than throwing away what you wrote
    await rest("POST", "/orchestra", { goal: `first ${Date.now()}` });
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await ready(m, "#orchsend");
    box(m).value = "a second, concurrent goal";
    click($(m, "#orchsend"));
    await waitUntil(() => [...m.window.document.querySelectorAll("#cqueue .cqtext")].some((e) => e.textContent === "a second, concurrent goal"));
    // it's the orchestrator's, and the box is clear because nothing was lost
    const view = await rest<{ queue: Array<{ text: string; target: { kind: string } }> }>("GET", "/queue");
    expect(view.queue.map((i) => i.text)).toEqual(["a second, concurrent goal"]);
    expect(view.queue[0]!.target.kind).toBe("orchestra");
    expect(box(m).value).toBe("");
    await rest("DELETE", "/queue");
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · settings sections don't overwrite each other", () => {
  it("a slow Setup response arriving after you switched sections is dropped", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, ".sfoot #setupbtn"));
    // Setup probes every agent CLI; on a slow machine that answer lands after
    // you've moved on. Hold it back until the other section has rendered.
    const realFetch = m.window.fetch;
    let releaseSetup!: () => void;
    const setupHeld = new Promise<void>((r) => (releaseSetup = r));
    let setupAnswered: Promise<unknown> = Promise.resolve();
    m.window.fetch = ((input: string, init?: RequestInit) => {
      const p = realFetch(input, init);
      if (!String(input).includes("/api/setup")) return p;
      const held = setupHeld.then(() => p);
      setupAnswered = held.then((r) => (r as Response).clone().text());
      return held;
    }) as typeof m.window.fetch;

    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, '.setnav [data-sec="cloud"]'));
    click($(m, '.setnav [data-sec="cloud"]'));
    await waitUntil(() => !!$(m, "#setpane #cloudurl"));
    releaseSetup();
    await setupAnswered; // the late answer has actually arrived…
    await new Promise((r) => setTimeout(r, 200)); // …and had its chance to paint
    expect($(m, "#setpane #cloudurl"), "the Cloud section survived the late Setup answer").toBeTruthy();
    expect(text(m, "#setpane")).not.toContain("What this machine still needs");
  });
});

describe("web app · My issues (#382)", () => {
  it("lists issues assigned to you, starts the ticked ones, and shows the already-started one as a link", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    const issues = [
      { source: "github", id: "https://github.com/acme/app/issues/7", number: 7, title: "Fix the login race", url: "https://github.com/acme/app/issues/7", labels: ["loom"] },
      { source: "github", id: "https://github.com/acme/app/issues/9", number: 9, title: "Dark mode", url: "https://github.com/acme/app/issues/9", labels: [], started: { chat: "c9" } },
    ];
    const posted: unknown[] = [];
    // gh isn't ours to call in a test: answer the intake routes here, everything else for real
    const realFetch = m.window.fetch;
    m.window.fetch = ((input: string, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("/intake/start")) {
        posted.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(JSON.stringify({ issues: [{ ...issues[0], started: { chat: "c7" } }] }), { headers: { "content-type": "application/json" } }));
      }
      if (u.includes("/intake")) return Promise.resolve(new Response(JSON.stringify({ issues }), { headers: { "content-type": "application/json" } }));
      return realFetch(input, init);
    }) as typeof m.window.fetch;
    await ready(m, '.tab[data-tab="board"]');
    click($(m, '.tab[data-tab="board"]'));
    await waitUntil(() => !!$(m, "#bintake"), { timeoutMs: 20_000 });
    click($(m, "#bintake"));
    await waitUntil(() => m.window.document.querySelectorAll(".intakemodal .ikrow").length === 2);
    expect(text(m, ".intakemodal")).toContain("Fix the login race");
    // the started one can't be started twice; it opens its chat instead
    expect($(m, '.intakemodal [data-ik="https://github.com/acme/app/issues/9"]')).toBeNull();
    expect($(m, '.intakemodal [data-ikopen="c9"]')).toBeTruthy();
    expect(($(m, "#ikstart") as HTMLButtonElement).disabled).toBe(true);
    const cb = $(m, '.intakemodal [data-ik="https://github.com/acme/app/issues/7"]') as HTMLInputElement;
    cb.checked = true; cb.dispatchEvent(new m.window.Event("change", { bubbles: true }));
    click($(m, '#ikmode [data-mode="orchestra"]'));
    expect(text(m, "#ikstart")).toBe("Start 1");
    click($(m, "#ikstart"));
    await waitUntil(() => posted.length === 1);
    expect(posted[0]).toMatchObject({ source: "github", ids: ["https://github.com/acme/app/issues/7"], mode: "orchestra" });
    // it reloads the list after starting; let that land before the window goes
    await waitUntil(() => text(m, "#ikstart") === "Start" && m.window.document.querySelectorAll(".intakemodal .ikrow").length === 2);
    await new Promise((r) => setTimeout(r, 200));
  });
});

describe("web app · saved fleets and the model scoreboard (#406)", () => {
  it("saves the fleet rows under a name, adds the saved fleet as one chip, and opens the scoreboard", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    const admin = readDaemonConfig()!.adminToken;
    try {
      m.window.prompt = () => "squad";
      await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
      await ready(m, '#cmode [data-cmode="orch"]');
      click($(m, '#cmode [data-cmode="orch"]'));
      await waitUntil(() => shown($(m, "#corch")) && !!$(m, "#cowfleetadd"));
      click($(m, "#cowfleetadd"));
      await waitUntil(() => !!$(m, "#cmenu.cfleet #cfadd"));
      expect($(m, "#cfsave")).toBeNull(); // nothing to save yet
      ($(m, "#cfagent") as HTMLSelectElement).value = "execbot";
      ($(m, "#cfmodel") as HTMLInputElement).value = "gpt-5.6";
      ($(m, "#cfcount") as HTMLSelectElement).value = "2";
      click($(m, "#cfadd"));
      await waitUntil(() => !!$(m, "#cowk .cowfleet"));
      click($(m, "#cowfleetadd"));
      await waitUntil(() => !!$(m, "#cmenu.cfleet #cfsave"));
      click($(m, "#cfsave"));
      const fleets = async () => ((await (await fetch(`${baseUrl}/api/fleets`, { headers: { Authorization: `Bearer ${admin}` } })).json()) as { fleets: Array<{ name: string; spec: string }> }).fleets;
      await waitUntil(async () => (await fleets()).some((f) => f.name === "squad"));
      expect((await fleets()).find((f) => f.name === "squad")!.spec).toBe("execbot@gpt-5.6x2");
      // take the row out, then add the saved fleet back as one chip that goes out as @squad
      await waitUntil(() => !$(m, "#cmenu.cfleet"));
      click($(m, "#cowk .cowfleet"));
      await waitUntil(() => !$(m, "#cowk .cowfleet"));
      click($(m, "#cowfleetadd"));
      await waitUntil(() => !!$(m, '#cfsaved [data-saved="squad"]'));
      click($(m, '#cfsaved [data-saved="squad"]'));
      await waitUntil(() => text(m, "#cowk .cowfleet").includes("squad"));
      expect(text(m, "#cowk .cowfleet")).toContain("saved fleet");
      expect(JSON.parse(m.window.localStorage.getItem(`loomOrch:${projectId}`) ?? "{}").fleet).toEqual([{ saved: "squad", spec: "execbot@gpt-5.6x2" }]);
      // the scoreboard opens from the same row, for this project, and can widen to all
      click($(m, "#corch [data-scoreboard]"));
      await waitUntil(() => !!$(m, ".scoremodal") && !text(m, "#sbtable").includes("Loading") && !$(m, "#sbtable .loader"));
      expect($(m, '#sbscope button.on')!.getAttribute("data-v")).toBe(projectId);
      click($(m, '#sbscope [data-v="all"]'));
      await waitUntil(() => $(m, '#sbscope button.on')!.getAttribute("data-v") === "all");
      click($(m, "#sbx"));
      await waitUntil(() => !$(m, ".scoremodal"));
      expect(m.errors.join("\n")).toBe("");
    } finally {
      m.window.localStorage.removeItem(`loomOrch:${projectId}`);
      await fetch(`${baseUrl}/api/fleets?name=squad`, { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } }).catch(() => {});
    }
  });
});

describe("web app · accounts (#379)", () => {
  it("adds a second Codex account, shows the sign-in command for it, and forgets it", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, ".sfoot #setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, '.setnav [data-sec="accounts"]'));
    click($(m, '.setnav [data-sec="accounts"]'));
    await waitUntil(() => !!$(m, "#setpane #acctadd"));
    ($(m, "#acctkind") as HTMLSelectElement).value = "codex";
    ($(m, "#acctlabel") as HTMLInputElement).value = "work";
    click($(m, "#acctadd"));
    await waitUntil(() => !!$(m, "#setpane [data-acctlogin]"));
    expect(text(m, "#setpane .acctrow .st")).toContain("work");
    click($(m, "#setpane [data-acctlogin]"));
    await waitUntil(() => text(m, "#setpane [data-acctcmd]").includes("CODEX_HOME"));
    expect(text(m, "#setpane [data-acctcmd]")).toContain("codex login");
    click($(m, "#setpane [data-acctforget]"));
    await waitUntil(() => !$(m, "#setpane [data-acctlogin]"));
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · move a chat to another machine (#364)", () => {
  it("offers your online runners, confirms, and moves the chat there", async () => {
    const { chat } = await rest<{ chat: { id: string } }>("POST", "/chats", { title: "travelling chat", agentId: "plannerbot" });
    try {
      const m = mount({ hash: `#p/${projectId}` });
      const moved: unknown[] = [];
      const realFetch = m.window.fetch;
      m.window.fetch = ((input: string, init?: RequestInit) => {
        const u = String(input);
        const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } }));
        if (u.endsWith("/team/runners")) return json({ runners: [
          { deviceId: "dev-mini", label: "studio mini", online: true, mine: true, kinds: ["echo"], shared: false, lastSeen: Date.now(), github: "" },
          { deviceId: "dev-off", label: "old laptop", online: false, mine: true, kinds: [], shared: false, lastSeen: 0, github: "" },
          { deviceId: "dev-theirs", label: "priya's box", online: true, mine: false, kinds: [], shared: true, lastSeen: Date.now(), github: "priya" },
        ], jobs: [] });
        if (u.includes(`/chats/${chat.id}/move`)) { moved.push(JSON.parse(String(init?.body))); return json({ chat: { id: chat.id, movedTo: { device: "dev-mini", name: "studio mini", at: Date.now(), jobId: "j1" } }, jobId: "j1" }); }
        return realFetch(input, init);
      }) as typeof m.window.fetch;
      await waitUntil(() => !!$(m, `.crow[data-chat="${chat.id}"]`));
      $(m, `.crow[data-chat="${chat.id}"]`)!.dispatchEvent(new m.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      await waitUntil(() => !!$(m, ".menupop"));
      click([...m.window.document.querySelectorAll(".menupop .pickrow")].find((b) => (b.textContent ?? "").includes("Move to another machine")) as HTMLElement);
      // only my own online machines: not the offline one, not a teammate's
      await waitUntil(() => [...m.window.document.querySelectorAll(".menupop .pickrow")].some((b) => (b.textContent ?? "").includes("studio mini")));
      const labels = [...m.window.document.querySelectorAll(".menupop .pickrow")].map((b) => b.textContent ?? "");
      expect(labels.some((l) => l.includes("old laptop") || l.includes("priya"))).toBe(false);
      // (the mount answers confirm() with yes)
      click([...m.window.document.querySelectorAll(".menupop .pickrow")].find((b) => (b.textContent ?? "").includes("studio mini")) as HTMLElement);
      await waitUntil(() => moved.length === 1);
      expect(moved[0]).toEqual({ to: "dev-mini" });
      await new Promise((r) => setTimeout(r, 200));
      expect(m.errors.join("\n")).toBe("");
    } finally {
      await rest("DELETE", `/chats/${chat.id}`).catch(() => {});
    }
  });
});

describe("web app · Loom Cloud settings", () => {
  it("has its own section: what it is, the Supabase fields, and the switches", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, ".sfoot #setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, '.setnav [data-sec="cloud"]'));
    expect(text(m, '.setnav [data-sec="cloud"]')).toBe("Loom Cloud");
    click($(m, '.setnav [data-sec="cloud"]'));
    await waitUntil(() => !!$(m, "#setpane #cloudurl"));
    const pane = text(m, "#setpane");
    expect(pane).toContain("Reach this computer from your phone on any network.");
    expect(pane).toContain("Supabase only relays ciphertext");
    expect($(m, "#cloudkey")).toBeTruthy();
    expect(text(m, "#cloudon")).toMatch(/Enable|Save/);
    expect($(m, "#cloudrot")).toBeTruthy();
    // a status pill, read from GET /api/cloud rather than assumed
    expect($(m, "#cloudst .updpill")).toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  });

  it("a worker's report shows on its task card while it works, and needs-input says so at once (#374)", async () => {
    // the echo orchestrator repeats a real actions block, so the run gets one long-running task
    const goal = "```loom\n" + JSON.stringify({ actions: [{ type: "spawn", id: "t1", title: "Long task", agent: "execbot", prompt: "sleep:30000 working" }] }).replaceAll("sleep:", "\\u0073leep:") + "\n```";
    const { run } = await rest<{ run: Run }>("POST", "/orchestra", { goal, orchestrator: "plannerbot", workers: ["execbot"] });
    try {
      await waitUntil(async () => (await runStatus(run.id)).status === "waiting_human", { timeoutMs: 30_000 });
      await rest("POST", `/orchestra/${run.id}/reply`, { text: goal });
      await waitUntil(async () => ((await runStatus(run.id)).tasks ?? []).some((t: { id: string; status: string }) => t.id === "t1" && t.status === "running"), { timeoutMs: 30_000 });
      const m = mount({ hash: `#p/${projectId}` });
      await waitUntil(() => !!$(m, '.tab[data-tab="orchestra"]'));
      click($(m, '.tab[data-tab="orchestra"]'));
      await waitUntil(() => !!$(m, '#pane-orchestra .otask[data-otask="t1"]'), { timeoutMs: 20_000 });
      expect($(m, '#pane-orchestra .otask[data-otask="t1"] .orep')).toBeNull();
      const report = (kind: string, text: string) => fetch(`${baseUrl}/api/projects/${projectId}/orchestra/${run.id}/tasks/t1/report`, {
        method: "POST", headers: { Authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ kind, text }),
      });
      expect((await report("checkpoint", "parser done, writing tests")).status).toBe(200);
      await waitUntil(() => text(m, '#pane-orchestra .otask[data-otask="t1"] .orep').includes("parser done, writing tests"));
      expect(text(m, '#pane-orchestra .otask[data-otask="t1"] .orepk')).toBe("checkpoint");
      expect((await report("needs_input", "which database?")).status).toBe(200);
      await waitUntil(() => $(m, '#pane-orchestra .otask[data-otask="t1"] .orep')?.classList.contains("warn") === true);
      expect(text(m, '#pane-orchestra .otask[data-otask="t1"] .orep')).toContain("which database?");
      // the earlier checkpoint is still there, in the tooltip
      expect($(m, '#pane-orchestra .otask[data-otask="t1"] .orep')!.getAttribute("title")).toContain("parser done");
      expect(m.errors.join("\n")).toBe("");
    } finally {
      await rest("POST", `/orchestra/${run.id}/abort`).catch(() => {});
      await waitUntil(async () => !["running", "waiting_human", "planning", "reviewing"].includes((await runStatus(run.id)).status), { timeoutMs: 30_000 }).catch(() => {});
    }
  }, 90_000);

  it("a fleet row adds N workers of one agent on a model, is remembered, and goes out as agent@model×N (#369)", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await waitUntil(() => shown($(m, "#corch")) && !!$(m, "#cowfleetadd"));
    click($(m, "#cowfleetadd"));
    await waitUntil(() => !!$(m, "#cmenu.cfleet #cfadd"));
    ($(m, "#cfagent") as HTMLSelectElement).value = "execbot";
    ($(m, "#cfmodel") as HTMLInputElement).value = "gpt-5.6-sol";
    ($(m, "#cfcount") as HTMLSelectElement).value = "2";
    click($(m, "#cfadd"));
    await waitUntil(() => !!$(m, "#cowk .cowfleet"));
    expect(text(m, "#cowk .cowfleet")).toContain("gpt-5.6-sol");
    expect(text(m, "#cowk .cowfleet")).toContain("\u00d72");
    expect(JSON.parse(m.window.localStorage.getItem(`loomOrch:${projectId}`) ?? "{}").fleet).toEqual([{ agent: "execbot", model: "gpt-5.6-sol", count: 2 }]);
    // a chip click takes a row out again
    click($(m, "#cowfleetadd"));
    await waitUntil(() => !!$(m, "#cmenu.cfleet #cfadd"));
    ($(m, "#cfmodel") as HTMLInputElement).value = "throwaway";
    click($(m, "#cfadd"));
    await waitUntil(() => m.window.document.querySelectorAll("#cowk .cowfleet").length === 2);
    click(m.window.document.querySelectorAll("#cowk .cowfleet")[1]!);
    await waitUntil(() => m.window.document.querySelectorAll("#cowk .cowfleet").length === 1);
    // a bad model id is refused before it reaches the daemon
    click($(m, "#cowfleetadd"));
    await waitUntil(() => !!$(m, "#cmenu.cfleet #cfadd"));
    ($(m, "#cfmodel") as HTMLInputElement).value = "has space";
    click($(m, "#cfadd"));
    expect(m.window.document.querySelectorAll("#cowk .cowfleet")).toHaveLength(1);
    // starting the run sends the row as a spec: two pinned instances in the run
    const box = $(m, "#box") as HTMLTextAreaElement;
    box.value = "fleet goal";
    click($(m, "#orchsend"));
    let run: { workers: string[]; workerDetails?: Array<{ id: string; model?: string }> } | undefined;
    await waitUntil(async () => {
      const { runs } = await rest<{ runs: Array<{ goal: string; workers: string[]; workerDetails?: Array<{ id: string; model?: string }> }> }>("GET", "/orchestra");
      run = runs.find((r) => r.goal.includes("fleet goal"));
      return Boolean(run);
    });
    expect(run!.workers.filter((w) => w.startsWith("execbot@gpt-5.6-sol"))).toHaveLength(2);
    expect(run!.workerDetails!.filter((w) => w.model === "gpt-5.6-sol")).toHaveLength(2);
    // leave nothing behind for the next test: the run aborted and settled, the fleet forgotten
    const fleetRun = (await rest<{ runs: Array<{ id: string; goal: string }> }>("GET", "/orchestra")).runs.find((r) => r.goal.includes("fleet goal"))!;
    await rest("POST", `/orchestra/${fleetRun.id}/abort`).catch(() => {});
    await waitUntil(async () => !["running", "waiting_human", "planning"].includes((await runStatus(fleetRun.id)).status), { timeoutMs: 30_000 });
    await waitUntil(async () => !(await rest<{ agents: Array<{ busy?: boolean }> }>("GET", "")).agents?.some((a) => a.busy));
    m.window.localStorage.removeItem(`loomOrch:${projectId}`);
  });
});
