/**
 * The brain against a real model.
 *
 * Everything in brain-extract.test.ts stubs the LLM so the logic is
 * deterministic. This file does the opposite: it drives the FULL extractor
 * through the actual logged-in Claude CLI, so the prompt, the JSON contract,
 * and the evidence guard are all exercised end to end for real.
 *
 * It's gated on Claude being present and reachable (dev machines, not CI). When
 * it isn't, the whole suite skips rather than failing — the same posture the
 * runtime takes: a missing extractor is a no-op, never an error.
 *
 * A real model is nondeterministic, so the assertions are about invariants that
 * must hold for ANY sensible extraction, not exact text:
 *   - it learns at least something from a fact-dense turn;
 *   - every memory it kept quotes a span that really appears in the turn (the
 *     anti-hallucination guard did its job);
 *   - a turn with nothing worth remembering yields nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { Brain } from "../src/core/brain.js";
import { evidenceInTurn, extractFromTurn, type ExtractEngine } from "../src/core/brain-extract.js";
import { claudeText } from "../src/core/claude-cli.js";
import { cliAvailable } from "../src/adapters/base.js";
import { tmpDir } from "./helpers.js";

let claudeReady = false;
beforeAll(async () => {
  claudeReady = await cliAvailable("claude");
});

async function freshBrain(): Promise<Brain> {
  const dir = path.join(tmpDir("brain-real"), ".loom");
  fs.mkdirSync(dir, { recursive: true });
  return new Brain(await EventLog.open(dir));
}

// The real engine, exactly as the runtime wires it (system + user, small model).
const realEngine: ExtractEngine = (p) =>
  claudeText(`${p.system}\n\n${p.user}`, { model: "haiku", timeoutMs: 60_000 });

describe("brain · real Claude extraction", () => {
  it.runIf(true)("only runs the real cases when Claude is reachable", () => {
    // A visible marker so a skipped run is obvious rather than silent.
    if (!claudeReady) {
      console.warn("[brain-real] claude CLI not reachable — real-model cases skipped");
    }
    expect(true).toBe(true);
  });

  it("learns evidence-backed memory from a fact-dense turn", { timeout: 90_000 }, async () => {
    if (!claudeReady) return; // gated: no Claude, nothing to assert
    const b = await freshBrain();
    const turn = [
      "user: remind me why we drive Antigravity the way we do, and where the daemon listens.",
      "claude-code: Antigravity ships no public API, so Loom drives the IDE over the Chrome DevTools Protocol on port 9333.",
      "I also confirmed the daemon listens on port 7420 by default, configured in src/daemon/server.ts.",
      "Heads up: a raw backtick anywhere in src/daemon/app-page.ts closes the template literal and takes the whole app down.",
    ].join("\n");

    const res = await extractFromTurn(b, turn, {
      engine: realEngine,
      agentId: "claude-code",
      files: ["src/daemon/server.ts", "src/daemon/app-page.ts"],
    });

    // It should have learned SOMETHING — this turn is dense with durable facts.
    expect(res.added.length + res.updated.length, "expected at least one memory").toBeGreaterThan(0);

    // The invariant that matters most: every memory that made it into the store
    // quotes a span that genuinely appears in the turn. If the guard let a
    // hallucination through, this fails.
    for (const m of b.all()) {
      expect(m.evidence, `memory "${m.text}" must carry an evidence span`).toBeTruthy();
      expect(
        evidenceInTurn(m.evidence as string, turn),
        `memory "${m.text}" cites "${m.evidence}" which is not in the turn`,
      ).toBe(true);
    }

    // And its kind is one of ours — the parser coerced anything odd to a valid kind.
    for (const m of b.all()) {
      expect(["constraint", "decision", "convention", "fact", "failure", "task"]).toContain(m.kind);
    }
  });

  it("keeps nothing from a turn with nothing worth remembering", { timeout: 90_000 }, async () => {
    if (!claudeReady) return;
    const b = await freshBrain();
    const turn = [
      "user: hey",
      "claude-code: Hi! How can I help you today?",
      "user: thanks",
      "claude-code: You're welcome!",
    ].join("\n");

    await extractFromTurn(b, turn, { engine: realEngine, agentId: "claude-code" });
    // Pure pleasantries — a good extractor writes nothing. (Loose: at most it
    // might misfire once; the guard still requires evidence, so anything kept
    // must at least be quotable.)
    for (const m of b.all()) {
      expect(evidenceInTurn(m.evidence as string, turn)).toBe(true);
    }
    expect(b.all().length, "chit-chat should not fill the brain").toBeLessThanOrEqual(1);
  });
});
