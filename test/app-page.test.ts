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
    expect(APP_HTML).toContain("/ws?token=");
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

  it("wires the Tasks view to the real gh-backed endpoint, never to fixtures", () => {
    expect(APP_HTML).toContain("/tasks?kind=");
    // both kinds, and the query box that gh gets verbatim
    expect(APP_HTML).toContain('tasks.kind === "pr" ? "is:pr" : "is:issue"');
    expect(APP_HTML).toContain('id="taskq"');
    // every unavailable reason the backend can return needs a panel, or the
    // view silently renders an empty table that reads as "no issues"
    for (const reason of ["no-cli", "no-auth", "no-remote"]) {
      expect(APP_HTML, `Tasks view has no state for "${reason}"`).toContain(`"${reason}"`);
    }
    // opening the tab must fetch — drawing alone would show a false empty state
    expect(APP_HTML).toContain("if (tasks.data) drawTasksPane(); else loadTasks();");
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

  it("wires the Tasks head while the first gh fetch is still in flight", () => {
    // the loading branch returns early; without its own wireTasksHead the
    // Issues/PRs toggle is dead for the whole round-trip
    expect(APP_HTML).toMatch(/head \+ LOADER \+ "<\/div>";\s*\n\s*wireTasksHead\(el\);/);
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
