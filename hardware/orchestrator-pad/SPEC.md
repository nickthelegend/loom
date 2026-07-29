# Orchestrator Pad — dimensional spec (v7)

Open-source ESP32 macropad for orchestrating coding agents: lock a target agent
(Grok / Codex / Claude Code / Antigravity / opencode / Kiro / Cursor),
hold-to-talk voice capture, and a dial that sets model effort
(`low → medium → high → xhigh → max → ultracode`).

All dimensions in **mm**. Axes: X right, Y back (away from user), Z up.
Origin: center of the case footprint, Z=0 at the tray's outer bottom face.

## Layout (19.05 mm grid, 4 columns x 4 rows)

Column centers X: -28.575, -9.525, +9.525, +28.575 (cols 0..3)
Row centers Y: +28.575, +9.525, -9.525, -28.575 (rows 0..3, row 0 = back/top)

| Pos | What | Glyph (debossed) |
|---|---|---|
| r0c0 | EC11 rotary encoder (effort dial) | knurled knob, tick dot |
| r0c1 | agent key: Cursor | `cursor` (cube, raised facet) |
| r0c2 | agent key: Codex | `codex` (cloud, raised `>_`) |
| r0c3 | preset/status key (translucent look) | `target` |
| r1c0..c3 | agent keys: Grok, Claude Code, Antigravity, opencode | `grok` (circle-slash), `claude` (pixel-pal), `antigravity` (arch), `opencode` (frame) |
| r2c0 | agent key: Kiro | `kiro` (ghost) |
| r2c1..c3 | run / approve / reject | `bolt`, `check`, `cross` |
| r3c0 | prompt/terminal key | `prompt` |
| r3 c1–c2 | **voice bar, 2u** (hold-to-talk), centered at X=0 | `mic` |
| r3c3 | send/dispatch key | `send` |

Total: **14 MX switches** (13 x 1u + 1 x 2u), 1 EC11 encoder.

## Case (two printed shells + knob + caps)

### Tray (bottom shell) — `part_tray.py`
- Outer: 90.0 x 90.0, corner R8, height **40.0** (v7 fat/tall base — +12 over
  v6's 28.0, for lots of open headroom above the board; the interior is a
  component bay). Wall 2.4, floor 2.4.
- Ledge for the top's skirt: below Z=33.5 wall is 2.4 thick; above Z=33.5 the
  inner face steps out so wall is **1.2** thick (skirt seat).
- 4 corner bosses Ø7.0 at (±39, ±39) — **round** (M3 heat-set inserts thread
  in): solid pedestal from floor top (Z2.4) to **Z=31.5**, insert ring
  Ø7.0/Ø4.0 to **Z=37.5** (bore 6.0 deep from the top, floor at Z 31.5 — M3
  heat-set insert). The bosses now run floor→37.5 (through the raised ledge).
- **USB windows**, BOTH side walls (X=+45 and X=-45): each **26.0 wide** in
  Y centered Y=0, **Z 17.0..23.5**, through BOTH wall columns. The board
  turns 90° so its ports face a side wall, and the bay is **reversible** —
  the board installs **ports-right or ports-left**, and the *unused* window
  is documented as a **wire pass-through** (run the speaker/mic/amp harness
  or a USB extension out of it). The board's dual side-by-side USB-C ports
  sit on its TOP face (shells 8.94 x 3.3 → Z 17.6..20.9, center 19.25) and
  exit through whichever window they face; each window is wide + tall enough
  that exact port offsets don't matter (shells stay inside for port centers
  |y| ≤ 8.53, a 12-wide plug hood for |y| ≤ 7.0), and the receptacle face
  sits only ~1.7 behind the outer wall — under the ~2.5 of exposed plug
  shroud, so any hood works at the aperture mouth. v7 raised the ledge to
  33.5, so each window top (23.5) now sits **entirely below the ledge** —
  both wall columns close the window with a solid cap at 23.5 and run solid
  to their tops (liner→33.5, outer→40.0), and the **plate skirt no longer
  needs a USB notch**. The two side cuts split each cut wall band into a back
  arc and a front arc — every piece is still its own watertight prism, fused
  to the solid ring bands above and below by the 0.2 lap.
