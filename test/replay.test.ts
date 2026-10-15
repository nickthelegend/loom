/**
 * Replay: a chat as one self-contained HTML page — escaped, scriptless,
 * with what ran, what changed and what Loom checked.
 */

import { describe, expect, it } from "vitest";
import { miniMarkdown, threadReplay } from "../src/core/replay.js";
import type { LoomEvent } from "../src/types.js";

let id = 0;
const ev = (kind: string, payload: Record<string, unknown>, agentId?: string): LoomEvent =>
  ({ id: ++id, ts: new Date("2026-10-15T22:10:00").getTime() + id * 1000, kind, ...(agentId ? { agentId } : {}), payload } as LoomEvent);

describe("the page", () => {
  it("escapes everything, runs nothing, and loads nothing", () => {
    const html = threadReplay([
      ev("message", { text: "<script>alert(1)</script> fix it" }),
      ev("message", { text: "Done — see [this](javascript:alert(1)) and [docs](https://example.com/a?b=1&c=2) `<b>`" }, "codex"),
      ev("tool_call", { tool: "shell", summary: "shell: echo '<img src=x onerror=alert(1)>'", preview: "<img src=x onerror=alert(1)>", exitCode: 1, ok: false }, "codex"),
    ], { project: "app<1>", chat: "Main" });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; fix it");
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">docs</a>');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
    expect(html).toContain("<title>app&lt;1&gt; — Main · Loom replay</title>");
    expect(html).toContain('<span class="bad">exit 1</span>');
  });

  it("shows what changed and what Loom checked, and sums the run up top", () => {
    const html = threadReplay([
      ev("message", { text: "make the tests pass" }),
      ev("tool_call", { tool: "shell", summary: "shell: npm test", command: "npm test", exitCode: 0 }, "codex"),
      ev("turn_diff", { files: [{ path: "src/auth/session.ts" }], added: 3, removed: 1, patch: "diff --git a/src/auth/session.ts b/src/auth/session.ts\n@@ -1 +1 @@\n-old\n+new", triage: [{ path: "src/auth/session.ts", level: "medium", reasons: ["touches auth or security code"] }] }, "codex"),
      ev("status", { state: "turn_cost", costUsd: 0.25 }, "codex"),
      ev("run_complete", { durationMs: 95_000, costUsd: 0.25 }, "codex"),
      ev("proof", { verdict: "verified", headline: "Verified: 4 tests pass in a clean checkout", claims: [{ text: "All tests pass", status: "supported", why: "4 passed" }] }),
      ev("status", { state: "loop_detected", call: "npm test", count: 3 }, "codex"),
      ev("status", { state: "shield_tripped", what: "a force-push", command: "git push -f", why: "it rewrites history", stopped: true }, "codex"),
      ev("shift", { phase: "report", summary: "1 task: 1 verified", tasks: [{ text: "make the tests pass", status: "verified", headline: "Verified" }] }),
    ], { project: "app", chat: "Night" });
    expect(html).toContain("codex · 1 turn · 1m 35s · 1 file changed · 1/1 checks verified · $0.25");
    expect(html).toContain('<span class="da">+new</span>');
    expect(html).toContain("Review first: <code>src/auth/session.ts</code> touches auth or security code");
    expect(html).toContain("<b>Proof · Verified</b> Verified: 4 tests pass in a clean checkout");
    expect(html).toContain("↻ codex was going in circles");
    expect(html).toContain("⛔ codex ran a force-push");
    expect(html).toContain("🌙 Night shift report");
  });

  it("renders the Markdown agents write", () => {
    expect(miniMarkdown("## Plan\n- one\n- two\n\n```ts\nconst a = 1 < 2;\n```\nand **bold** `x`")).toBe(
      "<h4>Plan</h4>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<pre><code>const a = 1 &lt; 2;</code></pre>\n<p>and <strong>bold</strong> <code>x</code></p>");
  });
});
