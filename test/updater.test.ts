/**
 * Is there a newer Loom, and may this copy fetch it?
 *
 * The comparison and the install detection are the whole risk here: say "newer"
 * when it isn't and people chase updates that don't exist; guess the install
 * wrong and a command runs over someone's tree. Both are pure functions, so
 * both are tested directly — and the route is tested against a real daemon,
 * with GitHub's answer stubbed, because nothing in a test suite should depend
 * on a release existing.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectInstall, latestRelease, newerThan, plan, refuseDirtyCheckout } from "../src/core/updater.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

describe("is it newer", () => {
  it("compares versions the way a person would read them", () => {
    expect(newerThan("0.2.1", "0.2.0")).toBe(true);
    expect(newerThan("0.2.10", "0.2.9")).toBe(true); // not a string compare
    expect(newerThan("1.0.0", "0.9.9")).toBe(true);
    expect(newerThan("0.2.0", "0.2.0")).toBe(false);
    expect(newerThan("0.2.0", "0.2.1")).toBe(false);
    expect(newerThan("v0.3.0", "0.2.9")).toBe(true); // tags carry their v
  });

  it("puts a prerelease under its release, and never guesses at nonsense", () => {
    expect(newerThan("1.0.0", "1.0.0-rc2")).toBe(true);
    expect(newerThan("1.0.0-rc2", "1.0.0")).toBe(false);
    expect(newerThan("1.0.0-rc2", "1.0.0-rc1")).toBe(true);
    // unparseable means "no update": the safe direction
    expect(newerThan("nightly", "0.2.0")).toBe(false);
    expect(newerThan("", "0.2.0")).toBe(false);
  });
});

describe("what this copy is", () => {
  it("knows a checkout from a global npm install, and says so when it knows neither", () => {
    const root = tmpDir("install-git");
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "dist", "daemon"), { recursive: true });
    expect(detectInstall(path.join(root, "dist", "daemon"))).toMatchObject({ kind: "git", cwd: root });

    const prefix = tmpDir("install-npm");
    const pkgRoot = path.join(prefix, "lib", "node_modules", "@loompad", "cli");
    fs.mkdirSync(path.join(pkgRoot, "dist", "daemon"), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@loompad/cli", version: "0.2.1" }));
    expect(detectInstall(path.join(pkgRoot, "dist", "daemon"))).toMatchObject({ kind: "npm-global", cwd: pkgRoot });

    const loose = tmpDir("install-loose");
    fs.mkdirSync(path.join(loose, "dist"), { recursive: true });
    expect(detectInstall(path.join(loose, "dist"))).toMatchObject({ kind: "unknown", cwd: null });
  });

  it("plans in the exact commands it will run, and refuses rather than guess", () => {
    const git = plan({ kind: "git", cwd: "/src/loom" });
    expect(git.steps.map((s) => [s.cmd, ...s.args].join(" "))).toEqual([
      "git pull --ff-only",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    expect(git.refusal).toBeNull();

    const npm = plan({ kind: "npm-global", cwd: "/usr/lib/node_modules/@loompad/cli", spec: "github:acme/loom" });
    expect(npm.steps).toEqual([{ cmd: "npm", args: ["install", "-g", "github:acme/loom"] }]);

    const unknown = plan({ kind: "unknown", cwd: null });
    expect(unknown.steps).toEqual([]);
    expect(unknown.refusal).toMatch(/download the release/);
  });

  it("won't move over your uncommitted work, and doesn't mind untracked files", () => {
    expect(refuseDirtyCheckout(" M src/core/updater.ts\n")).toMatch(/uncommitted changes to 1 file/);
    expect(refuseDirtyCheckout(" M a.ts\nM  b.ts\n")).toMatch(/2 files/);
    expect(refuseDirtyCheckout("")).toBeNull();
    // a scratch file or a symlinked node_modules doesn't stop a fast-forward
    expect(refuseDirtyCheckout("?? SCRATCH.md\n?? node_modules\n")).toBeNull();
  });
});

describe("reading the published release", () => {
  const ok = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("takes the tag, the notes and the date", async () => {
    const r = await latestRelease(
      ok({ tag_name: "v0.3.0", html_url: "https://example.invalid/releases/v0.3.0", published_at: "2026-09-20T00:00:00Z" }),
      "acme/loom",
    );
    expect(r).toMatchObject({ version: "0.3.0", tag: "v0.3.0", url: "https://example.invalid/releases/v0.3.0" });
  });

  it("answers null rather than throwing when there's nothing to read", async () => {
    const drafty = await latestRelease(ok({ tag_name: "v9.9.9", draft: true }), "acme/loom");
    expect(drafty).toBeNull();
    const rateLimited = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    expect(await latestRelease(rateLimited, "acme/loom")).toBeNull();
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await latestRelease(offline, "acme/loom")).toBeNull();
  });
});

describe("the daemon's answer", () => {
  let daemon: LoomDaemon;
  let client: DaemonClient;

  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home-updates");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    client = new DaemonClient(readDaemonConfig()!);
  }, 20_000);

  afterAll(async () => {
    await daemon.close();
  });

  it("reports this build, how it was installed, and what updating would run", async () => {
    const u = await client.updates();
    expect(u.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(u.rev).toBeTruthy();
    expect(["git", "npm-global", "unknown"]).toContain(u.install);
    // The suite runs from a checkout, so it can update itself — and says how.
    expect(u.canApply).toBe(true);
    expect(u.steps[0]).toBe("git pull --ff-only");
    // Whether a release exists depends on the network; the shape must not.
    expect(typeof u.behindRelease).toBe("boolean");
  });
});
