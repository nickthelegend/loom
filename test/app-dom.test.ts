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
    expect(text(m, "#slist")).toContain("weave");
    expect(m.errors.join("\n")).toBe("");
  });

  it("the phone layout renders the project board without throwing", async () => {
    const m = mount({ desktop: false });
    await waitUntil(() => !!$(m, "#list .card"));
    expect(text(m, "#list")).toContain("weave");
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
    expect(text(m, ".bcols")).not.toContain("plannerbot is working");
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
    expect(text(m, "#bmagsel")).toContain("plannerbot");
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
    await waitUntil(() => text(m, '.bcol[data-col="needs-you"]').includes(title));
    expect(m.errors.join("\n")).toBe("");

    // and it's the daemon's card now, not a DOM flourish: a fresh window sees it
    const m2 = await openBoard();
    await waitUntil(() => text(m2, '.bcol[data-col="needs-you"]').includes(title));
    expect(m2.errors.join("\n")).toBe("");
  });

  it("refuses an empty task instead of creating a blank card", async () => {
    const m = await openBoard();
    click($(m, '.badd[data-add="working"]'));
    await waitUntil(() => !!$(m, "#bmtitle"));

    click($(m, "#bmcreate"));
    await waitUntil(() => !!$(m, "#toast.show"));
    expect(text(m, "#toast")).toContain("what needs doing");
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
    await waitUntil(() => text(m, "#thread, .thread, #pane-thread").includes(said));
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
    expect(text(m, ".sgroup")).toContain("Main");
    expect($(m, ".crow.add[data-newchat]")).toBeTruthy();
    // main is implicit: there is nothing to forget
    expect($(m, '.crow[data-chat="main"] [data-delchat]')).toBeNull();
    expect(m.errors.join("\n")).toBe("");
  });

  it("New chat asks which agent, instead of silently picking one", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await ready(m, ".crow.add[data-newchat]");
    click($(m, ".crow.add[data-newchat]"));
    await waitUntil(() => !!$(m, "#chatpick"));
    // every agent on the project is offered — the default weave has two
    const picks = [...m.window.document.querySelectorAll("#chatpick [data-pick]")];
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(text(m, "#chatpick .pickhead").toLowerCase()).toContain("start this chat with");
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · the sidebar collapses", () => {
  it("gives each project a caret that hides and shows its chats, and remembers", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, ".crow[data-chat]")); // open by default (it's selected)
    const caret = $(m, ".scaret[data-caret]");
    expect(caret, "a project row has a collapse caret").toBeTruthy();
    expect(caret?.classList.contains("open"), "the selected project starts open").toBe(true);

    click(caret);
    await waitUntil(() => !$(m, ".crow[data-chat]")); // chats gone
    expect($(m, ".scaret.open")).toBeNull();
    // the choice is persisted, not just visual
    const stored = JSON.parse(m.window.localStorage.getItem("loomProjOpen") || "{}");
    expect(stored[projectId]).toBe(false);
    expect(m.errors.join("\n")).toBe("");
  });
});

describe("web app · the composer", () => {
  it("is a real card — a growing textarea with an attach and a model control", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    // bindComposer stamps data-bound once it has wired the textarea; the form's
    // handler is an addEventListener, so ready()'s onsubmit check never fires.
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    const box = $(m, "#box");
    expect(box?.tagName).toBe("TEXTAREA"); // not a bare <input> any more
    expect((box as HTMLTextAreaElement).placeholder).toMatch(/@ for files, \/ for actions/);
    expect($(m, "#attach"), "the attach button").toBeTruthy();
    expect($(m, "#modelpick"), "the model picker button").toBeTruthy();
    expect($(m, "#cfile"), "a hidden file input backs the paperclip").toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  });

  it("opens a file menu on @ and an actions menu on /", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '#box[data-bound="1"]'));
    const box = $(m, "#box") as HTMLTextAreaElement;

    box.value = "/";
    box.setSelectionRange(1, 1);
    box.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await waitUntil(() => !!$(m, "#cmenu .cmi"));
    // the slash menu is real actions, not decoration
    expect(text(m, "#cmenu")).toMatch(/New task/i);
    expect(text(m, "#cmenu")).toMatch(/decision/i);
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

    const body = text(m, "#setupbody");
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

    const body = text(m, "#setupbody");
    for (const label of ["Claude Code", "Codex", "OpenCode", "Grok Code", "Antigravity IDE", "Kiro"]) {
      expect(body, `${label} missing from setup`).toContain(label);
    }
    // and the phone, which is the part people never find on their own
    expect(body).toContain("loom up --restart --tailnet");
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

    expect(text(m, "#setupbody")).toContain("Accessibility");
    expect(text(m, "#setupbody")).toMatch(/not needed/i);
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

