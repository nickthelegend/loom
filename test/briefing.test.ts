/**
 * frameBriefing — the shared strong-framing helper. The claude and grok
 * adapters have real system channels; codex and opencode don't, so the same
 * handoff briefing rides in the prompt wrapped in an unmissable, imperative
 * block. This proves the wrapper is authoritative and doesn't mangle the brief.
 */

import { describe, expect, it } from "vitest";
import { frameBriefing } from "../src/adapters/base.js";

describe("frameBriefing", () => {
  it("is empty for an empty briefing — nothing to frame", () => {
    expect(frameBriefing("")).toBe("");
    expect(frameBriefing("   \n  ")).toBe("");
  });

  it("wraps the brief in an authoritative, imperative block", () => {
    const out = frameBriefing("Decision: use node:sqlite for the log.");
    // a clear delimiter the model can't skim past, top and tail
    expect(out).toMatch(/^===== LOOM SESSION MEMORY/m);
    expect(out).toMatch(/end session memory/i);
    // it tells the model to treat it as ground truth, and where to read more
    expect(out).toMatch(/authoritative|ground truth/i);
    expect(out).toMatch(/\.loom\/memory/);
    // and it carries the brief verbatim
    expect(out).toContain("Decision: use node:sqlite for the log.");
  });

  it("keeps the brief above where the user's turn will be appended", () => {
    const out = frameBriefing("prior context here");
    expect(out.indexOf("prior context here")).toBeLessThan(out.indexOf("the user's message follows"));
  });
});
