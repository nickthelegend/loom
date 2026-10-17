/**
 * Subtasks report what happened: a child whose turn failed is subtask_failed,
 * whether its adapter threw or reported the failure as an error event and
 * returned normally — the REACH field test's grok-code ("Not signed in…",
 * then subtask_done) was the second kind (#247).
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-subtasks");
  process.env.LOOM_NO_NOTIFY = "1";
});

async function project() {
  const dir = tmpDir("subtasks");
  writeProjectConfig(dir, { name: "sub", agents: [{ id: "planner", kind: "echo" }, { id: "reviewer", kind: "echo" }], brain: { extractor: "off" } });
  rt = await ProjectRuntime.open({ id: `sub-${path.basename(dir)}`, name: "sub", dir });
}
const ends = () => rt!.log.list({ kinds: ["subtask_done", "subtask_failed"] });

describe("a subtask's outcome", () => {
  it("a child that reported an error and returned is failed, with the error", async () => {
    await project();
    await rt!.spawnSubAgent("planner", { agentId: "reviewer", task: "review it fail: Not signed in. Run grok login." });
    await waitUntil(() => ends().length === 1);
    expect(ends()[0]).toMatchObject({ kind: "subtask_failed", agentId: "reviewer", payload: { message: "Not signed in. Run grok login." } });
  });

  it("a child that finished is done", async () => {
    await project();
    await rt!.spawnSubAgent("planner", { agentId: "reviewer", task: "review the diff" });
    await waitUntil(() => ends().length === 1);
    expect(ends()[0]).toMatchObject({ kind: "subtask_done", agentId: "reviewer" });
  });
});