/**
 * One control per job.
 *
 * The right panel had two toggles wearing the same icon a few inches apart —
 * one in the tab strip that worked both ways, one in the panel that could only
 * close. And Interrupt sat up in the window chrome beside them, so the button
 * that stops an agent mid-turn lived next to the button that hides a file tree.
 */
describe("web app · one button per job", () => {
  it("has exactly one toggle for the right panel", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#railbtn"));
    // the tab strip's toggle is the one; the panel's own close button is gone
    expect($(m, "#railclose")).toBeNull();
    expect(m.window.document.querySelectorAll("#railbtn").length).toBe(1);
    expect(m.errors.join("\n")).toBe("");
  });

  it("that one toggle still opens and closes the panel", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#railbtn"));
    const shell = $(m, ".dshell")!;
    const openAtFirst = shell.classList.contains("railopen");

    click($(m, "#railbtn"));
    await waitUntil(() => shell.classList.contains("railopen") !== openAtFirst);
    click($(m, "#railbtn"));
    await waitUntil(() => shell.classList.contains("railopen") === openAtFirst);
    expect(m.errors.join("\n")).toBe("");
  });

  it("keeps Interrupt out of the window chrome, and in the composer", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#stop"));
    // not beside the panel toggle any more
    expect($(m, ".tabstrip #stop")).toBeNull();
    // it lives with the send button, because they're the same question
    expect($(m, "#cform #stop")).toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  });

  it("shows send while idle, and never both at once", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#send"));
    const send = $(m, "#send") as HTMLElement;
    const stop = $(m, "#stop") as HTMLElement;
    // echo agents are idle here: send is offered, stop is not
    await waitUntil(() => stop.style.display === "none");
    expect(send.style.display).not.toBe("none");
    const bothVisible = send.style.display !== "none" && stop.style.display !== "none";
    expect(bothVisible, "send and stop must never be on screen together").toBe(false);
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * The Console.
 *
 * Errors used to have two fates: ~/.loom/daemon.log, which you must know about
 * and tail, or one of the codebase's many empty catch blocks, where they simply
 * stopped existing. Neither reaches the person looking at the window wondering
 * why nothing happened.
 */
describe("web app · the console", () => {
  it("has a console button beside the terminal button", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#consolebtn"));
    const strip = $(m, ".tabstrip")!;
    expect(strip.querySelector("#termbtn"), "the terminal button is its neighbour").toBeTruthy();
    expect(strip.querySelector("#consolebtn")).toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  });

  it("opens the dock and shows the log, not a blank drawer", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await ready(m, "#consolebtn");
    expect(($(m, "#conwrap") as HTMLElement).classList.contains("on")).toBe(false);

    click($(m, "#consolebtn"));
    await waitUntil(() => ($(m, "#conwrap") as HTMLElement).classList.contains("on"));
    // it says what it's for rather than showing an empty box
    await waitUntil(() => text(m, "#conlist").length > 0);
    expect(m.errors.join("\n")).toBe("");
  });

  it("shows a real daemon error, with its scope", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await ready(m, "#consolebtn");

    // Provoke one the way a person would: send to an agent that isn't in this
    // project. The API throws, the logbook records it. A real failure, not an
    // injected fixture.
    await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ text: "hi", agentId: "no-such-agent" }),
    }).catch(() => {});

    click($(m, "#consolebtn"));
    // the scope says which part of Loom spoke, and the message names the route
    await waitUntil(() => text(m, "#conlist").includes("api"));
    expect(text(m, "#conlist")).toContain("/messages");
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  it("filters to errors only", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await ready(m, "#consolebtn");
    click($(m, "#consolebtn"));
    await waitUntil(() => !!$(m, '.conbar .lvl[data-lvl="error"]'));

    click($(m, '.conbar .lvl[data-lvl="error"]'));
    expect(($(m, '.conbar .lvl[data-lvl="error"]') as HTMLElement).classList.contains("on")).toBe(true);
    expect(($(m, '.conbar .lvl[data-lvl="all"]') as HTMLElement).classList.contains("on")).toBe(false);
    expect(m.errors.join("\n")).toBe("");
  });
});

/**
 * The agent picker.
 *
 * A project's roster used to be frozen at creation: install a new ADE and your
 * existing projects never heard of it, so a machine with six agents had a board
 * offering two. That looked like a bug in the board. The board was telling the
 * truth about a config that couldn't learn.
 */
