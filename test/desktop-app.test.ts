/**
 * The desktop shell's bootstrap (desktop/loom-app.js). It's plain Node, kept
 * out of Electron precisely so it can be tested here.
 *
 * Nothing in this file may spawn or kill a daemon: the tests stand up a fake
 * one over real HTTP and point LOOM_HOME at a temp dir, so the bootstrap talks
 * to a daemon that behaves like the real one and dies with the test.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM JS, no types; that's the point of the seam
import { isStaleDaemon, localBuildRev, openDaemonLog, prepareAppUrl } from "../desktop/loom-app.js";
import { tmpDir } from "./helpers.js";

/**
 * A fixture dist tree, so the hash isn't tied to the real build. Laid out like
 * the real one — the daemon's files live under daemon/, and `extra` drops a file
 * elsewhere in the tree (core/, adapters/) the way tsc does.
 */
function fakeDist(server: string, appPage?: string, extra?: Record<string, string>): string {
  const dir = tmpDir("daemon-fixture");
  fs.mkdirSync(path.join(dir, "daemon"), { recursive: true });
  fs.writeFileSync(path.join(dir, "daemon", "server.js"), server);
  if (appPage !== undefined) fs.writeFileSync(path.join(dir, "daemon", "app-page.js"), appPage);
  for (const [rel, body] of Object.entries(extra ?? {})) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
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

  /**
   * The bug this whole fingerprint exists to prevent, and the one it had for
   * most of its life: it hashed daemon/server.js and daemon/app-page.js only,
   * so editing an adapter or core/registry.js left the rev identical. `loom up`
   * reported "already running" and the daemon kept serving the old code — which
   * is exactly what happened when the echo-agent fallback was removed and the
   * running daemon kept it alive in memory.
   */
  it("moves when a file outside daemon/ changes — the whole tree is the build", () => {
    const base = { "core/registry.js": "export const agents = [];\n" };
    const a = localBuildRev(fakeDist("server\n", "app\n", base));
    const same = localBuildRev(fakeDist("server\n", "app\n", base));
    const changed = localBuildRev(
      fakeDist("server\n", "app\n", { "core/registry.js": "export const agents = [1];\n" }),
    );
    expect(a).toBe(same);
    expect(changed).not.toBe(a);
  });

  it("moves when a file is added or removed, not just edited", () => {
    const bare = localBuildRev(fakeDist("server\n", "app\n"));
    const extra = localBuildRev(fakeDist("server\n", "app\n", { "adapters/codex.js": "" }));
    // an empty new file changes no byte of any existing one: only hashing names
    // alongside contents catches this
    expect(extra).not.toBe(bare);
  });

  it("ignores maps and declarations — only what the daemon actually runs", () => {
    const plain = localBuildRev(fakeDist("server\n", "app\n"));
    const noisy = localBuildRev(
      fakeDist("server\n", "app\n", {
        "daemon/server.js.map": '{"version":3}',
        "types.d.ts": "export type A = 1;",
      }),
    );
    expect(noisy).toBe(plain);
  });

  it("returns null when there is no build to hash", () => {
    expect(localBuildRev(path.join(tmpDir("empty"), "nope"))).toBeNull();
    expect(localBuildRev(tmpDir("empty-but-real"))).toBeNull();
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

/**
 * The shell and the daemon compute the same fingerprint in two files, and the
 * shell restarts any daemon whose rev differs from its own. If they ever
 * disagree, the desktop app kills and respawns a perfectly current daemon on
 * every launch, forever.
 *
 * This must compare against the daemon's REAL rev, not a third copy of the
 * hashing rule — a duplicate would agree with itself while both drift from
 * server.ts. Hence the dist import: BUILD_REV hashes its own `import.meta.url`,
 * so only the built module fingerprints the bytes the shell actually reads.
 */
describe("desktop · rev mirrors the daemon", () => {
  it("agrees with the rev the built daemon reports for itself", async () => {
    const built = path.resolve(import.meta.dirname, "..", "dist", "daemon", "server.js");
    expect(fs.existsSync(built), "run `npm run build` — this guards the built output").toBe(true);
    const { BUILD_REV } = (await import(pathToFileURL(built).href)) as { BUILD_REV: string };
    expect(BUILD_REV).toMatch(/^[0-9a-f]{16}$/);
    expect(localBuildRev()).toBe(BUILD_REV);
  });
});

/**
 * The desktop app is the one most people run, so it's the one whose daemon must
 * leave a trace. It spawned with stdio:"ignore" for most of this project's life:
 * the daemon could die at 3am and there was nothing to read afterwards.
 */
describe("desktop · daemon log", () => {
  const withHome = <T,>(home: string, fn: () => T): T => {
    const prev = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = prev;
    }
  };

  it("opens an appendable log under LOOM_HOME, creating the home if needed", () => {
    const home = path.join(tmpDir("log-home"), "not-yet-there");
    const fd = withHome(home, openDaemonLog);
    expect(typeof fd).toBe("number");
    fs.writeSync(fd as number, "daemon said something\n");
    fs.closeSync(fd as number);
    expect(fs.readFileSync(path.join(home, "daemon.log"), "utf8")).toBe("daemon said something\n");
  });

  it("appends rather than truncating — yesterday's crash is still evidence", () => {
    const home = tmpDir("log-append");
    fs.writeFileSync(path.join(home, "daemon.log"), "older\n");
    const fd = withHome(home, openDaemonLog) as number;
    fs.writeSync(fd, "newer\n");
    fs.closeSync(fd);
    expect(fs.readFileSync(path.join(home, "daemon.log"), "utf8")).toBe("older\nnewer\n");
  });

  it("rolls a big log aside instead of eating the disk", () => {
    const home = tmpDir("log-roll");
    const file = path.join(home, "daemon.log");
    fs.writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
    const fd = withHome(home, openDaemonLog) as number;
    fs.writeSync(fd, "after the roll\n");
    fs.closeSync(fd);
    expect(fs.readFileSync(file, "utf8")).toBe("after the roll\n");
    expect(fs.statSync(`${file}.1`).size).toBe(5 * 1024 * 1024 + 1);
  });

  it("falls back to \"ignore\" when the log can't be opened, rather than refusing to launch", () => {
    // A file where the home directory should be: every path under it is unusable.
    const blocked = path.join(tmpDir("log-blocked"), "home");
    fs.writeFileSync(blocked, "not a directory");
    expect(withHome(blocked, openDaemonLog)).toBe("ignore");
  });
});
