/**
 * Getting the next macOS build: what gets picked, what gets checked, and what
 * happens to a download that doesn't check out.
 *
 * The verification is the point. Checksums have been published with every
 * release since 0.2.0 and approximately nobody compares them by hand, so the
 * rule these hold is: a file that doesn't match what the release published is
 * deleted, not opened, not kept, and not described as "downloaded".
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain ESM JS, no types; the seam loom-app.js uses too
import { downloadVerified, expectedSum, mb, pickAsset } from "../desktop/updater-mac.js";
// @ts-expect-error — same
import { macAssist } from "../desktop/updater.js";
import { tmpDir } from "./helpers.js";

const ASSETS = [
  { name: "Loom-Desktop-0.2.4-arm64.dmg", url: "https://x/arm64.dmg", size: 124_000_000 },
  { name: "Loom-Desktop-0.2.4-x64.dmg", url: "https://x/x64.dmg", size: 131_000_000 },
  { name: "Loom-Desktop-Setup-0.2.4.exe", url: "https://x/win.exe", size: 90_000_000 },
  { name: "SHA256SUMS.txt", url: "https://x/sums", size: 400 },
];

describe("picking the right build", () => {
  it("picks by architecture, and never by hope", () => {
    expect(pickAsset(ASSETS, "arm64").name).toBe("Loom-Desktop-0.2.4-arm64.dmg");
    expect(pickAsset(ASSETS, "x64").name).toBe("Loom-Desktop-0.2.4-x64.dmg");
    // A release with two dmgs that don't say which is which is not a guess
    // worth making on someone's installed application.
    const vague = [
      { name: "Loom-A.dmg", url: "u" },
      { name: "Loom-B.dmg", url: "u" },
    ];
    expect(pickAsset(vague, "arm64")).toBeNull();
    // One dmg and no architecture in the name is a universal build.
    expect(pickAsset([{ name: "Loom.dmg", url: "u" }], "arm64")?.name).toBe("Loom.dmg");
    expect(pickAsset([{ name: "notes.txt", url: "u" }], "arm64")).toBeNull();
  });

  it("reads a checksum out of the file a release publishes", () => {
    const sha = "a".repeat(64);
    const sums = `${sha}  Loom-Desktop-0.2.4-arm64.dmg\n${"b".repeat(64)}  other.dmg\n`;
    expect(expectedSum(sums, "Loom-Desktop-0.2.4-arm64.dmg")).toBe(sha);
    expect(expectedSum(sums, "not-listed.dmg")).toBeNull();
    expect(expectedSum("", "anything")).toBeNull();
    expect(mb(124_000_000)).toBe("124 MB");
  });
});

/** A fetch that serves a made-up release: the sums file, then the dmg. */
function serving(body: string, sums: string) {
  const bytes = new TextEncoder().encode(body);
  return async (url: string) => {
    if (String(url).includes("sums")) {
      return { ok: true, status: 200, text: async () => sums };
    }
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("downloading it, and checking it", () => {
  const release = { version: "0.2.4", tag: "v0.2.4", assets: ASSETS };

  it("keeps a file whose checksum matches what the release published", async () => {
    const body = "pretend this is a disk image";
    const dir = tmpDir("dl-ok");
    const got = await downloadVerified({
      release,
      arch: "arm64",
      dir,
      fetchImpl: serving(body, `${sha256(body)}  Loom-Desktop-0.2.4-arm64.dmg\n`),
    });
    expect(got.sha256).toBe(sha256(body));
    expect(got.version).toBe("0.2.4");
    expect(fs.readFileSync(got.file, "utf8")).toBe(body);
  });

  it("deletes one whose checksum doesn't, and says nothing was installed", async () => {
    const dir = tmpDir("dl-bad");
    await expect(
      downloadVerified({
        release,
        arch: "arm64",
        dir,
        // the sums file describes a different file than the one served
        fetchImpl: serving("tampered", `${sha256("original")}  Loom-Desktop-0.2.4-arm64.dmg\n`),
      }),
    ).rejects.toThrow(/doesn't match the checksum/);
    expect(fs.existsSync(path.join(dir, "Loom-Desktop-0.2.4-arm64.dmg"))).toBe(false);
  });

  it("refuses a release that publishes no checksums at all", async () => {
    await expect(
      downloadVerified({
        release: { ...release, assets: ASSETS.filter((a) => a.name !== "SHA256SUMS.txt") },
        arch: "arm64",
        dir: tmpDir("dl-nosums"),
        fetchImpl: serving("x", ""),
      }),
    ).rejects.toThrow(/no SHA256SUMS/);
  });

  it("refuses when the checksums don't mention this build", async () => {
    await expect(
      downloadVerified({
        release,
        arch: "arm64",
        dir: tmpDir("dl-unlisted"),
        fetchImpl: serving("x", `${sha256("x")}  some-other-file.dmg\n`),
      }),
    ).rejects.toThrow(/doesn't list/);
  });
});

describe("what the person is told", () => {
  const shown: Array<Record<string, unknown>> = [];
  const say = (responses: number[]) => {
    let i = 0;
    return {
      showMessageBox: async (opts: Record<string, unknown>) => {
        shown.push(opts);
        return { response: responses[i++] ?? 0 };
      },
    };
  };
  const mac = (over: Record<string, unknown> = {}) => ({
    latestRelease: async () => ({ version: "0.2.4", tag: "v0.2.4", assets: ASSETS }),
    pickAsset,
    mb,
    downloadVerified: async () => ({
      file: "/tmp/Loom-Desktop-0.2.4-arm64.dmg",
      sha256: "a".repeat(64),
      bytes: 1,
      asset: "Loom-Desktop-0.2.4-arm64.dmg",
      version: "0.2.4",
    }),
    ...over,
  });

  it("says up to date when it is, and downloads nothing", async () => {
    shown.length = 0;
    let downloads = 0;
    const r = await macAssist({
      version: "0.2.4",
      arch: "arm64",
      dialog: say([0]),
      mac: mac({ downloadVerified: async () => ((downloads++), { file: "", version: "0.2.4" }) }),
    });
    expect(r).toMatchObject({ reason: "current" });
    expect(downloads).toBe(0);
  });

  it("says the drag is yours before it downloads anything", async () => {
    shown.length = 0;
    const r = await macAssist({ version: "0.2.3", arch: "arm64", dialog: say([1]), mac: mac() });
    expect(r).toMatchObject({ reason: "declined" });
    const detail = String(shown[0]!.detail);
    expect(detail).toContain("checksums");
    expect(detail).toMatch(/drag/i); // the honest part, said up front
    expect(detail).toContain("124 MB");
  });

  it("opens the verified image only when asked, and says what it checked", async () => {
    shown.length = 0;
    const opened: string[] = [];
    const r = await macAssist({
      version: "0.2.3",
      arch: "arm64",
      dialog: say([0, 0]), // download, then "Open it"
      mac: mac(),
      openPath: async (f: string) => opened.push(f),
    });
    expect(r).toMatchObject({ staged: true, version: "0.2.4" });
    expect(opened).toEqual(["/tmp/Loom-Desktop-0.2.4-arm64.dmg"]);
    expect(String(shown[1]!.message)).toContain("verified");
    expect(String(shown[1]!.detail)).toContain("SHA-256");
  });

  it("a download that failed its check is an error, not a file to open", async () => {
    shown.length = 0;
    const opened: string[] = [];
    const r = await macAssist({
      version: "0.2.3",
      arch: "arm64",
      dialog: say([0, 0]),
      mac: mac({
        downloadVerified: async () => {
          throw new Error("the download doesn't match the checksum this release publishes");
        },
      }),
      openPath: async (f: string) => opened.push(f),
    });
    expect(r).toMatchObject({ reason: "download-failed" });
    expect(opened).toEqual([]);
    expect(String(shown[1]!.detail)).toContain("checksum");
  });
});
