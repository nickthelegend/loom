/**
 * The desktop shell's bootstrap (desktop/loom-app.js). It's plain Node, kept
 * out of Electron precisely so it can be tested here.
 *
 * Nothing in this file may spawn or kill a daemon: the tests stand up a fake
 * one over real HTTP and point LOOM_HOME at a temp dir, so the bootstrap talks
 * to a daemon that behaves like the real one and dies with the test.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM JS, no types; that's the point of the seam
import { isStaleDaemon, localBuildRev, prepareAppUrl } from "../desktop/loom-app.js";
import { tmpDir } from "./helpers.js";

/** A fixture dist/daemon dir, so the hash isn't tied to the real build. */
function fakeDist(server: string, appPage?: string): string {
  const dir = tmpDir("daemon-fixture");
  fs.writeFileSync(path.join(dir, "server.js"), server);
  if (appPage !== undefined) fs.writeFileSync(path.join(dir, "app-page.js"), appPage);
  return dir;
}

describe("desktop · localBuildRev", () => {
  it("fingerprints the built daemon by content", () => {
    const rev = localBuildRev(fakeDist("export const a = 1;\n", "export const APP = 2;\n"));
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for identical content and different for changed content", () => {
    const a = localBuildRev(fakeDist("server\n", "app\n"));
    const same = localBuildRev(fakeDist("server\n", "app\n"));
    const changed = localBuildRev(fakeDist("server\n", "app!\n"));
    expect(a).toBe(same);
    // the whole point: a UI-only rebuild must move the rev, or the shell keeps
    // a daemon that serves the old app
    expect(changed).not.toBe(a);
  });

  it("still fingerprints when the app page is missing", () => {
    const rev = localBuildRev(fakeDist("export const a = 1;\n"));
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns null when there is no build to hash", () => {
    expect(localBuildRev(path.join(tmpDir("empty"), "nope"))).toBeNull();
  });
});

describe("desktop · isStaleDaemon", () => {
  it("restarts only a daemon whose build is known and different", () => {
    expect(isStaleDaemon("aaaa", "bbbb")).toBe(true);
    expect(isStaleDaemon("aaaa", "aaaa")).toBe(false);
  });

  it("never kills a daemon it cannot fingerprint", () => {
    // an unbuilt checkout (no local rev) or an old daemon that reports no rev:
    // loading a possibly-stale app beats killing someone else's daemon
    expect(isStaleDaemon("aaaa", null)).toBe(false);
    expect(isStaleDaemon(undefined, "bbbb")).toBe(false);
    expect(isStaleDaemon(undefined, null)).toBe(false);
  });
});

describe("desktop · prepareAppUrl", () => {
  let server: http.Server;
  let port: number;
  let home: string;
  let minted = 0;
  let seenAuth: string | undefined;
  let mintStatus = 200;

  beforeAll(async () => {
    // A daemon that reports the *local* build, so the bootstrap reuses it
    // rather than trying to restart anything.
    const rev = localBuildRev();
    server = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ ok: true, name: "loom", rev }));
      }
      if (req.url === "/api/pair/new" && req.method === "POST") {
        seenAuth = req.headers.authorization;
        if (mintStatus !== 200) {
          res.statusCode = mintStatus;
          return void res.end("{}");
        }
        minted++;
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ token: "tok-" + minted }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;

    home = tmpDir("desktop-home");
    process.env.LOOM_HOME = home;
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({ host: "127.0.0.1", port, adminToken: "admin-secret" }),
    );
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("reuses a current daemon and deep-links a freshly minted pairing token", async () => {
    const { url, base, port: got } = await prepareAppUrl();
    expect(got).toBe(port);
    expect(base).toBe(`http://127.0.0.1:${port}`);
    expect(url).toBe(`http://127.0.0.1:${port}/app#pair=tok-1`);
    // the token is minted with the admin credential from daemon.json
    expect(seenAuth).toBe("Bearer admin-secret");
  });

  it("mints a new single-use token on every launch", async () => {
    const { url } = await prepareAppUrl();
    expect(url).toContain("#pair=tok-2");
    expect(minted).toBe(2);
  });

  it("surfaces a mint failure instead of loading an unpaired window", async () => {
    mintStatus = 500;
    await expect(prepareAppUrl()).rejects.toThrow(/could not mint pairing token \(500\)/);
    mintStatus = 200;
  });
});

/** Guard the mirror: the two revs are computed in different files and must agree. */
describe("desktop · rev mirrors the daemon", () => {
  it("hashes the same bytes the daemon hashes for its own rev", async () => {
    const daemonDir = path.resolve(import.meta.dirname, "..", "dist", "daemon");
    if (!fs.existsSync(path.join(daemonDir, "server.js"))) return; // not built
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(daemonDir, "server.js")))
      .update(fs.readFileSync(path.join(daemonDir, "app-page.js")))
      .digest("hex")
      .slice(0, 16);
    expect(localBuildRev()).toBe(hash);
  });
});
