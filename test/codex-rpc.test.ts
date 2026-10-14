import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { CodexRpc, type Json } from "../src/providers/codex/rpc.js";

it("flushes a settled server reply before a later interruption message", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let wire = "";
  stdin.on("data", chunk => { wire += chunk.toString(); });
  let answer!: (value: Json) => void;
  const pending = new Promise<Json>(resolve => { answer = resolve; });
  const rpc = new CodexRpc({ stdin, stdout } as unknown as ChildProcess, {
    notification: () => {}, request: async () => await pending,
  });
  try {
    stdout.write(JSON.stringify({ id: "question", method: "item/tool/requestUserInput", params: {} }) + "\n");
    let flushed = false;
    const flushing = rpc.flushServerResponses().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    answer({ answers: {} });
    await flushing;
    rpc.notify("turn/interrupt", { turnId: "turn" });
    expect(wire.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { id: "question", result: { answers: {} } },
      { method: "turn/interrupt", params: { turnId: "turn" } },
    ]);
  } finally {
    rpc.close(new Error("test ended"));
    stdin.destroy(); stdout.destroy();
  }
});
