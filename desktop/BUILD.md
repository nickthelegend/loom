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

**`publish: null`.** Otherwise electron-builder tries to compute update channels
for a repository it has no credentials to publish to and throws `Cannot read
properties of null (reading 'channel')` — *after* writing a perfectly good DMG,
which makes a green artifact look like a failed build.

**The entitlements are load-bearing.** Loom's job is spawning other people's
agents (`claude`, `codex`, `grok`) and a shell for the terminal pane. Under the
hardened runtime, a signed app can't spawn unsigned children or let them inherit
its environment without asking first. Without `build/entitlements.mac.plist`,
the daemon starts and every agent turn dies at launch.

## Signing and notarization

Unsigned by default. electron-builder skips signing when it finds no
`Developer ID Application` identity rather than failing the build, so the DMG is
real but macOS will ask for a right-click → Open on first launch.

To sign and notarize, set these in the environment and rebuild:

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
