/**
 * Loom-bridge tests. Only the *safe* parts: reachability, the agent list, and a
 * select (handoff). Deliberately does NOT call loomAsk — that runs a real agent
 * against your project. Skips cleanly when the daemon isn't up.
 *   node --test test/loom.test.mjs
 */

import assert from "node:assert/strict";
import { test, before } from "node:test";
import { loomReachable, loomInit, loomAgents, loomSelect } from "../loom.mjs";

let up = false;
before(async () => {
  up = await loomReachable();
  if (!up) console.warn("  [loom] daemon not reachable — bridge tests skipped");
});

test("loom is reachable and exposes agents", async (t) => {
  if (!up) return t.skip("loom daemon not reachable");
  const { projectId, agents } = await loomInit();
  assert.ok(projectId, "a project id");
  assert.ok(agents.length > 0, "at least one agent");
  assert.deepEqual(loomAgents(), agents);
});

test("select locks the baton to an available agent", async (t) => {
  if (!up) return t.skip("loom daemon not reachable");
  const agents = loomAgents();
  // opencode is the default full-duplex adapter in the loom project.
  const target = agents.includes("opencode") ? "opencode" : agents[0];
  const r = await loomSelect(target);
  assert.equal(r.to, target, `baton handed to ${target}`);
});
