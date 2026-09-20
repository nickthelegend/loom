// Make `npm start` say Loom instead of Electron.
//
// macOS takes the leftmost menu's title — the bold one, with About and Quit —
// from the running bundle's Info.plist, not from `app.setName()`. In a dev run
// the bundle is node_modules/electron/dist/Electron.app, so the menu bar reads
// "Electron" however the app names itself. The packaged build has no such
// problem: electron-builder writes the real name in.
//
// So this stamps the local, disposable Electron.app with the same name the
// packaged app uses, and the dev run looks like the thing it is. It touches
// nothing outside node_modules, it is idempotent, and if it can't do it — a
// different platform, a missing bundle, a read-only install — it says so and
// gets out of the way rather than failing the launch.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
/** What the menu bar should say — the same key the packaged app sets. */
const DISPLAY_NAME = pkg.build?.mac?.extendInfo?.CFBundleDisplayName ?? "Loom";

if (process.platform !== "darwin") process.exit(0);

const plist = path.join(
  here,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist",
);

if (!fs.existsSync(plist)) {
  console.log(`[dev-brand] no Electron.app yet — skipping (the menu will say "Electron")`);
  process.exit(0);
}

try {
  const read = (key) =>
    execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
      encoding: "utf8",
    }).trim();
  if (read("CFBundleDisplayName") === DISPLAY_NAME) process.exit(0); // already done

  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", DISPLAY_NAME, plist]);
  }
  // macOS caches the bundle's name; touching it is what makes the next launch
  // read the plist again rather than the name it remembers.
  fs.utimesSync(path.dirname(path.dirname(plist)), new Date(), new Date());
  console.log(`[dev-brand] this Electron now calls itself "${DISPLAY_NAME}"`);
} catch (err) {
  console.log(`[dev-brand] couldn't rename the dev bundle (${err.message}) — carrying on`);
}
