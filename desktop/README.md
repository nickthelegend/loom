# Loom desktop (Electron)

**Download:** the latest macOS (`.dmg`, Apple Silicon and Intel), Windows
(`.exe`) and Linux (`.AppImage`, `.deb`) installers are on the
[Releases page](https://github.com/nickthelegend/loom/releases/latest). They're
unsigned: on macOS, right-click → Open the first time; on Windows, "More info →
Run anyway".

A thin, **first-party** Electron shell around the loom daemon's web app — the same
`/app` surface the phone and browser use, in a native window. It's deliberately *not* an
IDE: no editor, no embedded browser. It's the continuity/memory layer on the desktop.

## Run it

```bash
npm run build          # build the daemon/CLI (from the repo root)
cd desktop
npm install            # pulls Electron
npm start              # opens the Loom window
```

On launch the shell:
1. starts the loom daemon (or reuses a running one — and restarts it if it's serving an
   older build than the one on disk),
2. mints a single-use pairing token via the admin API,
3. loads `…/app#pair=<token>` — the web app pairs itself and persists its client token in
   the Electron partition, so later launches open already-paired.

The daemon is spawned under a **real Node**, not Electron's bundled one: Loom's event log
needs `node:sqlite` (Node ≥ 22.5), and Electron ships an older Node that would silently
degrade the store to JSONL. Set `LOOM_NODE` to pick the runtime explicitly.

## Package installers

```bash
cd desktop
npm run dist           # electron-builder → dmg / nsis / AppImage in dist/
```

Each platform's installer builds on its own OS; the
[release workflow](../.github/workflows/release.yml) does all of them on GitHub's
runners when a `v*` tag is pushed and attaches them to the release. See
[BUILD.md](BUILD.md) for why the config looks the way it does, and for signing
and notarization.

## What's in the window

The same web app as the browser and the phone: the board, threads, the
orchestra (plan mode, permissions, git delivery), the Fleet, and Loom Teams:
teammates' live agents, leases and holds on task cards, the team brain with its
inbox, landing (Land, review, adopt, the doctor, costs), runners (Continue on
runner, Bring back, runner settings and pairing), deploys and release notes.

## How it stays honest

The desktop window is just another **paired client** of the same local daemon — identical
auth, identical API — so everything the CLI/TUI/phone can do, it can do, and nothing new
had to be trusted. The bootstrap lives in `loom-app.js` — plain Node, kept out of Electron
so it can be tested without one ([`test/desktop-app.test.ts`](../test/desktop-app.test.ts)
covers the build-rev fingerprint, the stale-daemon decision, and the pairing handshake
against a fake daemon). `main.js` owns the window, the menu, and one IPC handler: the
native folder picker behind **New project**.

`preload.cjs` exposes exactly that one call (`window.loomNative.pickFolder`) and nothing
else — no `require`, no ipc passthrough — so the page keeps browser privileges even though
it runs in a shell.
