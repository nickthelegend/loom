/** Standing instructions for one conversation (approach credit: Nuphos's Instructions). */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let pid: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-chat-instr");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  pid = (await client.addProject(makeProjectDir({ name: "instr", agents: [{ id: "bot", kind: "echo", role: "worker" }] } as never))).project.id;
}, 60_000);
afterAll(async () => { await daemon.close(); });

const briefed = async (chat: string, marker: string) => {
  let n = -1;
  await waitUntil(async () => {
    const { events } = await client.events(pid, 0, 300);
    const e = events.find((x) => x.kind === "message" && x.agentId === "bot" && String((x.payload as { text?: string }).text).includes(marker));
    if (!e) return false;
    n = Number(/briefed: (\d+) chars/.exec(String((e.payload as { text?: string }).text))?.[1] ?? 0);
    return true;
  }, 20_000);
  return n;
};

const post = (p: string, body: unknown) => {
  const cfg = readDaemonConfig()!;
  return fetch(`http://${cfg.host}:${cfg.port}${p}`, { method: "POST", headers: { authorization: `Bearer ${cfg.adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
};

describe("chat instructions", () => {
  it("ride every turn in that chat — main included — and nowhere else; empty clears them", async () => {
    const { chat } = await post(`/api/projects/${pid}/chats`, { title: "styled" }) as { chat: { id: string } };
    await post(`/api/projects/${pid}/messages`, { text: "before", agentId: "bot", chat: chat.id });
    const plain = await briefed(chat.id, "before");
    const text = "Answer in British English and keep it to two sentences.";
    expect(await client.setChatInstructions(pid, chat.id, text)).toEqual({ chat: chat.id, instructions: text });
    expect((await client.chatInstructions(pid, chat.id)).instructions).toBe(text);
    await post(`/api/projects/${pid}/messages`, { text: "after", agentId: "bot", chat: chat.id });
    const withThem = await briefed(chat.id, "after");
    expect(withThem - plain).toBeGreaterThanOrEqual(text.length);
    // main has none
    expect((await client.chatInstructions(pid, "main")).instructions).toBe("");
    await client.setChatInstructions(pid, "main", "Main-only rule.");
    expect((await client.chatInstructions(pid, "main")).instructions).toBe("Main-only rule.");
    await client.setChatInstructions(pid, chat.id, "");
    expect((await client.chatInstructions(pid, chat.id)).instructions).toBe("");
    await expect(client.setChatInstructions(pid, "nope", "x")).rejects.toThrow(/no such thread/);
  }, 60_000);
});