describe("web app · the agent picker", () => {
  const openAgents = async (): Promise<Mounted> => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '.rvbtn[data-view="tasks"]'));
    click($(m, '.rvbtn[data-view="tasks"]'));
    await waitUntil(() => !!$(m, "#addagents"));
    return m;
  };

  it("offers the agents that aren't in this project yet", async () => {
    const m = await openAgents();
    // the fixture project has echo agents only, so every real ADE is on offer
    await waitUntil(() => m.window.document.querySelectorAll("#addagents .addrow").length > 0);
    expect(text(m, "#addagents")).toContain("Claude Code");
    expect(text(m, "#addagents")).toContain("Codex");
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  it("greys out an ADE that isn't installed, with the reason", async () => {
    const m = await openAgents();
    await waitUntil(() => m.window.document.querySelectorAll("#addagents .addrow").length > 0);
    // whichever are missing on this machine say so rather than vanishing —
    // "not in the list" and "not installed" send you somewhere different
    const off = m.window.document.querySelectorAll("#addagents .addrow.off");
    for (const row of off) {
      expect(row.textContent ?? "").toContain("not installed");
    }
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  it("adds an agent to the project for real", async () => {
    const m = await openAgents();
    // wait for the row to be *wired*, not just drawn — drawAddAgents fetches,
    // renders, then binds, and clicking between the last two is a silent no-op
    await ready(m, "#addagents .addrow:not(.off)");
    const row = $(m, "#addagents .addrow:not(.off)")!;
    const kind = row.getAttribute("data-add")!;

    click(row);
    // it lands in the roster above, and the daemon agrees
    // The daemon agrees, which is the only opinion that counts: the row could
    // vanish from the DOM for any number of reasons that aren't "it worked".
    await waitUntil(async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${clientToken}` },
      });
      const j = (await res.json()) as { project?: { agents?: { kind: string }[] } };
      return Boolean(j.project?.agents?.some((a) => a.kind === kind));
    });
    expect(m.errors.join("\n")).toBe("");
  }, 25_000);

  it("gives a new agent its kind as its role, not an invented job", async () => {
    // Self-contained: depending on a previous test having run is how a suite
    // starts passing for reasons nobody can name.
    const add = await fetch(`${baseUrl}/api/projects/${projectId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ kind: "echo", id: `role-check-${Date.now()}` }),
    });
    const agent = (await add.json()) as { id: string; kind: string; role: string };
    expect(agent.role, "a role is a job you name, not one Loom picks").toBe("echo");
    for (const invented of ["planner", "executor", "reviewer"]) {
      expect(agent.role).not.toBe(invented);
    }
    await fetch(`${baseUrl}/api/projects/${projectId}/agents/${agent.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${clientToken}` },
    });
  });
});

/**
 * The Brain.
 *
 * The whole premise of the product, and the tab was the projection dumped as
 * grey lines with one button on it. It now says what it holds, what it read
 * from your agents, and exactly what an agent receives — the claim next to its
 * evidence.
 */
