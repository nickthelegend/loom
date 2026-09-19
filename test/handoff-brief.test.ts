/**
 * What the brain knows reaches the next agent on a handoff — in the briefing
 * prepended to its turn, which every adapter receives. Found by the
 * real-product e2e run: the retrieved memories only went to a memory file that
 * most CLIs (codex, opencode, grok, agy) never read, so a handoff to codex
 * carried the conversation and none of what the project had learned.
 */

import { afterEach, describe, expect, it } from "vitest";

import { AdapterBase } from "../src/adapters/base.js";
import { registerAgentKind } from "../src/adapters/index.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { SendInput } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const briefings: string[] = [];
class Capture extends AdapterBase {
  async available() {
    return true;
  }
  async start() {}
  async stop() {}
  async interrupt() {}
  async diff() {
    return "";
  }
  async send(input: SendInput) {
    briefings.push(input.briefing ?? "");
    this.emit({ kind: "message", payload: { text: "ok" } });
    this.emit({ kind: "run_complete", payload: {} });
  }
}
registerAgentKind("capture", (cfg, dir) => new Capture(cfg.id, "capture", dir));

let rt: ProjectRuntime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
});

describe("handoff briefing", () => {
  it("carries the retrieved brain memories to an agent that only reads its briefing", async () => {
    process.env.LOOM_HOME = tmpDir("home-brief");
    const dir = makeProjectDir({ name: "b", agents: [{ id: "echo", kind: "echo" }, { id: "cap", kind: "capture" }] });
    rt = await ProjectRuntime.open({ id: `b-${Date.now()}`, name: "b", dir });
    rt.brain.add({ kind: "fact", text: "The billing service listens on port 8111.", provenance: { agentId: "user", eventId: 0, ts: Date.now() } });
    await rt.sendMessage("we are about to work on the billing service", "echo");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length >= 1, { timeoutMs: 5000 });
    await rt.handoff("cap");
    await rt.sendMessage("which port does billing use?", "cap");
    await waitUntil(() => briefings.length >= 1, { timeoutMs: 5000 });
    expect(briefings[0]).toContain("billing service listens on port 8111");
  });
});
