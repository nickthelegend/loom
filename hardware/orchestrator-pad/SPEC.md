# Orchestrator Pad — dimensional spec (v0.1)

Open-source ESP32 macropad for orchestrating coding agents: lock a target agent
(Codex / Claude / Antigravity / OpenCode / Kiro), hold-to-talk voice capture,
and a dial that sets model effort (`low → medium → high → xhigh → max → ultracode`).

All dimensions in **mm**. Axes: X right, Y back (away from user), Z up.
Origin: center of the case footprint, Z=0 at the tray's outer bottom face.

## Layout (19.05 mm grid, 4 columns x 4 rows)

Column centers X: -28.575, -9.525, +9.525, +28.575 (cols 0..3)
Row centers Y: +28.575, +9.525, -9.525, -28.575 (rows 0..3, row 0 = back/top)

| Pos | What | Glyph (debossed) |
|---|---|---|
| r0c0 | EC11 rotary encoder (effort dial) | knurled knob, tick dot |
| r0c1..c3 | preset/status keys (translucent look) | `dot`, `ring`, `target` |
| r1c0..c3 | agent keys: Codex, Claude, Antigravity, OpenCode | `X`, `C`, `A`, `O` |
| r2c0 | agent key: Kiro | `K` |
| r2c1..c3 | run / approve / reject | `bolt`, `check`, `cross` |
| r3c0 | prompt/terminal key | `prompt` |
| r3 c1–c2 | **voice bar, 2u** (hold-to-talk), centered at X=0 | `mic` |
| r3c3 | send/dispatch key | `send` |

Total: **14 MX switches** (13 x 1u + 1 x 2u), 1 EC11 encoder.

## Case (two printed shells + knob + caps)

### Tray (bottom shell) — `part_tray.py`
- Outer: 90.0 x 90.0, corner R8, height **14.0**. Wall 2.4, floor 2.4.
- Ledge for the top's skirt: below Z=7.5 wall is 2.4 thick; above Z=7.5 the
  inner face steps out so wall is **1.2** thick (skirt seat).
- 4 corner bosses Ø7.0 at (±39, ±39), from floor top (Z2.4) to **Z=11.5**,
  bore Ø4.0 x 6.0 deep (M3 heat-set insert).
- USB-C slot, back wall (Y=+45), centered **X=+7.79**: **10.5 wide x 4.5 tall**,
  Z from 6.4 to 10.9. (Espressif's DevKitC-1 V1.1 drawing puts both USB ports
  ±7.79 off the board centerline — the slot is centered on the **native/OTG
  port** at +7.79 with the board centered by the rails.)
- ESP32-S3 DevKitC rails: two ridges 2.0 wide x 3.0 tall x 40 long, inner
  faces 26.0 apart, centered X=0, board along Y, USB end toward back wall.
  Lateral guides only — the 25.4-wide board drops between them.
- Board support pads: 2 x **18.0 x 6.0** (|x| ≤ 9.0, Y 2..8 and Y 24..30),
  floor top (Z2.4) to **Z=5.4** — seat the PCB bottom at rail-top height so
  the USB centerline lands at Z 8.63, centered in the slot. Pads sit under
  the board's bare center strip, clear of the header rows (|x| ≥ 10.16).
- Mic holes: front wall (Y=-45), 3 x Ø1.5, spacing 3.0, centered Z=8.
- Reset pinhole: right wall (X=+45), Ø1.5 at Y=+20, Z=8.
- Feet recesses: bottom face, 4 x Ø9.0 x 0.6 deep at (±36, ±36).

### Top plate — `part_plate.py`
- Plate: 90.0 x 90.0, R8, **1.5 thick**, spans Z 14.0 → 15.5.
- 14 MX cutouts **14.1 x 14.1** (14.0 nominal + 0.1 print tolerance) at the
  grid positions above (2u voice = one switch centered at X=0, r3).
- Knob hole Ø**7.4** at r0c0 (EC11 M7 threaded bush).
- Skirt: ring 1.15 thick x 6.5 deep (Z 7.5 → 14.0), outer profile =
  86.5 x 86.5 R6.5 x-y (drops inside the tray's upper 1.2 wall with ~0.15
  clearance per side). Notched so the case closes and USB mates: **Ø8.6
  corner clearances** at (±39, ±39) around the tray bosses (which rise to
  Z 11.5, through the skirt band), plus a **14.0-wide notch** (Y 41..44)
  centered X=+7.79 over the USB slot.
- 4 screw towers Ø7.6 from Z 11.5 → 14.0 at (±39, ±39), through-hole Ø3.4
  continuing through the plate, counterbore Ø6.4 x 0.8 from the top face
  (M3 x 8 button-head into the tray inserts).

### Keycaps — `part_caps.py`
- 1u: base 18.2 x 18.2 R2.5, top 16.4 x 16.4 R2.2, height **7.5** (loft taper),
  wall 1.6, hollow underneath.
- 2u voice bar: base 37.25 x 18.2, top 35.4 x 16.4, same height/wall.
- MX stem: post Ø5.8, length 3.9 below the cap ceiling; cross slots
  4.15 x 1.35, depth 3.9 (friction fit on MX stem).
- Glyphs debossed **0.6** into the top: build the top 0.8 mm of the cap as a
  layer with glyph-shaped holes; solid body below ends 0.6 lower, glyph
  islands (e.g. center of `O`) overlap 0.2 into the body below so every
  shell fuses when sliced.

### Knob — `part_knob.py`
- Ø17.0, height 15.0. Knurl: 24 flutes (Ø1.6 scallops on the rim).
- Top: 1.5 chamfer loft to Ø16.0, tick-dot deboss near edge.
- Bore: EC11 D-shaft — Ø6.1 with flat at 4.6, blind, 12.0 deep (3.0 ceiling).

## Assembly (`assembly.py`)
- Tray at Z0 → plate on top (plate top face Z=15.5).
- Caps: bottom face at **Z=21.0** (switch seated, cap floats ~5.5 over plate).
- Knob: bottom at **Z=16.5** over r0c0.
- Exports: `exports/orchestrator-pad-assembled.glb`, `exports/orchestrator-pad-exploded.glb`
  (tray +0 / plate +20 / caps +40 / knob +48), plus one STL per printable part.

## Colors (GLB preview only)
tray `#AEB4BC`, plate `#F4F5F7`, preset caps `#D8DCE2`, Codex `#1A1A1A`,
Claude `#D97757`, Antigravity `#2D6BFF`, OpenCode `#19B36B`, Kiro `#7A3FF2`,
run/approve/reject/prompt/send `#FFFFFF`, voice bar `#FFFFFF`, knob `#E8E9EB`.

## BOM (v0)
ESP32-S3 DevKitC-1 **without factory pin headers** (or clip the pins flush —
the tray has no clearance for ~8.5 mm underside pins; the board seats on the
support pads), EC11 encoder (M7 bush) + this knob, 14 x MX-style switches,
INMP441 I2S mic, 4 x M3 heat-set inserts + **M3x8** button-head screws
(an M3x10 bottoms out in the Ø4.0 x 6.0 boss bore 0.8 before the head
clamps — head bears at Z 14.7 under the counterbore), 4 x rubber feet Ø8.
Optional: WS2812 under the preset keys.

## Print notes
0.4 nozzle, 0.2 layers, PETG or PLA. Tray + plate flat side down, no supports.
Caps upside down (top face on bed) or with tree supports; knob upright.
Every part = union of closed shells; slicers merge coplanar/overlapping shells.
