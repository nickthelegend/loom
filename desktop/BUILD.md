# Building the desktop app

```sh
npm run build          # in the repo root: compile the daemon first
cd desktop
npm run dist           # stage the daemon, then build installers
npm run dist:dir       # unpacked app only — faster, for checking what shipped
```

`dist` runs `../scripts/stage-daemon.mjs` first. That step is not optional and
not decoration: it is the difference between a DMG and a working DMG.

## Why the config looks like this

electron-builder's config lives in `package.json`, which cannot hold comments —
it validates its schema strictly and rejects unknown keys, `"//note"` included.
So the reasoning lives here.

**`files` only lists the shell.** It used to read
`["main.js", "loom-app.js", "../dist/**/*", "../package.json"]`, which looks
like it ships the daemon. It shipped nothing. electron-builder resolves `files`
relative to the app directory and a `../` escape matches zero files — silently,
with no warning. The DMG built, mounted, installed, and the app died on launch,
because `app.asar` contained exactly `main.js` and `package.json`. An app that
looks finished and isn't is worse than one that obviously isn't.

**The daemon rides in `extraResources`, not `files`.** It has to be a real
directory on disk rather than an entry in an archive: Node spawns
`dist/cli/index.js` as a child process, and that child knows nothing about asar.
Its `node_modules` must be readable the ordinary way too — the daemon serves
`@xterm/*` to the browser straight off disk, because the web app has no build
step and no CDN.

**`publish` names the repository explicitly.** It used to be `null`, because
electron-builder tried to *infer* the channel for a repository it had no
credentials for and threw `Cannot read properties of null (reading 'channel')`
— after writing a perfectly good DMG, which makes a green artifact look like a
failed build. Naming the provider, owner and repo gives it the answer it was
looking for, and `--publish never` still means nothing is uploaded from the
build job. What it buys: electron-builder writes `latest.yml` /
`latest-linux.yml` / `latest-mac.yml` beside the installers, which is the feed
electron-updater reads.

**The feed is published for Windows and the Linux AppImage only.** The release
workflow collects `latest.yml` and `latest-linux.yml` and deliberately leaves
`latest-mac.yml` behind: macOS will only replace an app signed by a certificate
it already trusts, and this build is ad-hoc signed. Advertising an update that
the OS will refuse to install is worse than advertising none.

**What macOS does instead** (`desktop/updater-mac.js`): finds the dmg for the
running architecture, downloads it, and verifies its SHA-256 against the
`SHA256SUMS.txt` the release publishes — deleting the file rather than opening
it if the two disagree — then opens the disk image so you can drag the new app
over the old one. The last step stays yours on purpose. An app *can* replace
its own bundle (it is what Sparkle does outside the App Store), but on an
ad-hoc-signed build that means writing over an installed application and
stepping around the OS's own update path, which is not something to ship
quietly. A Developer ID turns it into the ordinary, supported, one-click
thing — that's still #70.

**The entitlements are load-bearing.** Loom's job is spawning other people's
agents (`claude`, `codex`, `grok`) and a shell for the terminal pane. Under the
hardened runtime, a signed app can't spawn unsigned children or let them inherit
its environment without asking first. Without `build/entitlements.mac.plist`,
the daemon starts and every agent turn dies at launch.

## Signing and notarization

**macOS, without a Developer ID (the default).** `build/adhoc-sign.cjs` runs
after packaging and ad-hoc signs the whole bundle with the hardened runtime and
`build/entitlements.mac.plist`. Without it, electron-builder skips signing and
the app keeps only the Electron binary's linker signature: an invalid bundle
signature, identifier "Electron", and a downloaded copy macOS may call
"damaged". Ad-hoc signed, it verifies (`codesign --verify --deep --strict`),
identifies as `dev.loom.desktop`, and opens with right-click → Open the first
time. With a real identity the hook steps aside.

**Android.** Release APKs are built with `assembleRelease` (which bundles the
JavaScript) and signed with the project's release key (RSA 4096, alias `loom`,
certificate SHA-256
`48:02:6C:20:D9:77:50:02:20:80:A9:D2:C3:3F:3B:B3:FB:4E:C9:FE:E3:B4:B8:16:88:D9:5D:FB:C4:47:DA:B8`).
The key lives in the repo's Actions secrets (`ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`); its master copy is outside
the repo on the maintainer's machine. **Losing it means the next APK can't
update installed ones** — keep a backup in a password manager.

**macOS with a Developer ID.** To sign and notarize for real (no right-click
needed), set these in the environment — locally, or as Actions secrets passed to
the release workflow's desktop job — and rebuild:

```sh
CSC_LINK=/path/to/DeveloperID.p12
CSC_KEY_PASSWORD=…
APPLE_ID=…
APPLE_APP_SPECIFIC_PASSWORD=…
APPLE_TEAM_ID=…
```

Nothing in the repo assumes they exist, and nothing breaks when they don't.

## The Node problem, honestly

The daemon needs Node ≥22.5 for `node:sqlite`. Electron 33 bundles Node 20, so
the packaged app cannot use its own runtime for the daemon — `loom-app.js` looks
for a real `node` (`$LOOM_NODE`, then the usual install paths, then PATH) and
only falls back to Electron-as-Node as a last resort.

That fallback works and quietly degrades: no `node:sqlite` means the JSONL event
store and no history. So **an installed Loom.app on a machine with no Node
installed will run with no history**, which is not a thing a shipped app should
do to someone. Fixing it properly means bundling a Node runtime or moving to an
Electron whose Node is new enough. Neither is done. Until then this is a build
for people who already have Node — which is everyone who has a coding agent
installed, but that is a reason and not an excuse.
