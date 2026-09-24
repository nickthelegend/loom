/**
 * The phone's reading of an agent's reply. Plain node, no React Native:
 *
 *   cd app && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inline, parse, plainText, planActions } from "../src/markdown-model.ts";

describe("inline marks", () => {
  it("reads bold, code, italic and links, and leaves the rest as text", () => {
    assert.deepEqual(inline("**Done.** see `a.ts` and [docs](https://x.dev) _now_"), [
      { t: "bold", s: "Done." },
      { t: "text", s: " see " },
      { t: "code", s: "a.ts" },
      { t: "text", s: " and " },
      { t: "link", s: "docs", href: "https://x.dev" },
      { t: "text", s: " " },
      { t: "italic", s: "now" },
    ]);
  });

  it("doesn't italicise the middle of a snake_case name", () => {
    assert.deepEqual(inline("run make_the_thing"), [
      { t: "text", s: "run make" },
      { t: "text", s: "_the_" },
      { t: "text", s: "thing" },
    ]);
  });
});

describe("blocks", () => {
  it("splits paragraphs, headings, lists and fenced code", () => {
    const b = parse("# Title\n\nfirst line\nsame para\n\n- one\n  - nested\n1. first\n\n```ts\nconst a = 1;\n```");
    assert.deepEqual(b.map((x) => x.t), ["h", "p", "li", "li", "li", "code"]);
    assert.equal(b[2]!.t === "li" && b[3]!.t === "li" && b[3]!.depth, 1);
    assert.equal(b[4]!.t === "li" && b[4]!.ordered, true);
    assert.deepEqual(b[5], { t: "code", lang: "ts", s: "const a = 1;" });
  });

  it("turns the orchestrator's ```loom JSON into a plan, not a code dump", () => {
    const md = 'Here is the plan.\n```loom\n{"actions":[{"type":"spawn","agent":"codex","title":"Add tests","prompt":"x"},{"type":"done","summary":"All good"}]}\n```';
    const b = parse(md);
    assert.deepEqual(b[1], {
      t: "plan",
      actions: [
        { type: "spawn", text: "codex: Add tests" },
        { type: "done", text: "All good" },
      ],
    });
  });

  it("keeps a ```loom block that isn't a plan as code", () => {
    assert.equal(parse("```loom\nnot json\n```")[0]!.t, "code");
    assert.equal(planActions('{"nope":1}'), null);
  });
});

describe("a preview line", () => {
  it("drops the marks and says a plan in words", () => {
    assert.equal(plainText("**Orchestra complete.** See `a.ts`.\n\n- one\n- two"), "Orchestra complete. See a.ts. one two");
    assert.equal(plainText('```loom\n{"actions":[{"type":"done","summary":"All good"}]}\n```'), "All good");
  });
});
