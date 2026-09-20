// Replacing the app with a newer one — where that can honestly be done.
//
// electron-updater swaps the installed application in place. Whether that is
// safe is a property of how the app was signed and how it was installed, not
// of the code, so this decides first and acts second:
//
//   Linux .deb   — refused. The package manager owns those files.
//   Linux AppImage / Windows — electron-updater, against the feed
//                  electron-builder publishes: a single artifact the app may
//                  replace.
//   macOS        — not electron-updater. Squirrel.Mac will only replace a
//                  bundle signed by a Developer ID the OS trusts, and this
//                  build is ad-hoc signed. It does the part that can be
//                  automated instead — find the right dmg, download it, and
//                  VERIFY it against the release's published checksums — and
//                  leaves the drag to Applications to you. See updater-mac.js
//                  for why the last step is deliberately still yours.
//
// Nothing downloads without being asked, and nothing restarts under you: the
// install happens on quit, and "Restart now" is a button you press.

// electron is imported lazily, not at the top: everything that decides
// anything here is plain JavaScript, and a test that wants to check the
// decisions shouldn't have to install Electron to do it.
const electron = () => import("electron");

const RELEASES = "https://github.com/nickthelegend/loom/releases/latest";

/**
 * Why this copy can't replace itself, or null when it can.
 *
 * macOS answers "can't" too — its build is ad-hoc signed, and the OS won't
 * swap one of those — but it has somewhere better to go than the releases
 * page, so `macAssist` handles it rather than this.
 */
export function refusal(platform, packaged, env = process.env) {
  if (!packaged) return "this is a development build — run it from the checkout instead";
  if (platform === "darwin") {
    return "the macOS build is ad-hoc signed, and macOS will only replace an app signed by a certificate it already trusts";
  }
  if (platform === "linux" && !env.APPIMAGE) {
    return "this copy was installed by a package manager, which owns these files — update it the way you installed it";
  }
  if (platform !== "linux" && platform !== "win32") return `${platform} builds don't self-update`;
  return null;
}

/** Open the release page — the fallback, and never a silent one. */
async function openReleases() {
  const { shell } = await electron();
  void shell.openExternal(RELEASES);
}

/**
 * macOS: find it, fetch it, check it, hand it over.
 *
 * The swap itself stays a drag, because this build is ad-hoc signed — see
 * updater-mac.js. Everything before it is automated, and the checksum is
 * actually verified, which is more than a person downloading the dmg by hand
 * realistically does.
 */
