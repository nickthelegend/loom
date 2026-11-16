import { afterEach, describe, expect, it } from "vitest";
import { CodexProviderAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude/adapter.js";
import { CodexAdapter, stopAllProviderSessions } from "../../src/providers/agent.js";
import type { ProviderAdapter } from "../../src/providers/adapter.js";
import { makeProjectDir, waitUntil } from "../helpers.js";
import { fakeCodex, fakeClaude, rpcOf, stdinOf, codexDone, callsOf } from "../native-fakes.js";

let adapter: ProviderAdapter | undefined;
afterEach(async () => { await adapter?.stopAll(); adapter = undefined; await stopAllProviderSessions(); });

describe("provider steering", () => {
  it("sends Codex the native thread and active turn precondition without starting another turn", async () => {
    const bin = fakeCodex({ script: [{ sleep: 1000 }, codexDone()] });
    const agent = new CodexAdapter("codex", makeProjectDir(), { bin });
    const turn = agent.send({ text: "first", chat: "side" });
    await waitUntil(() => rpcOf(bin, "turn/start").length === 1);
    await waitUntil(() => agent.steer("side", "new direction"));
    expect(await agent.steer("main", "wrong chat")).toBe(false);
    const request = rpcOf(bin, "turn/steer")[0]!;
    expect(request).toEqual({ threadId: expect.stringMatching(/^thread-/), expectedTurnId: expect.stringMatching(/^turn-/),
      input: [{ type: "text", text: "new direction", text_elements: [] }] });
    expect(request.threadId).toBe(rpcOf(bin, "turn/start")[0]!.threadId);
    await turn;
    expect(await agent.steer("side", "too late")).toBe(false);
    expect(rpcOf(bin, "turn/start")).toHaveLength(1);
    expect(rpcOf(bin, "turn/steer")).toHaveLength(1);
    expect(callsOf(bin)).toHaveLength(1);
  });

  it("returns false for a Codex refusal, but propagates an unknown delivery outcome", async () => {
    for (const options of [{ refuseSteer: true }, { closeOnSteer: true }]) {
      const bin = fakeCodex({ ...options, script: [{ sleep: 1000 }, codexDone()] });
      adapter = new CodexProviderAdapter("codex", { bin });
      expect(await adapter.steer!("side", "before start")).toBe(false);
      await adapter.startSession({ threadId: "side", instanceId: "codex", cwd: makeProjectDir(), runtimeMode: "full-access" });
      await adapter.sendTurn({ threadId: "side", instanceId: "codex", input: "first" });
      if (options.refuseSteer) expect(await adapter.steer!("side", "refused")).toBe(false);
      else await expect(adapter.steer!("side", "uncertain")).rejects.toThrow();
      await adapter.stopAll();
      adapter = undefined;
    }
  });

  it("feeds Claude's live SDK input stream and preserves the active turn", async () => {
    const bin = fakeClaude({ script: [{ sleep: 5000 }] });
    adapter = new ClaudeProviderAdapter("claude", { bin });
    expect(await adapter.steer!("side", "before start")).toBe(false);
    await adapter.startSession({ threadId: "side", instanceId: "claude", cwd: makeProjectDir(), runtimeMode: "full-access" });
    const turn = await adapter.sendTurn({ threadId: "side", instanceId: "claude", input: "first" });
    await waitUntil(() => stdinOf(bin).some(m => m.type === "user"));
    expect(await adapter.steer!("main", "wrong chat")).toBe(false);
    expect(await adapter.steer!("side", "mid-turn input")).toBe(true);
    await waitUntil(() => stdinOf(bin).filter(m => m.type === "user").length === 2);
    const messages = stdinOf(bin).filter(m => m.type === "user");
    expect(messages[1]).toMatchObject({ message: { role: "user", content: [{ type: "text", text: "mid-turn input" }] } });
    expect(messages[1]!.uuid).not.toBe(messages[0]!.uuid);
    expect(adapter.listSessions()[0]!.activeTurnId).toBe(turn.turnId);
    expect(callsOf(bin)).toHaveLength(1);
  });
});
