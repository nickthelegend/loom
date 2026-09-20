/**
 * Whether the desktop app may replace itself — and what it says when it can't.
 *
 * Almost all of this feature is the refusal. An auto-updater pointed at a
 * build the OS won't accept fails in ways that look like a corrupt install, so
 * the decision is made from how the app was signed and installed, and it is
 * made before anything is downloaded. The dialogs are the product here: every
 * one of them is a question, and nothing restarts under you.
 */

import { beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain ESM JS, no types; the same seam loom-app.js uses
import { checkForUpdates, isNewer, refusal } from "../desktop/updater.js";

describe("may this copy replace itself", () => {
  it("refuses on macOS, because the build is ad-hoc signed", () => {
    expect(refusal("darwin", true, {})).toMatch(/ad-hoc signed/);
  });

  it("refuses a package-manager install on Linux, and allows an AppImage", () => {
    expect(refusal("linux", true, {})).toMatch(/package manager/);
    expect(refusal("linux", true, { APPIMAGE: "/tmp/Loom.AppImage" })).toBeNull();
  });

  it("allows Windows, and never a development build", () => {
    expect(refusal("win32", true, {})).toBeNull();
    expect(refusal("win32", false, {})).toMatch(/development build/);
  });

  it("compares versions the way a release does", () => {
    expect(isNewer("0.2.4", "0.2.3")).toBe(true);
    expect(isNewer("0.3.0", "0.2.9")).toBe(true);
    expect(isNewer("0.2.3", "0.2.3")).toBe(false);
    expect(isNewer("0.2.2", "0.2.3")).toBe(false);
    expect(isNewer("rubbish", "0.2.3")).toBe(false); // unknown means "no update"
  });
});

describe("what it does about it", () => {
  let shown: Array<Record<string, unknown>>;
  let opened: number;
  const say = (responses: number[]) => {
    let i = 0;
    return {
      showMessageBox: async (opts: Record<string, unknown>) => {
        shown.push(opts);
        return { response: responses[i++] ?? 1 };
      },
    };
  };

  beforeEach(() => {
    shown = [];
    opened = 0;
  });

  it("when it can't update, it offers the releases page and says why", async () => {
    const r = await checkForUpdates({
      refusal: "the macOS build is ad-hoc signed",
      version: "0.2.3",
      dialog: say([0]),
      openReleases: () => opened++,
    });
    expect(r).toMatchObject({ updated: false });
    expect(String(shown[0]!.detail)).toContain("ad-hoc signed");
    expect(opened).toBe(1);
  });

  it("says so plainly when there's nothing newer", async () => {
    const r = await checkForUpdates({
      refusal: null,
      version: "0.2.3",
      dialog: say([0]),
      autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: "0.2.3" } }) },
    });
    expect(r).toMatchObject({ updated: false, reason: "current" });
    expect(String(shown[0]!.message)).toContain("up to date");
  });

  it("downloads nothing until you say so", async () => {
    let downloaded = 0;
    const r = await checkForUpdates({
      refusal: null,
      version: "0.2.3",
      dialog: say([1]), // "Not now"
      autoUpdater: {
        checkForUpdates: async () => ({ updateInfo: { version: "0.2.4" } }),
        downloadUpdate: async () => downloaded++,
      },
    });
    expect(downloaded).toBe(0);
    expect(r).toMatchObject({ reason: "declined" });
  });

  it("installs on quit, and restarts only when you press restart", async () => {
    let quit = 0;
    const r = await checkForUpdates({
      refusal: null,
      version: "0.2.3",
      dialog: say([0, 1]), // download, then "Later"
      autoUpdater: {
        checkForUpdates: async () => ({ updateInfo: { version: "0.2.4" } }),
        downloadUpdate: async () => {},
      },
      quitAndInstall: () => quit++,
    });
    expect(r).toMatchObject({ updated: true, version: "0.2.4" });
    expect(quit).toBe(0); // "Later" means later
    expect(String(shown[1]!.detail)).toContain("not interrupted");

    shown = [];
    await checkForUpdates({
      refusal: null,
      version: "0.2.3",
      dialog: say([0, 0]), // download, then "Restart now"
      autoUpdater: {
        checkForUpdates: async () => ({ updateInfo: { version: "0.2.4" } }),
        downloadUpdate: async () => {},
      },
      quitAndInstall: () => quit++,
    });
    expect(quit).toBe(1);
  });

  it("an unreachable feed is a sentence, not a stack trace", async () => {
    const r = await checkForUpdates({
      refusal: null,
      version: "0.2.3",
      dialog: say([1]),
      autoUpdater: {
        checkForUpdates: async () => {
          throw new Error("getaddrinfo ENOTFOUND github.com");
        },
      },
    });
    expect(r).toMatchObject({ reason: "unreachable" });
    expect(String(shown[0]!.detail)).toContain("ENOTFOUND");
  });
});
