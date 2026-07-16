# Orchestrator Pad

An open-source desk controller for orchestrating coding agents. Lock a target
agent with one key press, hold the bar to talk, twist the dial to set model
effort — the pad ships the job to your orchestrator over Wi-Fi.

Inspired by the Work Louder x OpenAI pad, but open, printable, and
agent-agnostic: **Codex, Claude, Antigravity, OpenCode, Kiro** each get a
dedicated key, and the whole thing is parametric Python CAD you can remix.

```
[ dial ] [ · ] [ ◦ ] [ ◎ ]     <- effort dial + presets
[  X  ] [ C ] [ A ] [ O ]      <- Codex · Claude · Antigravity · OpenCode
[  K  ] [ ⚡ ] [ ✓ ] [ ✕ ]     <- Kiro · run · approve · reject
[ ⟩_ ] [   🎤 hold   ] [ ➤ ]   <- prompt · voice bar (2u) · send
```

Dial detents map to effort: `low → medium → high → xhigh → max → ultracode`.

## How it works (electronics v0)

- **ESP32-S3 DevKitC-1** — Wi-Fi + native USB. Runs the firmware, exposes the
  pad as a WebSocket client to your orchestrator daemon (and optionally as a
  USB HID macropad fallback).
- **14 MX-style switches**, hand-wired matrix (4x4 grid incl. encoder push).
- **EC11 rotary encoder** — effort dial (M7 bush mounts in the plate).
- **INMP441 I2S microphone** behind the front mic grille — hold the voice bar,
  audio streams to the daemon, the daemon does speech-to-text and dispatches
  the job to the locked agent.
- 4x M3 heat-set inserts + M3x10 button-head screws hold the sandwich together.
- Optional: WS2812 under the three preset keys for agent/status glow.

## Repo layout

```
SPEC.md            the dimensional contract (all mm)
cad/partlib.py     pure-python CAD kernel (numpy + shapely, no CSG)
cad/part_tray.py   bottom shell: ESP32 rails, USB-C slot, mic grille, bosses
cad/part_plate.py  top plate: 14 MX cutouts, knob hole, skirt, screw towers
cad/part_caps.py   13x 1u caps + 2u voice bar, debossed glyphs, MX stems
cad/part_knob.py   knurled dial knob, EC11 D-shaft bore
cad/assembly.py    assembled/exploded GLB + print STLs + manifest
exports/           generated STL / GLB / MANIFEST.json
```

Regenerate everything:

```bash
python -m venv .venv && .venv/bin/pip install numpy shapely
cd cad && ../.venv/bin/python assembly.py
```

## Printing

| Part | File | Notes |
|---|---|---|
| Tray | `exports/tray.stl` | flat on bed, no supports |
| Plate | `exports/plate.stl` | top face down, no supports |
| Keycaps | `exports/caps-all.stl` | as oriented; slow outer walls for crisp glyphs |
| Knob | `exports/knob.stl` | upright |

0.4 mm nozzle, 0.2 mm layers, PETG or PLA. Every part is a union of closed
shells — slicers merge them automatically. If your printer runs tight, scale
holes with the tolerance constants in `SPEC.md` rather than slicer XY-comp.

## Firmware / daemon protocol (next)

The pad speaks a tiny JSON protocol — `{agent, action, effort, audio?}` — to
the agent-lab daemon, which owns speech-to-text, session routing, and the
actual CLI orchestration. Firmware sketch lives in `firmware/` (coming next:
ESP-IDF, hold-to-talk ring buffer, opus-encoded audio frames).

## Status

- [x] v0.1 printable enclosure + caps + knob (this directory)
- [ ] hand-wire guide + firmware
- [ ] PCB with hotswap sockets
- [ ] daemon-side pairing flow

PRs welcome. Measure twice, print once.