export async function macAssist(opts = {}) {
  const say = opts.dialog ?? (await electron()).dialog;
  const version = opts.version ?? (await electron()).app.getVersion();
  const mac = opts.mac ?? (await import("./updater-mac.js"));

  let release;
  try {
    release = await mac.latestRelease();
  } catch (err) {
    await say.showMessageBox({
      type: "info",
      message: `Loom Desktop ${version}`,
      detail: `Couldn't reach the releases (${String(err?.message ?? err)}).`,
      buttons: ["Open Releases", "Close"],
      defaultId: 1,
      cancelId: 1,
    });
    return { updated: false, reason: "unreachable" };
  }

  if (!isNewer(release.version, version)) {
    await say.showMessageBox({
      type: "info",
      message: `Loom Desktop ${version} is up to date`,
      buttons: ["Close"],
    });
    return { updated: false, reason: "current" };
  }

  const asset = mac.pickAsset(release.assets, opts.arch ?? process.arch);
  const ask = await say.showMessageBox({
    type: "question",
    message: `Loom Desktop ${release.version} is available`,
    detail: `Loom will download the ${opts.arch ?? process.arch} build${asset?.size ? ` (${mac.mb(asset.size)})` : ""} and check it against the checksums this release publishes. macOS won't let an app that isn't signed by a certificate it trusts replace itself, so the last step is yours: drag the new Loom Desktop over the old one.`,
    buttons: ["Download", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (ask.response !== 0) return { updated: false, reason: "declined" };

  let got;
  try {
    got = await mac.downloadVerified({
      release,
      ...(opts.arch ? { arch: opts.arch } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  } catch (err) {
    await say.showMessageBox({
      type: "error",
      message: "That download wasn't usable",
      detail: String(err?.message ?? err),
      buttons: ["Open Releases", "Close"],
      defaultId: 1,
      cancelId: 1,
    });
    return { updated: false, reason: "download-failed" };
  }

  const then = await say.showMessageBox({
    type: "info",
    message: `Loom Desktop ${got.version} is downloaded and verified`,
    detail: `Its SHA-256 matches the one this release publishes.\n\nOpening it mounts the disk image: drag Loom Desktop onto Applications, replacing the old one, then quit this copy and open the new one.\n\n${got.file}`,
    buttons: ["Open it", "Show in Finder", "Later"],
    defaultId: 0,
    cancelId: 2,
  });
  if (then.response === 0) await (opts.openPath ?? (async (f) => (await electron()).shell.openPath(f)))(got.file);
  if (then.response === 1) await (opts.showItem ?? (async (f) => (await electron()).shell.showItemInFolder(f)))(got.file);
  return { updated: false, staged: true, version: got.version, file: got.file, sha256: got.sha256 };
}

/**
 * Check, ask, download, and offer to restart. Every step is a question.
 *
 * `deps` is injectable so the decisions above can be tested without an
 * installed application or a network.
 */
export async function checkForUpdates(opts = {}) {
  const say = opts.dialog ?? (await electron()).dialog;
  const version = opts.version ?? (await electron()).app.getVersion();
  const platform = opts.platform ?? process.platform;
  let why = opts.refusal;
  if (why === undefined) {
    // Asking Electron is deferred until something actually needs the answer:
    // a caller that states its own refusal is testing a branch, not asking to
    // be told what it's running inside.
    const packaged = opts.packaged ?? (await electron()).app.isPackaged;
    // macOS can't swap itself, but it doesn't have to be sent to a web page
    // either.
    if (platform === "darwin" && packaged) return macAssist(opts);
    why = refusal(platform, packaged);
  }

  if (why) {
    const r = await say.showMessageBox({
      type: "info",
      message: `Loom Desktop ${version}`,
      detail: `This copy can't replace itself: ${why}.\n\nThe releases page has the current build.`,
      buttons: ["Open Releases", "Close"],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) void (opts.openReleases ?? openReleases)();
    return { updated: false, reason: why };
  }

  const updater = opts.autoUpdater ?? (await import("electron-updater")).autoUpdater;
  updater.autoDownload = false; // asking is the whole point
  updater.autoInstallOnAppQuit = true;

  let found;
  try {
    const result = await updater.checkForUpdates();
    found = result?.updateInfo ?? null;
  } catch (err) {
    // No feed, no network, a rate limit: not an error worth a stack trace.
    await say.showMessageBox({
      type: "info",
      message: `Loom Desktop ${version}`,
      detail: `Couldn't reach the update feed (${String(err?.message ?? err)}).`,
      buttons: ["Open Releases", "Close"],
      defaultId: 1,
      cancelId: 1,
    });
    return { updated: false, reason: "unreachable" };
  }

  if (!found || !isNewer(found.version, version)) {
    await say.showMessageBox({
      type: "info",
      message: `Loom Desktop ${version} is up to date`,
      buttons: ["Close"],
    });
    return { updated: false, reason: "current" };
  }

  const ask = await say.showMessageBox({
    type: "question",
    message: `Loom Desktop ${found.version} is available`,
    detail: "It downloads in the background and installs when you quit. Nothing restarts on its own.",
    buttons: ["Download", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (ask.response !== 0) return { updated: false, reason: "declined" };

  try {
    await updater.downloadUpdate();
  } catch (err) {
    await say.showMessageBox({
      type: "error",
      message: "The download didn't finish",
      detail: String(err?.message ?? err),
      buttons: ["Open Releases", "Close"],
      defaultId: 0,
      cancelId: 1,
    });
    void (opts.openReleases ?? openReleases)();
    return { updated: false, reason: "download-failed" };
  }

  const then = await say.showMessageBox({
    type: "info",
    message: `Loom Desktop ${found.version} is ready`,
    detail: "It will be installed when you quit. You can restart now, or keep working — an agent's turn is not interrupted either way.",
    buttons: ["Restart now", "Later"],
    defaultId: 1,
    cancelId: 1,
  });
  if (then.response === 0) (opts.quitAndInstall ?? (() => updater.quitAndInstall()))();
  return { updated: true, version: found.version };
}

/** Enough semver for "is the release newer than what's running". */
export function isNewer(a, b) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  }
  return false;
}
