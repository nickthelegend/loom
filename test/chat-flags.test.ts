/**
 * Threads you can pin, archive and star, and the newest-reply id a client
 * compares against to show an unread dot. All of it lives with the project
 * on the daemon, so every device sees the same sidebar.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

describe("chat flags, stars and unread", () => {
  let daemon: LoomDaemon;
  let client: DaemonClient;
  let projectId: string;
  let auth: Record<string, string>;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${client.baseUrl}/api/projects/${projectId}${p}`, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home-chatflags");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    const cfg = readDaemonConfig()!;
    client = new DaemonClient(cfg);
    auth = { authorization: `Bearer ${cfg.adminToken}` };
    const dir = makeProjectDir({ name: "flags" });
    fs.writeFileSync(path.join(dir, "README.md"), "# flags\n");
    projectId = (await client.addProject(dir)).project.id;
  });
  afterAll(async () => {
    await daemon?.close();
  });

  it("pins and archives a thread, and refuses Main", async () => {
    const made = await call("POST", "/chats", { title: "side quest" });
    const id = (made.json.chat as { id: string }).id;
    expect((await call("PATCH", `/chats/${id}`, { pinned: true })).json.chat).toMatchObject({ id, pinned: true });
    expect((await call("PATCH", `/chats/${id}`, { archived: true, pinned: false })).json.chat).toMatchObject({ archived: true });
    const listed = ((await call("GET", "/chats")).json.chats as Array<{ id: string; pinned?: boolean; archived?: boolean }>).find((c) => c.id === id)!;
    expect(listed.pinned).toBeUndefined();
    expect(listed.archived).toBe(true);
    expect((await call("PATCH", "/chats/main", { pinned: true })).status).toBe(400);
    expect((await call("PATCH", "/chats/nope", { pinned: true })).status).toBe(404);
    expect((await call("PATCH", `/chats/${id}`, {})).status).toBe(400);
  });

  it("stars messages in Main too, and reports each thread's newest reply", async () => {
    await client.send(projectId, "hello there", "plannerbot");
    let replyId = 0;
    await waitUntil(async () => {
      const chats = (await call("GET", "/chats")).json.chats as Array<{ id: string; lastReplyId?: number }>;
      replyId = chats.find((c) => c.id === "main")?.lastReplyId ?? 0;
      return replyId > 0;
    });
    const starred = await call("POST", "/chats/main/star", { eventId: replyId });
    expect(starred.json.starred).toEqual([replyId]);
    const main = ((await call("GET", "/chats")).json.chats as Array<{ id: string; starred?: number[] }>).find((c) => c.id === "main")!;
    expect(main.starred).toEqual([replyId]);
    expect((await call("POST", "/chats/main/star", { eventId: replyId, on: false })).json.starred).toEqual([]);
    expect((await call("POST", "/chats/main/star", { eventId: "x" })).status).toBe(400);
  });
});
