/**
 * The build configs, checked without building.
 *
 * A real `electron-builder` run takes minutes and downloads 100MB of Electron,
 * so it doesn't belong in the suite. What does belong is the class of bug that
 * made the first DMG useless: config that is syntactically fine, builds
 * happily, and produces an app that dies on launch. `files: ["../dist/**\/*"]`
 * shipped nothing and said nothing — the app.asar contained main.js and
 * package.json, and that was the whole app.
 *
 * These assert the shape that made it work, so a well-meaning edit can't
 * quietly undo it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (p: string): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

describe("packaging · the desktop app", () => {
  const pkg = readJson("desktop/package.json");
  const build = pkg.build as Record<string, any>;

  /**
   * The original bug. electron-builder resolves `files` inside the app
   * directory; a `../` escape matches zero files and never says so.
   */
  it("never tries to reach outside the app dir in files", () => {
    for (const entry of build.files as string[]) {
      expect(entry, `"${entry}" escapes the app dir — it will match nothing`).not.toMatch(/^\.\./);
    }
  });

  it("ships the shell's own files", () => {
    for (const f of ["main.js", "loom-app.js", "preload.cjs"]) {
      expect(build.files).toContain(f);
      expect(fs.existsSync(path.join(root, "desktop", f)), `${f} is listed but absent`).toBe(true);
    }
  });

  /**
   * The daemon must be an unpacked resource, not an asar entry: Node spawns it
   * as a child process, and that child can't read inside an archive.
   */
  it("carries the daemon in as an unpacked resource", () => {
    const res = build.extraResources as Array<{ from: string; to: string }>;
    const daemon = res.find((r) => r.to === "daemon");
    expect(daemon, "no daemon in extraResources — the app would have nothing to run").toBeTruthy();
    expect(daemon?.from).toBe("build/daemon");
  });

  it("stages the daemon before building, every time", () => {
    // `dist` that forgets to stage builds an app around whatever the last stage
    // left behind — or around nothing at all.
    expect(pkg.scripts.dist).toContain("stage");
    expect(pkg.scripts["dist:dir"]).toContain("stage");
    expect(fs.existsSync(path.join(root, "scripts/stage-daemon.mjs"))).toBe(true);
  });

  it("has an icon of its own, and the entitlements its children need", () => {
    expect(fs.existsSync(path.join(root, "desktop/build/icon.png"))).toBe(true);
    expect(build.mac.icon).toBe("build/icon.png");
    // Loom spawns claude/codex/grok and a shell; a hardened app can't without these
    const ent = path.join(root, "desktop", build.mac.entitlements as string);
    expect(fs.existsSync(ent), "hardened runtime with no entitlements: every agent turn dies").toBe(true);
    const xml = fs.readFileSync(ent, "utf8");
    expect(xml).toContain("com.apple.security.cs.allow-jit");
    expect(xml).toContain("com.apple.security.inherit");
  });

  it("doesn't try to publish, which used to fail the build after it succeeded", () => {
    expect(build.publish).toBeNull();
  });
});

describe("packaging · the phone app", () => {
  const app = readJson("app/app.json").expo as Record<string, any>;

  it("has icons that exist on disk", () => {
    const assets = [app.icon, app.splash?.image, app.android?.adaptiveIcon?.foregroundImage];
    for (const a of assets) {
      expect(a, "an asset is unset").toBeTruthy();
      expect(fs.existsSync(path.join(root, "app", String(a).replace(/^\.\//, ""))), `${a} is referenced but missing`).toBe(true);
    }
  });

  /**
   * The phone reaches the daemon at http://100.x.y.z:7420 over the tailnet.
   * iOS blocks cleartext by default, so without this a standalone build gets
   * every request refused — and Android already had its own cleartext opt-in,
   * which is what made the omission easy to miss.
   */
  it("lets iOS talk to your own machine over http", () => {
    const ats = app.ios?.infoPlist?.NSAppTransportSecurity;
    expect(ats, "no ATS exception: every request from a real iOS build is blocked").toBeTruthy();
    expect(ats.NSAllowsArbitraryLoads).toBe(true);
  });

  it("still lets Android do the same", () => {
    const props = (app.plugins as unknown[]).find(
      (p) => Array.isArray(p) && p[0] === "expo-build-properties",
    ) as [string, Record<string, any>];
    expect(props[1].android.usesCleartextTraffic).toBe(true);
  });

  it("can actually be built: eas has the profiles", () => {
    const eas = readJson("app/eas.json");
    for (const profile of ["development", "preview", "production"]) {
      expect(eas.build[profile], `no ${profile} profile`).toBeTruthy();
    }
  });
});
