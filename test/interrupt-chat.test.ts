/**
 * Stop is per chat: an agent working in one thread is not stopped by the Stop
 * button of another, and the status says which chat a busy agent is in.
 */
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let rt: ProjectRuntime | undefined;
beforeAll(() => { process.env.LOOM_HOME = tmpDir("home-intchat"); process.env.LOOM_NO_NOTIFY = "1"; });
afterEach(async () => { await rt?.close(); rt = undefined; });

describe("interrupt, per chat", () => {
  it("stops only the turn in the chat you're in", async () => {
    const dir = makeProjectDir({ name: "intchat", agents: [{ id: "a", kind: "echo" }, { id: "b", kind: "echo" }], brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `ic-${path.basename(dir)}`, name: "intchat", dir });
    const side = rt.createChat("side", { agentId: "b" });
    await rt.sendMessage("sleep:4000 working in side", "b", { chat: side.id });
    await waitUntil(async () => (await rt!.status()).agents.some((x) => x.id === "b" && x.busy));
    const b = (await rt.status()).agents.find((x) => x.id === "b") as { busy: boolean; chat?: string };
    expect(b.chat).toBe(side.id);
    // Stop pressed in Main: nothing of Main's is running, so nothing stops
    expect(await rt.interrupt({ chat: "main" })).toEqual({ interrupted: null });
    expect((await rt.status()).agents.find((x) => x.id === "b")!.busy).toBe(true);
    // Stop in the side chat stops b
    expect(await rt.interrupt({ chat: side.id })).toEqual({ interrupted: "b" });
    await waitUntil(async () => !(await rt!.status()).agents.find((x) => x.id === "b")!.busy, { timeoutMs: 5000 });
  });
});
