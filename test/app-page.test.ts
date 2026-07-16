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

  it("manifest is installable and matches the theme", () => {
    expect(APP_MANIFEST.name).toBe("Loom");
    expect(APP_MANIFEST.display).toBe("standalone");
    expect(APP_MANIFEST.background_color).toBe("#0a0a0a");
    expect(APP_MANIFEST.icons.length).toBeGreaterThan(0);
  });
});
