// Getting the next macOS build, without a certificate we don't have.
//
// electron-updater can't do macOS here: Squirrel.Mac hands the swap to the OS,
// and the OS will only replace a bundle signed by a Developer ID it trusts.
// This build is ad-hoc signed, so until there's a certificate the last step —
// putting the new app where the old one is — stays a thing the person does,
// in the Finder, the way macOS expects.
//
// Everything before that last step is work nobody should have to do by hand,
// and it's what this does:
//
//   1. Read the release and pick the dmg for THIS architecture, so nobody
//      downloads an Intel build onto an Apple Silicon machine.
//   2. Download it, with progress.
//   3. Verify its SHA-256 against the SHA256SUMS.txt the release publishes.
//      No sums file, or no match, and the file is deleted rather than opened.
//   4. Open the verified disk image — the drag-to-Applications window.
//
// Step 3 is the part worth having: the checksums have been published since
// 0.2.0 and approximately nobody checks them by hand. This does, every time,
// and refuses the download it can't verify.
//
// What it deliberately is NOT: an app that replaces its own bundle. That is
// possible — it's what Sparkle does for apps outside the App Store — but on an
// ad-hoc-signed build it means writing over an installed application and
// stepping around the OS's own update path, which is not a thing to ship on
// the quiet. A Developer ID (#70) is what turns that into the ordinary,
// supported, one-click thing, and it is still worth buying.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RELEASES_API = "https://api.github.com/repos/nickthelegend/loom/releases/latest";

/** The newest release, with its assets. */
export async function latestRelease(fetchImpl = fetch) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "loom-desktop-updater" },
  });
  if (!res.ok) throw new Error(`the releases API answered ${res.status}`);
  const body = await res.json();
  if (!body?.tag_name || body.draft) throw new Error("no published release");
  return {
    version: String(body.tag_name).replace(/^v/, ""),
    tag: body.tag_name,
    assets: (body.assets ?? []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

/** The dmg built for this machine, out of a release's assets. */
export function pickAsset(assets, arch) {
  const want = arch === "arm64" ? "arm64" : "x64";
  const dmgs = (assets ?? []).filter((a) => /\.dmg$/i.test(a?.name ?? ""));
  const exact = dmgs.find((a) => a.name.includes(`-${want}.`));
  if (exact) return exact;
  // One dmg with no architecture in its name is a universal build, which is
  // for this machine too. Two that don't say which is which is not a guess
  // worth making on someone's behalf.
  return dmgs.length === 1 ? dmgs[0] : null;
}

/** The checksum a SHA256SUMS.txt lists for one file, or null if it lists none. */
export function expectedSum(sumsText, filename) {
  for (const line of String(sumsText ?? "").split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return null;
}

/** Bytes, the way a download dialog says them. */
export function mb(bytes) {
  return `${(Number(bytes || 0) / 1e6).toFixed(0)} MB`;
}

/**
 * Download the right dmg and prove it's the one the release lists.
 *
 * Returns where the verified file is. A file that fails the check is deleted
 * before this throws: an unverified installer left in Downloads is the thing
 * someone opens later, having forgotten why it's there.
 */
export async function downloadVerified(opts) {
  const { release, arch = process.arch, fetchImpl = fetch, onProgress, dir: into } = opts;
  const asset = pickAsset(release.assets, arch);
  if (!asset) throw new Error(`this release has no ${arch} disk image`);
  const sums = (release.assets ?? []).find((a) => a.name === "SHA256SUMS.txt");
  if (!sums) {
    throw new Error("this release publishes no SHA256SUMS.txt — refusing to hand you a build it can't check");
  }

  const dir = into ?? fs.mkdtempSync(path.join(os.tmpdir(), "loom-update-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);

  const sumsRes = await fetchImpl(sums.url, { headers: { "user-agent": "loom-desktop-updater" } });
  if (!sumsRes.ok) throw new Error(`couldn't read the checksums (${sumsRes.status})`);
  const want = expectedSum(await sumsRes.text(), asset.name);
  if (!want) throw new Error(`SHA256SUMS.txt doesn't list ${asset.name} — refusing to hand it to you`);

  const dl = await fetchImpl(asset.url, { headers: { "user-agent": "loom-desktop-updater" } });
  if (!dl.ok || !dl.body) throw new Error(`the download answered ${dl.status}`);
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of dl.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      got += buf.length;
      if (!out.write(buf)) await new Promise((r) => out.once("drain", r));
      onProgress?.({ got, total: asset.size ?? 0 });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }

  const sha256 = hash.digest("hex");
  if (sha256 !== want) {
    fs.rmSync(file, { force: true });
    throw new Error(
      `the download doesn't match the checksum this release publishes — it was deleted, not opened`,
    );
  }
  return { file, sha256, bytes: got, asset: asset.name, version: release.version };
}