describe("web app · the brain", () => {
  const openBrain = async (): Promise<Mounted> => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, '.tab[data-tab="brain"]'));
    click($(m, '.tab[data-tab="brain"]'));
    await waitUntil(() => !!$(m, ".pane-inner.brain"));
    return m;
  };

  it("offers a kind filter across the learned memories", async () => {
    const m = await openBrain();
    await waitUntil(() => !!$(m, ".bkinds .bkind"));
    // "All" is always there; the rest appear as kinds get learned.
    expect(text(m, ".bkinds")).toContain("All");
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  /**
   * An empty brain should explain itself — it means nothing has been learned or
   * written down yet, not that the tab is broken.
   */
  it("explains an empty brain rather than showing a blank box", async () => {
    const m = await openBrain();
    await waitUntil(() => !!$(m, ".bempty"));
    const body = text(m, ".pane-inner.brain");
    expect(body).toContain("Nothing learned yet");
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  it("adds a decision, and it lands in the brain as a memory", async () => {
    const m = await openBrain();
    await ready(m, "#decform");
    const said = `always double the backslashes ${Date.now()}`;
    ($(m, "#decbox") as HTMLInputElement).value = said;
    ($(m, "#decform") as HTMLFormElement).dispatchEvent(
      new m.window.Event("submit", { bubbles: true, cancelable: true }),
    );

    // the decision shows up as a memory card
    await waitUntil(() => text(m, ".bmems").includes(said));
    // and the brain agrees — the decision dual-wrote a memory unit
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/brain`, {
      headers: { authorization: `Bearer ${clientToken}` },
    });
    const j = (await res.json()) as { memories: Array<{ text: string; kind: string }> };
    expect(j.memories.some((x) => x.text === said && x.kind === "decision")).toBe(true);
    expect(m.errors.join("\n")).toBe("");
  }, 25_000);

  it("shows a learned memory as a card with its kind and provenance", async () => {
    // seed one straight into the brain, then open the tab
    await fetch(`${baseUrl}/api/projects/${projectId}/brain`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ kind: "constraint", text: "The daemon serves from one template literal in app-page.ts." }),
    });
    const m = await openBrain();
    await waitUntil(() => !!$(m, ".bmem"));
    const card = text(m, ".bmem");
    expect(card).toContain("template literal");
    expect($(m, ".bmem .bbadge")?.textContent?.toLowerCase()).toContain("constraint");
    expect($(m, ".bmem [data-forget]"), "each memory can be forgotten").toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);
});

/**
 * Chat search, from the sidebar box.
 *
 * The box filtered project names, which is the easy half. The thread — where a
 * project's reasoning actually lives — wasn't searchable from anywhere.
 */
describe("web app · searching your conversations", () => {
  it("finds a message you sent, and says who said it", async () => {
    const said = `the sqlite decision ${Date.now()}`;
    // A real message through the real API, so there is something real to find.
    await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ text: said }),
    }).catch(() => {});

    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#sfilter"));
    const box = $(m, "#sfilter") as HTMLInputElement;
    box.value = "sqlite decision";
    box.dispatchEvent(new m.window.Event("input", { bubbles: true }));

    await waitUntil(() => !!$(m, ".chit"));
    expect(text(m, ".chit")).toContain("sqlite decision");
    expect(m.errors.join("\n")).toBe("");
  }, 25_000);

  it("highlights the match rather than making you find it again", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#sfilter"));
    const box = $(m, "#sfilter") as HTMLInputElement;
    box.value = "sqlite";
    box.dispatchEvent(new m.window.Event("input", { bubbles: true }));

    await waitUntil(() => !!$(m, ".chit mark"));
    expect(($(m, ".chit mark") as HTMLElement).textContent?.toLowerCase()).toBe("sqlite");
    expect(m.errors.join("\n")).toBe("");
  }, 25_000);

  it("doesn't search on one letter — that answers nothing", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#sfilter"));
    const box = $(m, "#sfilter") as HTMLInputElement;
    box.value = "s";
    box.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    expect($(m, ".chit")).toBeNull();
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  it("Escape clears it", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    await waitUntil(() => !!$(m, "#sfilter"));
    const box = $(m, "#sfilter") as HTMLInputElement;
    box.value = "sqlite";
    box.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await waitUntil(() => !!$(m, ".chit"));

    box.dispatchEvent(new m.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitUntil(() => !$(m, ".chit"));
    expect(box.value).toBe("");
    expect(m.errors.join("\n")).toBe("");
  }, 25_000);
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
    expect(text(m, "#slist")).toContain("weave");

    filter.value = "definitely-not-a-project";
    filter.dispatchEvent(new m.window.Event("input", { bubbles: true }));
    await waitUntil(() => !$(m, "#slist .srow"));
    expect(text(m, "#slist")).toContain("no project called");
    expect(m.errors.join("\n")).toBe("");
  });

  /**
   * Split from the N-key test below rather than sharing a window. One test that
   * opened, closed and reopened a modal was flaky under a loaded parallel run,
   * and a flake in a three-step test tells you nothing about which step.
   */
  it("opens the agent task modal from the sidebar", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    // Wait for the PROJECT, not just the shell — the same race the N-key test
    // below documents, and it was latent here too. #newtask is renderShell's and
    // shows up early, but its handler calls openTaskModal(state.pid) and
    // state.pid is renderProject's. Clicking in the gap builds no modal, which
    // only ever bites under load.
    await waitUntil(() => !!$(m, "#box"));
    // wired, not merely present — clicking a button whose handler hasn't been
    // attached yet is a no-op that looks exactly like a broken feature.
    await ready(m, "#newtask");

    click($(m, "#newtask"));
    await waitUntil(() => !!$(m, "#mtask"));
    expect($(m, "#magsel")).toBeTruthy(); // which agents to hand it to
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

  it("opens it from the N key too", async () => {
    const m = mount({ hash: `#p/${projectId}` });
    // Wait for the PROJECT, not the shell. The shortcut calls
    // openTaskModal(state.pid), and state.pid is set by renderProject while
    // #newtask belongs to renderShell — so a wait on the sidebar can fire the
    // key into a null project, which builds no modal. That was the flake.
    await waitUntil(() => !!$(m, "#box"));
    await ready(m, "#newtask");

    m.window.document.dispatchEvent(
      new m.window.KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
    await waitUntil(() => !!$(m, "#mtask"));
    expect(m.errors.join("\n")).toBe("");
  }, 20_000);

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