- **Board bay (rotated + REVERSIBLE)** — dual-USB-C ESP32-S3 clone,
  components UP, factory header pins DOWN, laid **along X**: up to **64.0
  long (X) x 30.0 wide (Y)**, centered Y=0 (|y| ≤ 15). Two installs, both
  seating identically because every bay feature is mirror-symmetric about
  X=0:
  - **ports-right** X **-22.0 … +42.0** (USB-C exits the X=+45 window)
  - **ports-left**  X **-42.0 … +22.0** (USB-C exits the X=-45 window)
  - side shelves (BOTH walls): tabs protruding 1.6 from each side wall's
    inner face (42.6), spanning **|x| 41.0..42.8** (0.2 lap into the liner)
    and **|y| ≤ 14.0**, body Z 13.5..16.0 — the board's port edge seats on
    one and its far edge overhangs the other; **Z=16.0** top faces (1.0
    bearing, 0.6 edge-to-wall gap on the port side).
  - mid-span ribs: two walls at **X +4.0..+7.0** and **X -7.0..-4.0**,
    **Y +1.0..+16.0**, floor to **Z=16.0** — they carry the board's middle
    (~112 mm² of total seat bearing per orientation). They stay at Y ≥ +1.0
    on purpose: the speaker flange occupies X ±36, Y -42..0, and a rib
    crossing it would foul the flange (1.0 clear as drawn).
  - **board cage (FLAT — NO cylindrical posts, v7)**: the board is caged in
    Y by flat guide walls only, placed only in speaker-clear zones (the
    flange is X ±36, Y -42..0; supports live at Y>0 or |X|>36). Inner faces
    at |y| = 15.1 → 0.1 clearance per side to a 30-wide board, tops **Z=19.0**
    (1.4 lip over the board top at 17.6). Mirror-symmetric about X=0:
    - **back guide rail**: a flat wall, inner face **Y=+15.1**, outer
      **Y=+17.1** (2.0 thick), spanning **X -10.0..+10.0**, floor→Z=19.0 —
      caps the board's +Y edge. (Nominal span was X ±34, but the amp
      L-ridges reach X 10.5 inside the rail's Y band 15.1..17.1, so the rail
      is trimmed to **±10.0** to clear the amp by 0.5 while staying
      symmetric and watertight; it fuses with the two mid-span ribs at
      Y 15.1..16 by design, tying it to the load-bearing ribs.)
    - **front corner tabs**: two flat tabs, inner face **Y=-15.1**, outer
      **Y=-17.1**, spanning **X 36.8..40.0** and **X -40.0..-36.8** (both at
      |X|>36, clear of the flange edge at 36 by 0.8), floor→Z=19.0 — they
      guide the board's front-edge corners in whichever orientation reaches
      that side.
    Together with the flat mid-span ribs and dual side shelves (all
    retained, unchanged), the board is caged in Y from both edges while
    nothing ever crosses the speaker flange.
  - under-board clearance floor→16.0 = **13.6 mm** for the soldered header
    pins (~8.5 under the PCB) + angled dupont connectors. Headers now run
    along the board's long edges (y = ±15). Wire in the open pockets either
    side of the ribs. Pin tails that land over a rib (X ±4..7, Y +1..+16)
    must be clipped flush; over the speaker zone (Y < 0) the driver bump can
    rise to Z 14.9 under the pin rows — clip there too, or verify your
    speaker's bump footprint. (Headers usually stop ~2 mm short of the
    board ends, clearing the 1.0 shelf lip.)
- **Speaker bay** (down-firing, flange ON the floor, centered (0, -21)):
  - floor opening: racetrack (rounded-rect R12) **54 x 24** at (0, -21) with
    two 2.0-wide grille bars along X → 3 slots (~6.7 each), through both
    floor layers.
  - 4 screw pilots Ø2.4 THROUGH the floor at (±31.5, -37.5) and
    (±31.5, -4.5) — the 63 x 33 pattern. M2.5 x 6 self-tappers from inside:
    heads on the flange, tips end 2.1 under the floor, inside the ≥3 mm
    foot gap. The two back pilots' bottom rims merge ~1.0 into the front
    feet-recess rims (0.6 recess layer only) — stick those feet biased
    outward.
  - fits flanges up to **72 x 42** (a sharp-cornered 72 x 42 grazes the two
    front bosses by ~0.5; real cavity flanges with corner R ≥ 6.5 clear —
    **measure yours**) and driver bumps up to **Ø50 x 11 tall** (oval, ≤
    50 x 40 in plan): bump top 2.4 + 1.5 + 11 = **14.9** clears the board
    underside at 16.0 by 1.1. **Measure the bump height — the bay assumes
    ≤ 11.**
- **Amp pocket**: four L-corner ridges (1.5 wide, 2.0 tall, 6-long legs)
  framing a 20 x 20 pocket centered **(+22, +27)** — the MAX98357A drops in,
  foam-tape mounted. It sits on the back strip, out from under the rotated
  board: the ridges span X 10.5..33.5, Y 15.5..38.5, so the outer edge clears
  the board edge at Y 15.0 by **0.5** (both orientations), the corner bosses'
  inner face at X 35.5 by **2.0**, and the speaker by 15.5. v7 deleted the
  locator posts, so the pocket is now a **clean, full 20 x 20** (the old
  (+20, +17.6) post no longer clips its south edge); an ~18 x 16 breakout
  drops in with ~1.0/side play. The nearest cage wall is the back rail,
  trimmed to ±10 so it clears the amp by 0.5.
