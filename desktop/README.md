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
1. starts the loom daemon (or reuses a running one),
2. mints a single-use pairing token via the admin API,
3. loads `…/app#pair=<token>` — the web app pairs itself and persists its client token in
   the Electron partition, so later launches open already-paired.

## Package installers

```bash
cd desktop
npm run dist           # electron-builder → dmg / nsis / AppImage in dist/
```

## How it stays honest

The desktop window is just another **paired client** of the same local daemon — identical
auth, identical API — so everything the CLI/TUI/phone can do, it can do, and nothing new
had to be trusted. The bootstrap logic lives in `loom-app.js` (plain Node, unit-tested);
`main.js` only creates the window.
