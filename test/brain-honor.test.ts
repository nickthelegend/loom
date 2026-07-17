/**
 * Does the model actually *honour* an injected brief?
 *
 * The audit's one genuinely code-addressable gap was that "memory honoring" —
 * whether an agent uses the memory Loom hands it — is inherently probabilistic
 * and so wasn't asserted anywhere. It can't be a plain unit test (there's no
 * deterministic model), but it *can* be an opt-in eval: frame a fact the way the
 * runtime does, hand it to a real agent alongside a question that can only be
 * answered from it, and check the answer used it.
 *
 * Gated exactly like brain-real.test.ts: a plain `npm test` skips it with a
 * visible marker; `LOOM_TEST_REAL=1 npm test` runs it against the logged-in
 * Claude CLI. This is the eval the gaps table said was missing.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cliAvailable, frameBriefing } from "../src/adapters/base.js";
import { claudeText } from "../src/core/claude-cli.js";
import { compileBrief } from "../src/core/brain-index.js";
import type { Memory } from "../src/core/brain.js";

const OPTED_IN = process.env.LOOM_TEST_REAL === "1";
let claudeReady = false;
beforeAll(async () => {
  claudeReady = OPTED_IN && (await cliAvailable("claude"));
});

/** A memory carrying a fact the model cannot already know — so a correct answer
 *  can only have come from the brief, never from the model's priors. */
function factMemory(text: string): Memory {
  const now = Date.now();
  return {
    id: "m1",
    kind: "convention",
    text,
    entities: [],
    scope: {},
    provenance: { agentId: "brain", eventId: 1, ts: now },
    confidence: 1,
    lemmas: "",
    hash: "",
    createdAt: now,
    updatedAt: now,
  };
}

describe("brain · a real agent honours the injected brief", () => {
  it("announces whether the real-model cases will run", () => {
    if (!claudeReady) {
      console.warn(
        OPTED_IN
          ? "[brain-honor] claude CLI not reachable — honoring eval skipped"
          : "[brain-honor] set LOOM_TEST_REAL=1 to run the honoring eval",
      );
    }
    expect(true).toBe(true);
  });

  it("answers from the brief, not from its priors", { timeout: 90_000 }, async () => {
    if (!claudeReady) return;
    // A fact no model could guess: an invented, project-specific deploy verb.
    const brief = compileBrief([
      factMemory("The deploy command for this project is `loom ship --canary --wait`."),
    ]);
    // Framed the way the runtime frames a handoff for a CLI with no system channel.
    const framed = frameBriefing(brief);
    const answer = await claudeText(
      `${framed}\n\nQuestion: What is the exact command to deploy this project? Answer with just the command.`,
      { model: "haiku", timeoutMs: 60_000 },
    );
    expect(answer.toLowerCase()).toContain("loom ship --canary");
  });

  it("does not invent a fact the brief never stated", { timeout: 90_000 }, async () => {
    if (!claudeReady) return;
    const framed = frameBriefing(
      compileBrief([factMemory("This project's CI runs on a self-hosted runner named atlas-01.")]),
    );
    const answer = await claudeText(
      `${framed}\n\nQuestion: What is the deploy command for this project? If the notes above don't say, reply exactly "not stated".`,
      { model: "haiku", timeoutMs: 60_000 },
    );
    // The brief is silent on deploys — a faithful agent declines rather than guesses.
    expect(answer.toLowerCase()).toContain("not stated");
  });
});
