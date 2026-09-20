/**
 * The served web app is a single HTML string; these tests lock its contract:
 * the pairing/auth markers the daemon test depends on, the premium "weave"
 * design signatures, and a render branch for every event kind — so a future
 * edit can't silently drop one.
 */

import { describe, expect, it } from "vitest";
import { APP_HTML, APP_MANIFEST } from "../src/daemon/app-page.js";
import type { EventKind } from "../src/types.js";

describe("web app page", () => {
  // The whole page is one TS template literal, so every backslash bound for
  // the browser has to be doubled and control bytes written as escapes. Get
  // that wrong and the app ships a script that dies on parse — silently, since
  // nothing server-side ever evaluates it. Parse it here instead.
  it("serves a script that actually parses", () => {
    const block = APP_HTML.match(/<script>\n\(function\(\)\{[\s\S]*?\n\}\)\(\);\n<\/script>/);
    expect(block, "main app script block not found").not.toBeNull();
    const src = block![0].replace(/^<script>/, "").replace(/<\/script>$/, "");
    expect(() => new Function(src)).not.toThrow();
  });

  /**
   * The one path that crosses the shell/web boundary: the desktop app asking
   * for a command to be run where a person can watch it. The Electron half is
   * tested in desktop-updater-mac; this is the half that has to be listening.
   */
  it("runs a command the native shell asks it to, in the real terminal", () => {
    expect(APP_HTML).toContain('item.indexOf("run:")');
    expect(APP_HTML).toContain("state.termRun(cmd)");
    // And says something when there's no terminal to run it in, rather than
    // swallowing it.
    expect(APP_HTML).toMatch(/if \(!state\.termRun\) \{ toast\(/);
  });

  /**
   * The composer row had to hold the model, the agent, a permission chip,
   * MCPs, Skills, a mic, Prompts, Plan and send — and wrapped on a narrow
   * window. MCPs and Skills moved behind More; the count badge did not, since
   * "two skills are on" is the part you need without opening anything.
   */
  it("puts MCPs and Skills behind More, and keeps the badge outside", () => {
    expect(APP_HTML).toContain('id="morebtn"');
    expect(APP_HTML).toContain('id="skcount"'); // still on the button itself
    // The old buttons are gone, not merely hidden.
    expect(APP_HTML).not.toContain('id="mcpbtn"');
    expect(APP_HTML).not.toContain('id="skillbtn"');
    // …and More still reaches both panels.
    expect(APP_HTML).toContain('toggleComposerPanel("mcp")');
    expect(APP_HTML).toContain('toggleComposerPanel("skills")');
  });

  /**
   * Right-click was dead everywhere. These are the actions that had no home:
   * removing a project lived only in `loom projects --forget`, and renaming
   * one had no UI at all.
   */
  it("gives projects and threads a right-click menu", () => {
    expect(APP_HTML).toContain("function openMenu(");
    expect(APP_HTML).toContain("function projectMenu(");
    expect(APP_HTML).toContain("function chatMenu(");
    expect(APP_HTML).toMatch(/row\.oncontextmenu = function/);
    // The destructive one says what it does — it unregisters, it doesn't delete.
    expect(APP_HTML).toContain("Remove from Loom");
    expect(APP_HTML).not.toContain("Delete project");
    expect(APP_HTML).toContain("stay on disk");
    // Escape closes it; a menu you can't dismiss with the keyboard is a trap.
    expect(APP_HTML).toContain("function menuKey(");
  });

  it("keeps the auth/pairing contract", () => {
    expect(APP_HTML).toContain('id="loom-app"');
    expect(APP_HTML).toContain("/api/pair/claim");
    expect(APP_HTML).toContain("loomClientToken");
    // The WS token rides in the subprotocol, never the URL — a query token would
    // land in browser history and proxy logs. Lock both halves of that.
    expect(APP_HTML).not.toContain("/ws?token=");
    expect(APP_HTML).toContain('"loom.bearer." + state.token');
  });

  it("carries the design signatures (quiet graphite + the weave, kept as state)", () => {
    // warp-line ground
    expect(APP_HTML).toContain("repeating-linear-gradient");
    // woven loader, shuttle handoff, selvage edge
    expect(APP_HTML).toContain(".loader");
    expect(APP_HTML).toContain(".handoff");
    expect(APP_HTML).toContain("border-left-color:hsl(");
    // two-accent system + sharpened tagline
    expect(APP_HTML).toContain("--thread:#67e8f9");
    expect(APP_HTML).toContain("--shuttle:#e879f9");
    expect(APP_HTML).toContain("shared-memory layer");
    // the Orca-adapted system: Geist type, neutral tokens, both themes
    expect(APP_HTML).toContain("/app/fonts/geist.woff2");
    expect(APP_HTML).toContain("--background:#0a0a0a"); // dark canvas
    expect(APP_HTML).toContain("--background:#fff"); // light canvas
    expect(APP_HTML).toContain("loomTheme"); // persisted theme toggle
    expect(APP_HTML).toContain("backdrop-filter"); // glass floating tier
    expect(APP_HTML).toContain("-webkit-app-region:drag"); // Electron title strips
  });

  it("has a render branch for every event kind that reaches the thread", () => {
    const rendered: EventKind[] = [
      "message",
      "tool_call",
      "file_edit",
      "turn_diff",
      "handoff",
      "suggestion",
      "needs_input",
      "decision",
      "memory_import",
      "error",
      "route_started",
      "route_step",
      "route_paused",
      "route_resumed",
      "route_completed",
      "route_failed",
      "run_complete",
    ];
    for (const kind of rendered) {
      expect(APP_HTML, `missing render branch for "${kind}"`).toContain(`=== "${kind}"`);
    }
  });

  it("exposes the memory / tree / route surfaces the app calls", () => {
    for (const path of [
      "/api/projects/",
      "/memory",
      "/tree",
      "/route",
      "/handoff",
      "/interrupt",
      "/messages",
    ]) {
      expect(APP_HTML).toContain(path);
    }
  });

  it("folds Tasks into the Board: one place, and it can search", () => {
    // the Tasks tab is gone; the Board covers it. Observatory is a real fourth
    // tab, not a resurrected Tasks — the point of this assertion is that the
    // work-tracking surfaces stayed folded into one.
    expect(APP_HTML).toContain('var tabs = ["thread", "board", "brain", "observatory"];');
    expect(APP_HTML).not.toContain('id="pane-tasks"');
    expect(APP_HTML).not.toContain('id="pane-routes"');
    // issues and PRs are searchable from the board, in GitHub's own language
    expect(APP_HTML).toContain('id="bq"');
    expect(APP_HTML).toContain('"?search=" + encodeURIComponent(board.q)');
    // and an issue can still be handed to an agent, as the Tasks tab allowed
    expect(APP_HTML).toContain("[data-start]");
    expect(APP_HTML).toContain("Read the issue, then implement it.");
  });

  it("ships the Board in place of Routes, without orphaning routes", () => {
    expect(APP_HTML).toContain('id="pane-board"');
    // Routes lost its tab, not its home: named pipelines and custom steps live
    // in the New task modal, live state and abort in the Source Control rail,
    // and mobile keeps its own route sheet.
    expect(APP_HTML).toContain('id="mroute"'); // named pipeline picker
    expect(APP_HTML).toContain("specWithRoles"); // several agents = a pipeline, each with a role
    expect(APP_HTML).toContain('id="rabort"'); // abort, in the rail
    expect(APP_HTML).toContain("routeFormHtml()"); // mobile sheet
  });

  it("lets you move your own cards for real, and only pin the rest", () => {
    // A card you wrote has no truth beyond the column you put it in, so the
    // drag persists. A PR's truth is GitHub's: dropping it elsewhere only pins
    // where you see it, and the badge keeps saying what is actually so.
    expect(APP_HTML).toContain("if (card.own) {");
    expect(APP_HTML).toContain("c.shown = pins[c.id] || c.column");
    expect(APP_HTML).toContain("var st = BSTATES[c.state]");
  });

  it("lists a project's chats in the sidebar, and keeps them apart", () => {
    expect(APP_HTML).toContain("data-newchat");
    expect(APP_HTML).toContain('class="crow');
    // the socket carries the whole project; a thread shows one conversation
    expect(APP_HTML).toContain('if ((frame.event.chat || "main") !== chatId) return;');
    // and a role is text you type, wherever it's drawn
    expect(APP_HTML).toContain("function wireRoleEditors(");
    expect(APP_HTML).toContain("/role");
  });

  it("draws agents with their own brand mark, and never guesses one", () => {
    expect(APP_HTML).toContain('<use href="#brand-');
    expect(APP_HTML).toContain("if (!kind || !BRAND_TITLES[kind]) return \"\";");
    for (const kind of ["claude-code", "antigravity", "opencode", "kiro", "codex"]) {
      expect(APP_HTML, `no sprite symbol for ${kind}`).toContain(`<symbol id="brand-${kind}"`);
    }
  });

  it("keeps the New project flow (button, modal, native picker fallback)", () => {
    expect(APP_HTML).toContain('id="newproj"');
    expect(APP_HTML).toContain("function openProjectModal()");
    // the Electron picker is optional: the browser build types a path instead
    expect(APP_HTML).toContain("window.loomNative && window.loomNative.pickFolder");
  });

  it("submits on Enter from every text field that has a button beside it", () => {
    // #ptok is the first thing anyone touches: paste a token, press Enter.
    // These inputs sit outside any <form>, so nothing submits them for free.
    expect(APP_HTML).toContain('document.getElementById("ptok").onkeydown');
    expect(APP_HTML).toContain('["rtask", "rsteps"].forEach');
  });

  it("wires the Board head while the first fetch is still in flight", () => {
    // The loading branch returns early. Without wiring it, the search box and
    // refresh are dead for exactly as long as anyone would be looking at them
    // — which is the whole gh round-trip.
    expect(APP_HTML).toMatch(/head \+ LOADER \+ "<\/div>";\s*\n\s*wireBoardHead\(\);\s*\n\s*return;/);
  });

  it("points state.project at the new project before drawing it", () => {
    // refresh() fills state.project from a fetch that lands *after* the first
    // paint, so renderProject must seed it synchronously from the already
    // loaded list — otherwise the rail renders the project you just left.
    expect(APP_HTML).toContain(
      'state.project = (state.projects || []).filter(function(p){ return p.id === pid; })[0] || null;',
    );
  });

  it("manifest is installable and matches the theme", () => {
    expect(APP_MANIFEST.name).toBe("Loom");
    expect(APP_MANIFEST.display).toBe("standalone");
    expect(APP_MANIFEST.background_color).toBe("#0a0a0a");
    expect(APP_MANIFEST.icons.length).toBeGreaterThan(0);
  });
});

/**
 * The served JavaScript must actually parse.
 *
 * This whole page is one TS template literal, which means every backslash bound
 * for the browser has to be doubled and a raw backtick ends the file. Both
 * mistakes produce a page that serves with HTTP 200, contains all the right
 * markup, and dies on the first line of script — so every string-contains test
 * in this file still passes while the app is completely dead.
 *
 * It has happened three times in one day: a backtick in a comment about a
 * keyboard shortcut, and twice a `\n` in a comment about escaping `\n`. Parsing
 * the thing is the only check that would have caught any of them.
 */
describe("web app · the script parses", () => {
  it("every inline script is valid JavaScript", () => {
    const scripts = [...APP_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts.length, "the app should have inline scripts").toBeGreaterThan(0);
    for (const [i, src] of scripts.entries()) {
      // new Function is a parser here, not an execution: it compiles and throws
      // on a syntax error without running a line.
      expect(() => new Function(src), `inline script ${i} does not parse`).not.toThrow();
    }
  });

});

/**
 * A task thread used to claim to be whoever held the project baton, so during
 * a run with four workers you could not tell a Codex task from an Antigravity
 * one by looking at it. Proven against a real run: t1 read claude-code, t2
 * codex, t3 antigravity.
 */
describe("web app · whose thread is this", () => {
  it("resolves the header from the task, not the baton", () => {
    expect(APP_HTML).toContain("function threadAgent(");
    expect(APP_HTML).toContain("var wanted = threadAgent(p) || state.selected || p.holder;");
    // A task's agent field is an id OR a kind, and an unresolvable one must
    // fall through to the baton rather than hiding the header.
    expect(APP_HTML).toMatch(/if \(agents\[k\]\.id === want\)/);
    expect(APP_HTML).toMatch(/if \(agents\[m\]\.kind === want\)/);
    // currentChat() lives in the shell's scope; this render is in another.
    // Calling the bare name threw and took the whole header with it.
    expect(APP_HTML).toContain("state.currentChat ? state.currentChat() : null");
  });

  it("marks a thread running, done or failed — and says nothing when it can't know", () => {
    expect(APP_HTML).toContain("function chatStatusMark(");
    expect(APP_HTML).toContain('cstat run');
    expect(APP_HTML).toContain('cstat done');
    expect(APP_HTML).toContain('cstat bad');
    expect(APP_HTML).toContain("@keyframes cstatpulse");
    // Every answer comes from a status the daemon reports. A thread with no
    // task and no run behind it gets no mark at all rather than a guess.
    expect(APP_HTML).toContain('if (!t) return "";');
  });
});

/**
 * The transcript used to be one fixed level of detail: reasoning always
 * folded, tool payloads never shown, and a long block — the orchestrator's
 * plan, say — clipped inside a scroll box you could not reach the end of.
 */
describe("web app · transcript view", () => {
  it("offers Normal, Thinking and Verbose, and remembers the choice per project", () => {
    expect(APP_HTML).toContain('var TVIEWS = ["normal", "thinking", "verbose"];');
    expect(APP_HTML).toContain("function tview(");
    expect(APP_HTML).toContain("function setTView(");
    // Per project, not per app: you read one project's run at Verbose without
    // turning every other project's thread into a wall of JSON.
    expect(APP_HTML).toContain('localStorage.setItem("loomTView:" + state.pid, v)');
    // Changing the level re-reads the thread; a level nothing redraws is a
    // setting that appears not to work.
    expect(APP_HTML).toContain("if (state.redrawFeed) state.redrawFeed();");
    expect(APP_HTML).toContain("state.redrawFeed = loadHistory");
    // …and all three are reachable from More.
    expect(APP_HTML).toContain('setTView("normal")');
    expect(APP_HTML).toContain('setTView("thinking")');
    expect(APP_HTML).toContain('setTView("verbose")');
    expect(APP_HTML).toContain('{ head: "transcript" }');
  });

  it("shows more at each level, and only there", () => {
    // Normal drops reasoning entirely — it is the working out, not the
    // transcript. Thinking folds it in, Verbose opens it.
    expect(APP_HTML).toContain('if (tv === "normal") return "";');
    expect(APP_HTML).toContain('(tv === "verbose" ? " open" : "")');
    // Raw payloads are Verbose only, on tool calls and on the orchestrator's
    // brief — the two places a summary is standing in for something bigger.
    expect(APP_HTML).toContain('tview() === "verbose" ? rawBlock(p) : ""');
    expect(APP_HTML.match(/tview\(\) === "verbose" \? rawBlock\(p\) : ""/g)?.length).toBe(2);
  });

  /**
   * The complaint that opened #97: a block of output you can see the start of
   * and never the end of. Whatever the level, a long block has to be readable.
   */
  it("never hides the end of a block behind a scrollbar", () => {
    // Code wraps instead of scrolling sideways off the bubble.
    expect(APP_HTML).toContain("white-space:pre-wrap;overflow-wrap:anywhere");
    expect(APP_HTML).not.toContain(".md .mdcode code{font-family:var(--font-mono);font-size:12.5px;line-height:1.5;color:var(--foreground);\n    white-space:pre}");
    // And every block carries a copy button, so the part that is too long to
    // read on screen is still a paste away.
    expect(APP_HTML).toContain('<div class="mdcodewrap"><button class="mdcopy"');
    expect(APP_HTML).toContain('<button class="mdcopy" type="button" title="copy">');
    // Wired: the feed delegates the click, and does it before the turn card
    // and approval handlers that would otherwise swallow it.
    expect(APP_HTML).toContain('ev.target.closest(".mdcopy")');
    expect(APP_HTML).toContain('if (box) copyText(box.textContent || "");');
    const feed = APP_HTML.indexOf('document.getElementById("feed").addEventListener("click"');
    expect(feed).toBeGreaterThan(-1);
    const copyAt = APP_HTML.indexOf('closest(".mdcopy")', feed);
    const cardAt = APP_HTML.indexOf("if (approvalClick(ev)) return;", feed);
    expect(copyAt).toBeGreaterThan(feed);
    expect(copyAt).toBeLessThan(cardAt);
  });
});

/**
 * Orchestrate could pick who runs the goal but never what they run it on.
 * The model picker existed — for the one agent the chat composer was aimed
 * at, which in Orchestrate is nobody.
 */
describe("web app · picking models in Orchestrate", () => {
  it("gives the orchestrator and every worker a model chip", () => {
    expect(APP_HTML).toContain("function modelBadge(");
    expect(APP_HTML).toContain('data-modelof="');
    // On the orchestrator button…
    expect(APP_HTML).toContain("permBadge(permOf(lead), lead.id) + modelBadge(lead)");
    // …and on each worker chip.
    expect(APP_HTML).toContain("permBadge(permOf(a), a.id) + modelBadge(a)");
    expect(APP_HTML).toContain("function wireModelBadges(");
    expect(APP_HTML).toContain("wireModelBadges(el);");
  });

  /**
   * openModelMenu read state.selected, which Orchestrate deliberately does
   * not set — it has a cast, not a selection. A chip that opened the wrong
   * agent's list would be worse than no chip.
   */
  it("opens the list for the agent whose chip was clicked", () => {
    expect(APP_HTML).toContain("function openModelMenu(who){");
    expect(APP_HTML).toContain("var agentId = who || state.selected;");
    expect(APP_HTML).toContain("openModelMenu(id);");
    // Clicking the same chip twice closes it, which needs the menu to
    // remember whose it is.
    expect(APP_HTML).toContain('menuState = { kind: "modelmenu", agent: agentId');
    expect(APP_HTML).toMatch(/menuState\.kind === "modelmenu" && menuState\.agent === id/);
  });

  /**
   * A roster of CLIs is whatever you happened to install. An API model is a
   * name off a list, so there was no way to get one into a run without the
   * CLI — and the one it lands in, with no model chosen, is the one state it
   * cannot run in.
   */
  it("adds an API model as a worker, and refuses to start one that has none", () => {
    expect(APP_HTML).toContain('id="cowadd"');
    expect(APP_HTML).toContain("function addModelWorker(");
    expect(APP_HTML).toContain('JSON.stringify({ kind: "model" })');
    // Added, then asked which model — not left as a chip that fails on send.
    expect(APP_HTML).toContain("if (a && a.id) openModelMenu(a.id);");
    // The roster is re-read before anything is drawn off it.
    expect(APP_HTML).toContain("return refresh().then(function(){ return a; });");
    expect(APP_HTML).toContain('return api("/api/projects/" + pid).then(function(j){');
    // And the send guard covers the orchestrator as well as the workers.
    expect(APP_HTML).toContain('return a.kind === "model" && !a.model;');
    expect(APP_HTML).toContain("cast.concat(lead ? [lead] : [])");
    expect(APP_HTML).toContain("openModelMenu(blank[0].id);");
  });

  /** A provider-qualified id is long; the chip shows the part that names it. */
  it("shortens a long model id without dropping what identifies it", () => {
    expect(APP_HTML).toContain("function shortModel(");
    expect(APP_HTML).toContain('var cut = v.lastIndexOf("/");');
    expect(APP_HTML).toContain("v.length > 24 ?");
  });
});

/**
 * The model list has three sources and the footer named two of them. A
 * `model` agent's list is asked of the providers, and that case fell through
 * to "no model list for this agent" — printed directly above 202 of them.
 */
describe("web app · what the model list says about itself", () => {
  it("says the providers were asked, when they were", () => {
    expect(APP_HTML).toContain('j.source === "api" ? "asked every provider with a key');
  });

  /** A CLI has a default. A model agent has no such thing to offer. */
  it("does not offer a model agent a default it cannot have", () => {
    expect(APP_HTML).toContain('var head = cur.kind === "model" ? []');
  });
});

/**
 * Orchestrating from Main opened a thread of its own and walked you into it,
 * so the goal you typed and every word of its answer lived somewhere you
 * hadn't asked for — and the task threads it spawned were findable only by
 * hunting the sidebar for a title you half remembered.
 */
describe("web app · orchestrating where you asked", () => {
  it("tells the run which thread the goal was given in", () => {
    expect(APP_HTML).toContain("chat: chatId,");
    // Queued goals already carried it; both paths now agree.
    expect(APP_HTML).toContain("var body = { text: text, target: queueTarget(), chat: chatId };");
  });

  it("stays on the thread when the run is this thread", () => {
    // The old code always jumped: to the run's new chat, then to the board.
    expect(APP_HTML).toContain("else if (run.chat === chatId) showTab(\"thread\");");
    expect(APP_HTML).toContain('if (desktop && state.setChat && run.chat && run.chat !== chatId)');
  });

  /**
   * The dangerous half. A thread the run opened is the run's for good, so
   * replying there steers it. Main is not the run's — if it kept forwarding
   * after the run finished, every message you ever sent in Main would go to a
   * dead run instead of your agent.
   */
  it("gives a borrowed thread back when the run ends", () => {
    expect(APP_HTML).toContain("function owns(r){ return r && r.chat === chatId && (!r.inPlace || !orchTerminal(r.status)); }");
    expect(APP_HTML).toContain("var hit = (orch.runs || []).filter(owns)[0];");
    expect(APP_HTML).toContain("return owns(s) ?");
  });

  it("makes each task row open that task's thread", () => {
    expect(APP_HTML).toContain('data-gochat="');
    expect(APP_HTML).toContain('ev.target.closest("[data-gochat]")');
    expect(APP_HTML).toContain('openOrchChat(go.getAttribute("data-gochat"))');
    // A task with no chat still renders as the line it always was.
    expect(APP_HTML).toContain("return row(tone[st[1]] || \"\", t.chat");
    expect(APP_HTML).toContain(".sys.orch .tlink{");
  });
});