- **Wire bar** (FLAT — replaces the v6 wire posts, NO cylinders): a low flat
  wall along the west interior, inner face **X=-36.0**, outer **X=-38.0**
  (2.0 thick), spanning **Y +6.0..+30.0**, floor→**Z=8.0**, with **two
  3.2-wide x 2.0-tall through-slots** (band-split in Z, at Z 3.0..5.0)
  centered **Y=+12** and **Y=+24**. A zip tie threads a slot and cinches the
  harness against the bar. It tops out at Z 8.0 — well below the left USB
  window (Z 17.0) — and Y 6..30 clears the speaker flange (Y≤0) by 6.0 and
  the (-39, +39) corner boss by 5.5. It underlies the ports-left board
  footprint in plan but sits 8.0 below the board underside (16.0), so it
  never obstructs board seating in either orientation.
- **Mic grille**, front wall (Y=-45): 3 x 1.5 square ports, spacing 3.0,
  centered X=-20, **Z 19.4..20.9** — far below the raised 33.5 ledge; the round
  I2S mic module glues behind them, above the speaker body. (Replaces v3's
  low-Z round ports.)
- Feet recesses: bottom face, 4 x Ø9.0 x 0.6 deep at (±36, ±36). Use
  **≥3 mm tall feet** so the down-firing speaker breathes (and the M2.5
  tips stay 0.3 off the desk).

### Top plate — `part_plate.py`
- Plate: 90.0 x 90.0, R8, **1.5 thick**, spans Z 40.0 → 41.5 (counterbore
  bands 40.0..40.7 + 40.5..41.5; case stack ~41.5 mm + caps/knob).
- 14 MX cutouts **14.1 x 14.1** (14.0 nominal + 0.1 print tolerance) at the
  grid positions above (2u voice = one switch centered at X=0, r3). These
  are exactly donor-keyboard-style plate holes — harvested 3-pin white MX
  clones clip straight into the 1.5 plate.
- **Switch sockets + deck (v5.1, donor-board style, print-clean)**: under
  every cutout a pocket box cages the switch body — walls 1.6 (outer 17.3
  sq) from **Z 36.5** (the MX base-seat plane, plate top − 5.0) up 0.2 into
  the plate. Flipped for printing, the plate is pure vertical walls: no
  bridges, no floating regions, no supports. The footprint floor is the
  separate **switch deck**: a 1.2-thick flat sheet (78 × 78 R6, Z
  35.3..36.5) carrying all 14 MX clusters — center post Ø**4.15** (snug on
  the Ø4.0 post), contact pin holes Ø**2.0** at (−3.81, +2.54) and
  (+2.54, +5.08), 5-pin leg holes Ø**1.85** (snug on Ø1.7) at (±5.08, 0);
  offsets from each key center, +Y toward the back. It prints FLAT
  (perfect holes), presses onto the switch posts/legs from below
  (friction-fit), seats against the socket-wall rims, has a 16 sq cutout
  under the EC11 body and Ø8.8 notches at the four screw towers (≥0.15,
  audited). The metal pins protrude **2.1** below the deck (tips Z 33.2):
  solder the matrix wires directly to them, PCB-style.
- Knob hole Ø**7.4** at r0c0 (EC11 M7 threaded bush).
- Skirt: ring 1.15 thick x 6.7 deep (Z 33.5 → 40.2), outer profile =
  87.3 x 87.3 R6.9 x-y, inner 85.0 x 85.0 R6.3 (drops inside the tray's
  87.6 upper 1.2 wall with ~0.15 clearance per side). Notched ONLY for the
  bosses now: **Ø8.6 corner clearances** at (±39, ±39) around the tray
  bosses (which rise to Z 37.5, through the skirt band). v7 raised the ledge
  to 33.5 while the USB windows still top out at 23.5 — the **side windows
  sit entirely below the ledge**, no longer cross into the skirt seat, so the
  **v6 side USB notches are gone**. The ring survives as **4 arc segments**
  (one per edge, severed at the 4 corner notches), each a watertight prism
  fused to plate band A. (The front mic notch is likewise unneeded: the mic
  grille at Z 19.4..20.9 sits far below the ledge.)
