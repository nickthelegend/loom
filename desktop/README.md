# Loom desktop (Electron)

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
