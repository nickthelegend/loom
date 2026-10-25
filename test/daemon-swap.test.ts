/**
 * Peer ask (field): 1.2.6 → 1.2.7 swapped between two chained runs and was noticed only from
 * "up 14m". Swaps are said out loud and recorded; a long unattended chain can opt out.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoRestartEnabled, describeSwap, readSwapNote, setAutoRestart, writeSwapNote } from "../src/core/daemon-swap.js";
import { DaemonClient, ensureDaemon } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

afterEach(() => { delete process.env.LOOM_AUTO_RESTART; vi.restoreAllMocks(); });

describe("daemon swaps", () => {
  it("auto-restart is on by default; the setting and the env turn it off", () => {
    process.env.LOOM_HOME = tmpDir("home-swap-setting");
    expect(autoRestartEnabled()).toBe(true);
    setAutoRestart(false);
    expect(autoRestartEnabled()).toBe(false);
    setAutoRestart(true);
    process.env.LOOM_AUTO_RESTART = "off";
    expect(autoRestartEnabled()).toBe(false);
  });

  it("names versions when they differ, builds when they don't; a note is only for the build it brought up", () => {
    process.env.LOOM_HOME = tmpDir("home-swap-note");
    expect(describeSwap({ fromVersion: "1.2.6", fromRev: "aaa", toVersion: "1.2.7", toRev: "bbb", at: 1 })).toBe("1.2.6 → 1.2.7");
    expect(describeSwap({ fromVersion: "1.2.7", fromRev: "aaa", toVersion: "1.2.7", toRev: "bbb", at: 1 })).toBe("aaa → bbb");
    writeSwapNote({ fromVersion: "1.2.6", toVersion: "1.2.7", toRev: "bbb", at: 5 });
    expect(readSwapNote("bbb")?.fromVersion).toBe("1.2.6");
    expect(readSwapNote("ccc")).toBeNull();
  });

  it("with auto-restart off, an older daemon is used as it is, and the CLI says why", async () => {
    process.env.LOOM_HOME = tmpDir("home-swap-off");
    const old = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/health" ? { ok: true, version: "0.0.1", rev: "old-build" } : {}));
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    const port = (old.address() as { port: number }).port;
    fs.writeFileSync(path.join(process.env.LOOM_HOME, "daemon.json"), JSON.stringify({ host: "127.0.0.1", port, adminToken: "t", clients: [] }));
    setAutoRestart(false);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const client = await ensureDaemon();
      expect(client).toBeInstanceOf(DaemonClient);
      expect(String(err.mock.calls.map((c) => c[0]).join(""))).toMatch(/older build \(0\.0\.1\).*auto-restart is off — loom up --restart/);
      // nothing stopped it
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    } finally {
      await new Promise((r) => old.close(r));
    }
  });

  it("a daemon brought up by a swap logs it and reports it on /api/version", async () => {
    process.env.LOOM_HOME = tmpDir("home-swap-up");
    process.env.LOOM_NO_NOTIFY = "1";
    const { BUILD_REV } = await import("../src/daemon/server.js");
    writeSwapNote({ fromVersion: "1.2.6", fromRev: "old", toVersion: "1.2.7", toRev: BUILD_REV, at: Date.now() });
    const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    try {
      const { readDaemonConfig } = await import("../src/core/registry.js");
      const v = await new DaemonClient(readDaemonConfig()!).version();
      expect(v.swap).toMatchObject({ fromVersion: "1.2.6", toRev: BUILD_REV });
    } finally {
      await daemon.close();
    }
  });
});
