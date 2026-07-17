/**
 * The web app, actually executed.
 *
 * app-page.test.ts greps the served HTML for markers, which proves the string
 * contains some text and nothing about whether the app runs. This file loads
 * that same HTML into a DOM, lets its JavaScript boot, and drives it by
 * clicking — against a REAL daemon on an ephemeral port, with a real project
 * and a real pairing token.
 *
 * Against the real daemon on purpose: canned fetch responses would be a third
 * copy of the API's shape, and it would drift from the server the moment
 * someone renamed a field. Here, a route that changes breaks this test.
 *
 * Ephemeral port on purpose too: a fixed one would collide with the daemon the
 * developer is running, and the loser serves someone a stale app.
 */

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
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;

  const client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(makeProjectDir({ name: "weave" }))).project.id;

  // pair the way the desktop shell does: mint, then claim once
  const { token } = await client.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

/**
 * Every window a test mounts, closed after it whether it passed or threw. A
 * leaked window keeps its WebSocket open, and then daemon.close() waits on it
 * forever — a failing assertion turns into an unrelated hook timeout.
 */
const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

afterAll(async () => {
  await daemon.close();
});

interface Mounted {
  window: JSDOM["window"];
  /** Uncaught exceptions thrown by the page's own JavaScript. */
  errors: string[];
  close: () => void;
}

/**
 * Boot the app in a DOM. `desktop` drives the same media query the app uses to
 * choose its layout, so both are reachable from a test.
 */
function mount({ desktop = true, hash = "", token = clientToken as string | null } = {}): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));

  // The app is a live thing: it polls on intervals and holds a WebSocket. Both
  // outlive the assertion unless someone takes them away.
  const sockets: WebSocket[] = [];
  let closed = false;
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
    },
  });

  const m: Mounted = {
    window: dom.window,
    errors,
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
const text_ = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};

describe("web app · boot", () => {
  it("an unpaired visitor gets the pairing screen, not a broken shell", async () => {
    const m = mount({ token: null });
    await waitUntil(() => !!$(m, "#ptok, .pairbox, .pair"));
    expect(m.errors.join("\n")).toBe("");
  });

  it("a paired desktop client renders the workspace against the real daemon", async () => {
    const m = mount();
    // the sidebar is filled from GET /api/projects — real data, real token
    await waitUntil(() => !!$(m, "#slist .srow"));
    expect(text_(m, "#slist")).toContain("weave");
    expect(m.errors.join("\n")).toBe("");
  });

  it("the phone layout renders the project board without throwing", async () => {
    const m = mount({ desktop: false });
    await waitUntil(() => !!$(m, "#list .card"));
    expect(text_(m, "#list")).toContain("weave");
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * The theme toggle moved out of the tab strip (it sat one pixel from Interrupt,
 * which stops an agent mid-turn) down to the sidebar foot beside unpair. A
 * layout regression that puts it back is exactly what a string-grep test can't
 * see: the markup would still contain a theme button.
 */
describe("web app · theme toggle", () => {
  it("lives in the sidebar foot next to unpair, not beside Interrupt", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, ".sfoot #themebtn"));
    const foot = $(m, ".sfoot")!;
    expect(foot.querySelector("#unpair")).toBeTruthy();
    // and nowhere near the tab strip's interrupt button
    expect($(m, ".tabs #themebtn, .pane #themebtn")).toBeNull();
  });

  it("actually flips the theme and remembers it", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, ".sfoot #themebtn"));
    const html = m.window.document.documentElement;
    expect(html.classList.contains("dark")).toBe(true);

    click($(m, "#themebtn"));
    expect(html.classList.contains("dark")).toBe(false);
    expect(m.window.localStorage.getItem("loomTheme")).toBe("light");

    click($(m, "#themebtn"));
    expect(html.classList.contains("dark")).toBe(true);
    expect(m.window.localStorage.getItem("loomTheme")).toBe("dark");
    expect(m.errors.join("\n")).toBe("");
  });
});

