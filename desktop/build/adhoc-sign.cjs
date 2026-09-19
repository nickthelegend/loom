/**
 * Ad-hoc sign the macOS app when there's no Developer ID (electron-builder's
 * afterPack hook).
 *
 * Without a signing identity electron-builder skips signing entirely, which
 * leaves only the Electron binary's linker signature: the bundle's own
 * signature is invalid ("code has no resources but signature indicates they
 * must be present") and its identifier reads "Electron". macOS can then call a
 * downloaded copy "damaged" — a dead end right-click → Open doesn't get past.
 *
 * An ad-hoc signature over the whole bundle, with the hardened runtime and our
 * entitlements, makes it a valid, consistently-identified app that Gatekeeper
 * treats as "from an unidentified developer" (right-click → Open once). With a
 * real identity (CSC_LINK / CSC_NAME) this hook steps aside and
 * electron-builder signs and notarizes as usual.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, "entitlements.mac.plist");
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, "--timestamp=none", app],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${path.basename(app)} (no Developer ID configured)`);
};