- 4 screw towers Ø7.6 from Z 37.5 → 40.2 at (±39, ±39), through-hole Ø3.4
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
  islands (e.g. the pixel-pal's eyes) overlap 0.2 into the body below so every
  shell fuses when sliced.
- **Legend infills**: each glyph also exports as a separate flush 0.6 prism
  (`<id>-legend` items, merged into `exports/legends-all.stl`, same drop as
  `caps-all.stl` so both stay aligned). Print caps + legends together in two
  colors (AMS/MMU, or a manual filament swap on the last 3 layers when caps
  print top-face-down), or skip the file and paint-fill the recesses. Legend
  colors per key live in `partlib.key_layout()` (white on colored caps, dark
  gray on white caps).

### Knob — `part_knob.py` (v7.1 MOCK, no potentiometer)
- Ø17.0, height 15.0. Knurl: 24 flutes (Ø1.6 scallops on the rim).
- Top: 1.5 chamfer loft to Ø16.0, tick-dot deboss near edge.
- **Snap-fit peg** on the underside — no EC11 shaft: a Ø**7.2** tube split by
  1.2-wide cross-slots into 4 flex fingers, hollow Ø4.6 core, with a Ø**8.2**
  barb at the tip and a stepped lead-in chamfer. Push it through the plate's
  Ø7.4 hole: the fingers compress, the barb springs out under the plate. The
  knob body rests on the plate top (Z 41.5) and the barb catches the
  underside (ledge Z 39.8, **0.2 axial play** below the plate bottom) so it
  stays on **and spins freely** — a display dial for the demo. The plate is
  identical to an EC11 build; only this part differs. **Tuning:** if the snap
  is too tight, drop `BARB_D` to 8.0; too loose, raise to 8.4.
- Prints **crown-DOWN** (peg pointing up) — no supports.

## Assembly (`assembly.py`)
- Tray at Z0 → plate on top (plate top face Z=41.5).
- Caps: bottom face at **Z=47.0** (switch seated, cap floats ~5.5 over plate).
- Knob: bottom at **Z=41.5** over r0c0 (rests on the plate top; snap peg
  clips through the Ø7.4 hole and spins).
- Exports: `exports/orchestrator-pad-assembled.glb`, `exports/orchestrator-pad-exploded.glb`
  (tray +0 / plate +20 / caps +40 / knob +52), plus one STL per printable part
  (`tray`, `plate`, `caps-all`, `legends-all`, `knob`).

## Colors (GLB preview only)
tray `#AEB4BC`, plate `#F4F5F7`, preset cap `#D8DCE2`, Grok `#141414`,
Codex `#6366F1`, Claude Code `#D97757`, Antigravity `#2D6BFF`,
opencode `#FAFAF8`, Kiro `#7A3FF2`, Cursor `#26282E`,
run/approve/reject/prompt/send `#FFFFFF`, voice bar `#FFFFFF`, knob `#E8E9EB`.
Legends: white `#FFFFFF` on colored caps, dark `#3F444D` on white caps,
mid `#8A919E` on the preset.

Logo glyphs (`grok`, `codex`, `claude`, `antigravity`, `opencode`, `kiro`,
`cursor`) are simplified geometric homages debossed 0.6 into the caps; the
original marks belong to their respective projects.

## BOM (v7)
Dual-USB-C ESP32-S3 clone board **with factory pin headers** (pins DOWN,
components + USB-C on TOP — the 13.6 under-board bay swallows the ~8.5 pin
tails; v3's headerless rule is gone). **Fit it sideways**: the board lies
along X with its ports facing a side wall, and you choose **ports-right or
ports-left** at assembly time — the bay is symmetric, so both drop in the
same way. Also: MAX98357A I2S amp breakout, 4Ω 3W
cavity speaker (flange ≤ 72 x 42, driver bump ≤ 11 tall — **measure it**)
+ 4 x **M2.5x6** self-tappers, round I2S mic module (INMP441-class),
**no potentiometer** (this build is hold-to-talk; the knob is a mock display
dial that snaps into the plate — omit the EC11), 14 x MX-style switches (donor-harvested
3-pin white MX clones fine), 4 x M3 heat-set inserts + **M3x8** button-head
screws (unchanged in v7: head bears at Z 40.7 under the counterbore, tip at
Z 32.7 vs the bore floor 31.5 — margin **+1.2**, and it still reaches the
insert zone; an M3x10 would bottom out in the Ø4.0 x 6.0 boss bore 0.8
before the head clamps), 4 x rubber feet Ø8 **≥3 mm tall** (down-firing
speaker + screw-tip clearance), zip ties for the wire bar, jumper wires.
Optional: WS2812 under the preset keys.

## Print notes
0.4 nozzle, 0.2 layers, PETG or PLA. Tray + plate flat side down, no
supports (the **two** 26 mm bridges over the side USB windows and the
**two** 1.6 shelf tabs print unsupported; the mid-span ribs, the flat board
cage — back rail + 2 front tabs — and the flat wire bar are all plain walls
off the floor). Caps upside down (top face on bed) or with tree supports;
**knob crown-down** (snap peg pointing up, prints support-free). Case is
~41.5 tall; with caps ≈ 54.5 overall (knob crown at
57.5). Every part = union of closed shells; slicers merge
coplanar/overlapping shells.