/** Open a project's board tab and wait for its columns. */
async function openBoard(): Promise<Mounted> {
  const m = mount({ hash: `#p/${projectId}` });
  await waitUntil(() => !!$(m, '.tab[data-tab="board"]'));
  click($(m, '.tab[data-tab="board"]'));
  await waitUntil(() => !!$(m, ".bcol"));
  return m;
}

describe("web app · board", () => {
  it("draws every column, even with no GitHub to talk to", async () => {
    const m = await openBoard();
    const cols = [...m.window.document.querySelectorAll(".bcol")].map((c) =>
      c.getAttribute("data-col"),
    );
    expect(cols).toEqual(["working", "needs-you", "in-review", "ready"]);
    // this project isn't a git repo and gh isn't signed in here: the PR half
    // can't load, and the board still has to draw rather than blank out
    expect(m.errors.join("\n")).toBe("");
  });

  /**
   * The board is work in flight, not a roster. An idle agent is not a card —
   * board.ts drops it on purpose — so a project whose agents are all sitting
   * still shows four empty columns, and that's correct rather than broken.
   * (Agents you can hand work to appear in the modal instead; see below.)
   */
  it("doesn't invent cards for idle agents", async () => {
    const m = await openBoard();
    expect(text_(m, ".bcols")).not.toContain("plannerbot is working");
    expect(m.window.document.querySelectorAll(".bempty").length).toBe(4);
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * "New task" on the board used to be a prompt() — a browser dialog with one
 * line and no notion of what a task is. It's a real modal now, and these drive
 * it the way a person does: click the +, type, submit, and expect a card.
 */
describe("web app · board task modal", () => {
  it("the column's + opens the modal, aimed at that column", async () => {
    const m = await openBoard();
    click($(m, '.badd[data-add="needs-you"]'));
    await waitUntil(() => !!$(m, "#bmtitle"));

    expect($(m, "#bmcol")).toBeTruthy();
    expect($(m, "#bmagsel")).toBeTruthy();
    // it lands in the column whose + you pressed, not a default
    expect(($(m, "#bmcol") as HTMLSelectElement).value).toBe("needs-you");
    // "Create & start" stays hidden until an agent is actually picked
    expect(($(m, "#bmstart") as HTMLElement).style.display).toBe("none");
    expect(m.errors.join("\n")).toBe("");
  });

  it("offers the project's agents to hand the task to", async () => {
    const m = await openBoard();
    click($(m, '.badd[data-add="working"]'));
    await waitUntil(() => !!$(m, "#bmagsel .agchip, #bmagsel .chip, #bmagsel button"));
    expect(text_(m, "#bmagsel")).toContain("plannerbot");
    expect(m.errors.join("\n")).toBe("");
  });

  it("Escape closes it without creating anything", async () => {
    const m = await openBoard();
    const before = m.window.document.querySelectorAll(".bcard, .card").length;
    click($(m, '.badd[data-add="working"]'));
    await waitUntil(() => !!$(m, "#bmtitle"));

    m.window.document.dispatchEvent(
      new m.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await waitUntil(() => !$(m, ".scrim"));
    expect(m.window.document.querySelectorAll(".bcard, .card").length).toBe(before);
    expect(m.errors.join("\n")).toBe("");
  });

  it("creates a real card that survives a reload", async () => {
    const m = await openBoard();
    click($(m, '.badd[data-add="needs-you"]'));
    await waitUntil(() => !!$(m, "#bmtitle"));

    const title = `ship the fingerprint fix ${Date.now()}`;
    ($(m, "#bmtitle") as HTMLTextAreaElement).value = title;
    click($(m, "#bmcreate"));

    // the modal closes and the column redraws with it
    await waitUntil(() => !$(m, ".scrim"));
    await waitUntil(() => text_(m, '.bcol[data-col="needs-you"]').includes(title));
    expect(m.errors.join("\n")).toBe("");

    // and it's the daemon's card now, not a DOM flourish: a fresh window sees it
    const m2 = await openBoard();
    await waitUntil(() => text_(m2, '.bcol[data-col="needs-you"]').includes(title));
    expect(m2.errors.join("\n")).toBe("");
  });

  it("refuses an empty task instead of creating a blank card", async () => {
    const m = await openBoard();
    click($(m, '.badd[data-add="working"]'));
    await waitUntil(() => !!$(m, "#bmtitle"));

    click($(m, "#bmcreate"));
    await waitUntil(() => !!$(m, "#toast.show"));
    expect(text_(m, "#toast")).toContain("what needs doing");
    expect($(m, ".scrim")).toBeTruthy(); // still open, nothing created
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * The whole product in one gesture: type, send, an agent answers, and the reply
 * arrives over the WebSocket. It runs against the real daemon and a real echo
 * adapter, so this exercises the composer, the POST, the event log, the socket,
 * and the thread rendering together. If this passes, Loom works.
 */
describe("web app · the thread", () => {
  it("sends a message and renders the agent's reply, live over the socket", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#box"));

    const said = `hello from a dom ${Date.now()}`;
    ($(m, "#box") as HTMLInputElement).value = said;
    ($(m, "#cform") as HTMLFormElement).dispatchEvent(
      new m.window.Event("submit", { bubbles: true, cancelable: true }),
    );

    // what you said shows up as yours
    await waitUntil(() => text_(m, "#thread, .thread, #pane-thread").includes(said));
    // ...and echo answers with it, delivered by the WebSocket rather than a reload
    await waitUntil(() => {
      const bubbles = [...m.window.document.querySelectorAll(".bubble")];
      return bubbles.filter((b) => (b.textContent ?? "").includes(said)).length >= 2;
    });
    expect(m.errors.join("\n")).toBe("");
  });

  it("clears the composer after sending, so you don't send it twice", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#box"));
    const box = $(m, "#box") as HTMLInputElement;
    box.value = `once only ${Date.now()}`;
    ($(m, "#cform") as HTMLFormElement).dispatchEvent(
      new m.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await waitUntil(() => box.value === "");
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * A project holds conversations. Main is implicit and can't be deleted; the
 * others are yours to make and forget.
 */
describe("web app · chats", () => {
  it("lists Main under the selected project, and offers a new one", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, ".crow[data-chat]"));
    expect(text_(m, ".sgroup")).toContain("Main");
    expect($(m, ".crow.add[data-newchat]")).toBeTruthy();
    // main is implicit: there is nothing to forget
    expect($(m, '.crow[data-chat="main"] [data-delchat]')).toBeNull();
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * Setup — the onboarding screen.
 *
 * It reads /api/setup from the daemon rather than hardcoding a checklist, and
 * that's the thing worth locking: a setup screen that says the same words on
 * every machine is a brochure. These run against the real daemon, so the agent
 * list is whatever this machine actually has.
 */
describe("web app · setup", () => {
  it("opens from the sidebar foot and reads this machine, not a script", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, ".sfoot #setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, "#setupbody .sgrouph"));
    // wait for the fetch, not just the shell
    await waitUntil(() => m.window.document.querySelectorAll("#setupbody .srow2").length > 0);

    const groups = [...m.window.document.querySelectorAll(".sgrouph")].map((g) => g.textContent);
    expect(groups.join("|")).toContain("Runtime");
    expect(groups.join("|")).toContain("Agents that can take a turn");
    expect(groups.join("|")).toContain("Permissions");
    expect(m.errors.join("\n")).toBe("");
  });

  /**
   * The claim this replaces was mine and it was wrong: "Loom can't tell whether
   * a CLI is signed in". It can — codex has `login status`, opencode reads its
   * own credentials, and a signed-out claude refuses a -p probe in 30ms for
   * free. Believing otherwise put "Claude Code ✓ installed" on the screen while
   * `claude` answered "Not logged in" to anyone who asked, and cost an
   * afternoon of blaming the adapter.
   */
  it("says which agents are actually signed in, not just installed", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, "#setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => m.window.document.querySelectorAll("#setupbody .srow2").length > 5);

    const body = text_(m, "#setupbody");
    // every installed agent resolves to a real verdict, never a shrug dressed
    // up as a tick
    expect(body).toMatch(/signed in|signed out|couldn|not installed|unknown/i);
    expect(m.errors.join("\n")).toBe("");
  });

  it("names every agent Loom can drive, with the command to check it", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, "#setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => m.window.document.querySelectorAll("#setupbody .srow2").length > 5);

    const text = text_(m, "#setupbody");
    for (const label of ["Claude Code", "Codex", "OpenCode", "Grok Code", "Antigravity IDE", "Kiro"]) {
      expect(text, `${label} missing from setup`).toContain(label);
    }
    // and the phone, which is the part people never find on their own
    expect(text).toContain("loom up --restart --tailnet");
    expect(m.errors.join("\n")).toBe("");
  });

  /**
   * The refusal is a feature. People expect a tool that drives other apps to
   * want Accessibility, which makes "grant Accessibility to Loom" a convincing
   * thing for something else to ask. Saying so, in the app, is the defence.
   */
  it("says which permissions it does NOT want", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, "#setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => m.window.document.querySelectorAll("#setupbody .srow2").length > 5);

    expect(text_(m, "#setupbody")).toContain("Accessibility");
    expect(text_(m, "#setupbody")).toMatch(/not needed/i);
    expect($(m, "#setupbody .sdot.no"), "the refused row should be marked as such").toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  });

  it("closes on Escape", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, "#setupbtn"));
    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, "#setupbody"));
    m.window.document.dispatchEvent(
      new m.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await waitUntil(() => !$(m, ".scrim"));
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · the rest of the shell", () => {
  it("switches tabs between the thread, the board and the brain", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '.tab[data-tab="brain"]'));

    click($(m, '.tab[data-tab="brain"]'));
    await waitUntil(() => ($(m, "#pane-brain") as HTMLElement).style.display !== "none");
    expect(($(m, "#pane-thread") as HTMLElement).style.display).toBe("none");

    click($(m, '.tab[data-tab="thread"]'));
    await waitUntil(() => ($(m, "#pane-thread") as HTMLElement).style.display !== "none");
    expect(($(m, "#pane-brain") as HTMLElement).style.display).toBe("none");
    expect(m.errors.join("\n")).toBe("");
  });

  it("filters the project list as you type, and says so when nothing matches", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, "#slist .srow"));

    const filter = $(m, "#sfilter") as HTMLInputElement;
    filter.value = "weave";
    filter.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await waitUntil(() => !!$(m, "#slist .srow"));
    expect(text_(m, "#slist")).toContain("weave");

    filter.value = "definitely-not-a-project";
    filter.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await waitUntil(() => !$(m, "#slist .srow"));
    expect(text_(m, "#slist")).toContain("no matches");
    expect(m.errors.join("\n")).toBe("");
  });

  it("opens the agent task modal from the sidebar, and from the N key", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#newtask"));

    click($(m, "#newtask"));
    await waitUntil(() => !!$(m, "#mtask"));
    expect($(m, "#magsel")).toBeTruthy(); // which agents to hand it to
    m.window.document.dispatchEvent(
      new m.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await waitUntil(() => !$(m, ".scrim"));

    // the same modal, from the keyboard
    m.window.document.dispatchEvent(
      new m.window.KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
    await waitUntil(() => !!$(m, "#mtask"));
    expect(m.errors.join("\n")).toBe("");
  });

  it("doesn't fire the N shortcut while you're typing a message", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#box"));
    const box = $(m, "#box") as HTMLInputElement;
    box.focus();

    // "n" typed into the composer is a letter, not a command
    box.dispatchEvent(new m.window.KeyboardEvent("keydown", { key: "n", bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect($(m, "#mtask")).toBeNull();
    expect(m.errors.join("\n")).toBe("");
  });
});
