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
  question?: string;
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
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      if (token) window.localStorage.setItem("loomClientToken", token);
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
    const chips = [...m.window.document.querySelectorAll("#cowk .cowchip")];
    expect(chips.map((c) => c.getAttribute("data-wk"))).toEqual(["plannerbot", "execbot"]);
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
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    await ready(m, '#cmode [data-cmode="orch"]');
    click($(m, '#cmode [data-cmode="orch"]'));
    await ready(m, "#orchsend");

    const goal = `tidy the readme ${Date.now()}`;
    box(m).value = goal;
    click($(m, "#orchsend"));

    // the view opens on the new run, in its own orchestrator chat
    await waitUntil(() => shown($(m, "#pane-orchestra")) && text(m, "#pane-orchestra .ogoal") === goal);
    expect($(m, '.tab[data-tab="orchestra"]')?.classList.contains("active")).toBe(true);
    const { runs } = await rest<{ runs: Run[] }>("GET", "/orchestra");
    const run = runs.find((r) => r.goal === goal)!;
    expect(run, "the POST reached the daemon").toBeTruthy();
    expect(m.window.localStorage.getItem(`loomChat:${projectId}`)).toBe(run.chat);

    // echo never plans, so the orchestrator asks — the Reply box appears, live
    await waitUntil(() => !!$(m, "#pane-orchestra .oask #oreply"), { timeoutMs: 30_000 });
    expect(text(m, "#pane-orchestra .opill")).toBe("needs you");
    expect(text(m, "#pane-orchestra .oask .oq")).toContain((await runStatus(run.id)).question ?? "");
    expect(text(m, "#pane-orchestra .ometa")).toMatch(/Round\s*\d+\/\d+/);
    expect(text(m, "#pane-orchestra .ometa")).toContain("loom/");

    // a reply goes to the orchestrator, which turns another round
    ($(m, "#oreply") as HTMLTextAreaElement).value = "just stop after one task";
    click($(m, "#oreplybtn"));
    await waitUntil(async () => {
      const r = await runStatus(run.id);
      return r.status === "waiting_human" && (await rest<{ events: Array<{ kind: string; payload: { phase?: string } }> }>(
        "GET", `/events?limit=200&chat=${encodeURIComponent(run.chat)}`,
      )).events.filter((e) => e.kind === "orchestra" && e.payload.phase === "waiting").length >= 2;
    }, { timeoutMs: 30_000 });

    // Abort, while it's active
    await ready(m, "#oabort");
    click($(m, "#oabort"));
    await waitUntil(() => text(m, "#pane-orchestra .opill") === "aborted");
    expect((await runStatus(run.id)).status).toBe("aborted");
    // a finished run offers Apply and Clean up, and no longer Abort
    expect($(m, "#oabort")).toBeFalsy();
    expect(text(m, "#oapply")).toMatch(/^Apply to /);
    expect($(m, "#oclean")).toBeTruthy();
    expect(text(m, "#pane-orchestra .oruns")).toContain(goal.slice(0, 20));
    expect(m.errors.join("\n")).toBe("");
  });

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
});
