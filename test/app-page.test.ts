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
    // the Tasks tab is gone; the Board covers it
    expect(APP_HTML).toContain('var tabs = ["thread", "board", "brain"];');
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
