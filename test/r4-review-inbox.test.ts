import fs from "node:fs";
import path from "node:path";
import express from "express";
import { expect, it, vi } from "vitest";
import { projectInbox, registerReviewR4Routes } from "../src/daemon/routes/review-r4.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import type { WithRuntime } from "../src/daemon/routes/context.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

vi.mock("../src/core/registry.js", () => ({ listProjects: () => [{ id: "open", name: "Open" }, { id: "closed", name: "Closed" }] }));
function fixture() {
  const dir = tmpDir("r4-inbox"), file = path.join(dir, "a.ts"); fs.writeFileSync(file, "changed\n");
  let id = 1;
  const events = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, kind: "turn_diff", chat: `c${i}`, payload: { files: [{ path: "a.ts" }], patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+changed\n" } } as LoomEvent));
  const list = vi.fn((opts: { kinds: string[] }) => opts.kinds.includes("turn_diff") ? events : []);
  const rt = { info: { dir }, log: { lastId: () => id, list }, chats: () => [...events.map(e => ({ id: e.chat!, title: e.chat! })), { id: "empty", title: "No changes" }],
    orchestra: { list: () => ["aborted", "failed", "moved"].map(status => ({ status, id: status })).concat([{ status: "completed", id: "applied", applied: true } as any]) } } as unknown as ProjectRuntime;
  return { rt, list, file, bump: () => { id++; } };
}
it("reads each log projection once, skips empty chats and inactive runs, and caches concurrent inbox requests", async () => {
  const f = fixture(), read = vi.spyOn(fs, "readFileSync");
  try {
    const [first, second] = await Promise.all([projectInbox(f.rt), projectInbox(f.rt)]);
    expect(first).toHaveLength(40); expect(second).toBe(first); expect(f.list).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.filter(([file]) => String(file) === f.file)).toHaveLength(1);
    expect(await projectInbox(f.rt)).toBe(first); expect(f.list).toHaveBeenCalledTimes(2);
    fs.appendFileSync(f.file, "manual edit\n");
    const changed = await projectInbox(f.rt); expect(changed[0]!.files[0]!.version).not.toBe(first[0]!.files[0]!.version); expect(f.list).toHaveBeenCalledTimes(4);
    f.bump(); await projectInbox(f.rt); expect(f.list).toHaveBeenCalledTimes(6);
  } finally { read.mockRestore(); }
});
it("reports unopened projects without creating runtimes and respects inbox scope", async () => {
  const f = fixture(), app = express();
  app.use((req, _res, next) => { if (req.headers["x-scoped"]) (req as any).projectScope = ["open"]; next(); });
  const runtime = vi.fn();
  registerReviewR4Routes(app, (() => (_req: unknown, _res: unknown) => {}) as WithRuntime, { runtimes: new Map([["open", f.rt]]), runtime } as any);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/review/inbox`;
  try {
    const result = await (await fetch(url)).json(); expect(result.items).toHaveLength(40); expect(result.errors).toEqual([{ project: "closed", error: "not open" }]);
    const scoped = await (await fetch(url, { headers: { "x-scoped": "1" } })).json(); expect(scoped.errors).toEqual([]); expect(runtime).not.toHaveBeenCalled(); expect(f.list).toHaveBeenCalledTimes(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
