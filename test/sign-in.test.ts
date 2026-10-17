/**
 * An agent that failed a turn on sign-in is shown as not signed in until it
 * succeeds again (#251) — the REACH field test's grok-code passed a file-based
 * sign-in check, then refused every turn with "Not signed in".
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-signin");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("sign-in learned from a real turn", () => {
  it("a 'Not signed in' failure marks the agent; its next good turn clears it", async () => {
    const dir = tmpDir("signin");
    writeProjectConfig(dir, { name: "signin", agents: [{ id: "grokish", kind: "echo" }, { id: "or", kind: "model", options: { model: "openrouter/pool:free", tools: true } }], brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `signin-${path.basename(dir)}`, name: "signin", dir });
    const agentOf = async (id: string) => (await rt!.status()).agents.find((a) => a.id === id)!;
    await rt.sendMessage("fail: Not signed in. To authenticate without a browser, run: grok login --device-code", "grokish");
    await waitUntil(() => rt!.log.list({ kinds: ["error"] }).length === 1);
    expect((await agentOf("grokish")).signedOut).toBe("Not signed in. To authenticate without a browser, run: grok login --device-code");
    await rt.sendMessage("hello again", "grokish");
    await waitUntil(() => rt!.log.list({ kinds: ["run_complete"] }).length === 1);
    expect((await agentOf("grokish")).signedOut).toBeUndefined();
    // a model agent without --write is read-only (#257)
    expect((await agentOf("or")).readOnly).toBe(true);
  });
});
