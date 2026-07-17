/**
 * Five agents, five prompts, one shared brain.
 *
 * The claim under test — the thing that makes Loom's memory a *shared* memory
 * rather than five private notebooks: a fact learned during one agent's turn is
 * available to every other agent that later takes the baton. It works because
 * the brain belongs to the project (the event log), and extracted memories are
 * scoped to the chat, not to the agent who happened to learn them. The agent is
 * recorded as provenance ("who learned it"), never as a wall around it.
 *
 * This drives the exact path the daemon runs on every turn — extractFromTurn →
 * retrieve → compileBrief (runtime.ts:560 and :658) — but with a deterministic,
 * model-free engine so it runs on every `npm test`. The real-model version lives
 * in brain-real.test.ts behind LOOM_TEST_REAL.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Brain, CONFIDENCE_FLOOR } from "../src/core/brain.js";
import { extractFromTurn, type ExtractEngine } from "../src/core/brain-extract.js";
import { compileBrief, retrieve } from "../src/core/brain-index.js";
import { EventLog } from "../src/core/eventlog.js";
import { tmpDir } from "./helpers.js";

async function freshBrain(): Promise<Brain> {
  const dir = path.join(tmpDir("brain-shared"), ".loom");
  fs.mkdirSync(dir, { recursive: true });
  return new Brain(await EventLog.open(dir));
}

/**
 * A deterministic stand-in for the LLM extractor. It reads a "FACT: <sentence>"
 * line out of the turn and returns exactly one ADD, quoting the sentence
 * verbatim as evidence — so the in-code evidence check (the real hallucination
 * guard) passes for real. No network, no model, same code path.
 */
const factEngine: ExtractEngine = async ({ user }) => {
  const m = user.match(/FACT:\s*(.+)/);
  if (!m || !m[1]) return JSON.stringify({ ops: [{ op: "NONE" }] });
  const fact = m[1].trim();
  const kind = /\b(fail|failed|breaks?|broke|don't|do not|never)\b/i.test(fact) ? "failure" : "fact";
  return JSON.stringify({ ops: [{ op: "ADD", text: fact, kind, evidence: fact, confidence: 0.9 }] });
};

const AGENTS = ["claude-code", "codex", "opencode", "grok-code", "kiro"];
const PROMPTS = [
  "FACT: the daemon binds to 127.0.0.1 by default and expose adds a second listener on the LAN IP.",
  "FACT: pairing tokens are single-use and expire after 10 minutes.",
  "FACT: never rebind the live server to 0.0.0.0 — it races into EADDRINUSE while the browser holds the port.",
  "FACT: the brain stores memory as memory_add/update/forget events folded from the log.",
  "FACT: Linear needs LINEAR_API_KEY and stays in an honest not-connected state until keyed.",
];
// One term from every prompt, so retrieval makes all five candidates for anyone.
const BROAD_QUERY =
  "daemon 127.0.0.1 pairing token EADDRINUSE rebind memory_add brain linear LINEAR_API_KEY listener";

describe("five agents share one brain", () => {
  it("each agent's handoff brief carries what the other four learned", async () => {
    const brain = await freshBrain();

    // Five turns: agent i runs prompt i, and the brain learns from that turn.
    for (let i = 0; i < AGENTS.length; i++) {
      const turn = `user: work on the app\n${AGENTS[i]}: done — ${PROMPTS[i]}`;
      const res = await extractFromTurn(brain, turn, {
        engine: factEngine,
        agentId: AGENTS[i],
        chat: "main",
        eventId: i + 1,
      });
      expect(res.added).toHaveLength(1);
    }

    // All five memories live in the one project brain.
    expect(brain.all()).toHaveLength(5);

    // Provenance is per-agent (who learned it) — but nothing is walled off to an
    // agent: no memory carries an agent scope.
    expect(new Set(brain.all().map((m) => m.provenance.agentId))).toEqual(new Set(AGENTS));
    expect(brain.all().every((m) => !m.scope.agent)).toBe(true);

    // The real claim: every agent, retrieving for its own handoff, sees all five
    // facts — including the four it never learned itself.
    for (const agent of AGENTS) {
      const hits = retrieve(brain, {
        query: BROAD_QUERY,
        agent,
        minConfidence: CONFIDENCE_FLOOR,
        limit: 14,
      });
      expect(hits).toHaveLength(5);

      const brief = compileBrief(hits.map((h) => h.memory));
      // A fact contributed by each of the five agents is in this agent's brief.
      expect(brief).toContain("second listener on the LAN IP"); // claude-code
      expect(brief).toContain("single-use"); // codex
      expect(brief).toContain("EADDRINUSE"); // opencode
      expect(brief).toContain("memory_add/update/forget"); // grok-code
      expect(brief).toContain("LINEAR_API_KEY"); // kiro
    }
  });

  it("a failure one agent hit reaches a different agent, tagged as a failure", async () => {
    const brain = await freshBrain();
    await extractFromTurn(
      brain,
      "user: x\ncodex: FACT: never rebind to 0.0.0.0, it breaks with EADDRINUSE.",
      { engine: factEngine, agentId: "codex", chat: "main", eventId: 1 },
    );
    await extractFromTurn(brain, "user: y\ngrok-code: FACT: the daemon port is 7420.", {
      engine: factEngine,
      agentId: "grok-code",
      chat: "main",
      eventId: 2,
    });

    // kiro — a third agent that learned neither — inherits both.
    const hits = retrieve(brain, {
      query: "rebind 0.0.0.0 EADDRINUSE daemon port 7420",
      agent: "kiro",
      limit: 5,
    });
    expect(hits).toHaveLength(2);
    const kinds = new Set(hits.map((h) => h.memory.kind));
    expect(kinds.has("failure")).toBe(true); // codex's, classified as a failure
    expect(kinds.has("fact")).toBe(true); // grok-code's
  });

  it("a private (agent-scoped) memory is NOT shared — the scope is honoured", async () => {
    const brain = await freshBrain();
    // Deliberately scope one memory to a single agent (the extractor never does
    // this, but the store supports it) and prove retrieval keeps it private.
    brain.add({
      kind: "fact",
      text: "codex prefers the gpt-5-codex model for this repo.",
      scope: { agent: "codex" },
      provenance: { agentId: "codex", eventId: 1, ts: Date.now() },
    });
    const forCodex = retrieve(brain, { query: "codex model gpt-5-codex", agent: "codex", limit: 5 });
    const forKiro = retrieve(brain, { query: "codex model gpt-5-codex", agent: "kiro", limit: 5 });
    expect(forCodex).toHaveLength(1); // its owner sees it
    expect(forKiro).toHaveLength(0); // another agent does not
  });
});
