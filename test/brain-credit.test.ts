/**
 * Memories are credited to the agent that wrote the text (#248): in the REACH
 * field test, Codex's review was credited to Antigravity, whose own run had
 * timed out with nothing, because extraction read the whole chat since the last
 * prompt and credited whoever's turn had just ended.
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtractEngine } from "../src/core/brain-extract.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-credit");
  process.env.LOOM_NO_NOTIFY = "1";
});

/** Learns one thing, only from a turn that contains the reviewer's finding. */
const engine: ExtractEngine = async (p) => JSON.stringify({ ops: p.user.includes("REVIEWMARK the retry loop has no cap")
  ? [{ op: "ADD", kind: "fact", text: "The retry loop in the client has no cap.", evidence: "REVIEWMARK the retry loop has no cap" }] : [] });

describe("who a memory is credited to", () => {
  it("the reviewer who said it — not the next agent whose turn ended in the same chat", async () => {
    const dir = tmpDir("credit");
    writeProjectConfig(dir, { name: "credit", agents: [{ id: "planner", kind: "echo" }, { id: "reviewer", kind: "echo" }, { id: "other", kind: "echo" }] });
    rt = await ProjectRuntime.open({ id: `credit-${path.basename(dir)}`, name: "credit", dir });
    (rt as unknown as { briefings: { host: { extractionEngine: () => ExtractEngine } } }).briefings.host.extractionEngine = () => engine;
    await rt.sendMessage("kick off the review round", "planner");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    await rt.spawnSubAgent("planner", { agentId: "reviewer", task: "REVIEWMARK the retry loop has no cap, and it should" });
    await waitUntil(() => rt!.log.list({ kinds: ["subtask_done"] }).length === 1);
    await rt.spawnSubAgent("planner", { agentId: "other", task: "looks fine to me overall, nothing to add here" });
    await waitUntil(() => rt!.log.list({ kinds: ["subtask_done"] }).length === 2);
    await waitUntil(() => rt!.brain.all().length >= 1, { timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    const credited = rt.brain.all().map((m) => m.provenance.agentId);
    expect(credited).toEqual(["reviewer"]);
    // and the provenance points at the reviewer's own reply
    const m = rt.brain.all()[0]!;
    expect(rt.log.list({ limit: 200 }).find((e) => e.id === m.provenance.eventId)).toMatchObject({ kind: "message", agentId: "reviewer" });
  });
});
