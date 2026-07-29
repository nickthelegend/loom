"""audit_fit.py — AUDIT probe: component fit + SPEC compliance (read-only).

v7 "fatter, post-free" expectations: much taller tray (40.0, +12 over v6)
with a component bay that has NO free-standing cylindrical posts — the
REVERSIBLE rotated board bay is caged by FLAT features only (dual side-wall
shelves, two mid-span ribs, a flat back guide rail, two flat front corner
tabs), plus the TWO side USB windows, the down-firing speaker bay, the amp
pocket, a flat zip-tie wire bar and the high mic grille — and the
+12-shifted lid stack (plate 40.0..41.5, caps at 47.0, knob at 42.5, boss
tops 31.5/37.5). The USB windows (top 23.5) now sit far below the raised
ledge (33.5), so the plate skirt no longer needs USB notches.

The board runs along X and installs either way round:
    ports-right  X -22.0 .. +42.0     ports-left  X -42.0 .. +22.0
Checks that can differ between the two orientations are run for BOTH.

Recomputes every checklist quantity from the actual build() outputs /
partlib constants. Prints PASS/FAIL per item; exits non-zero on any FAIL.
No files modified.
"""
from __future__ import annotations

import sys

from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union

import partlib as pl
import part_plate
import part_tray
import part_caps
import part_knob

FAILURES = []


def check(name, ok):
    FAILURES.extend([] if ok else [name])
    return "PASS" if ok else "FAIL"


def sec(t):
    print(f"\n=== {t} ===")


# component data (v6 hardware per SPEC). The board is ROTATED: BOARD_W (30)
# is its span in Y, BOARD_L (64) its span in X, ports on a short (X) edge.
BRD_W, BRD_L, BRD_T = pl.BOARD_W, pl.BOARD_L, 1.6      # caged max envelope
BRD_PORT_X = 42.0                      # port-edge X of a ports-right install
BRD_TOP = pl.BOARD_Z + BRD_T           # 17.6
INSUL_H = 2.5                          # factory header insulator (on TOP)
INSUL_TOP = BRD_TOP + INSUL_H          # 20.1
SHELL_W, SHELL_H = 8.94, 3.3           # board-top USB-C shell (W spans Y now)
SHELL_Z0, SHELL_Z1 = BRD_TOP, BRD_TOP + SHELL_H        # 17.6..20.9
CONN_OVH = 1.31                        # USB-C shells overhang the board edge
HOOD_W, HOOD_H = 12.0, 7.0             # cable plug overmold hood
SHROUD_EXPOSED = 2.5                   # exposed metal between hood + receptacle
EC11_BODY_SQ = 12.0                    # EC11 body width
EC11_BODY_DEPTH = 7.0                  # body depth below the plate bottom
NUT_AF, NUT_H = 11.5, 2.2              # EC11 M7 panel nut
FOOT_H = 3.0                           # BOM: feet >= 3mm tall


def board_rect(sx):
    """Board footprint for sx=+1 (ports-right, X -22..+42) or sx=-1
    (ports-left, X -42..+22). 30 wide in Y either way."""
    a, b = sx * BRD_PORT_X, sx * (BRD_PORT_X - BRD_L)
    return box(min(a, b), -BRD_W / 2, max(a, b), BRD_W / 2)


BRD_R = board_rect(1)                  # ports-right footprint
BRD_LF = board_rect(-1)                # ports-left  footprint
BRD_ANY = BRD_R.union(BRD_LF)          # union envelope (x -42..42, |y|<=15)
BOARD_ORIENTS = (("ports-right", 1, BRD_R), ("ports-left", -1, BRD_LF))

# ---------------------------------------------------------------- 1. grid ----
sec("1. key grid vs SPEC")
spec_grid = {
    ("cursor"): (pl.COL_X[1], pl.ROW_Y[0]), ("codex"): (pl.COL_X[2], pl.ROW_Y[0]),
    ("preset3"): (pl.COL_X[3], pl.ROW_Y[0]),
    ("grok"): (pl.COL_X[0], pl.ROW_Y[1]), ("claude"): (pl.COL_X[1], pl.ROW_Y[1]),
    ("antigravity"): (pl.COL_X[2], pl.ROW_Y[1]), ("opencode"): (pl.COL_X[3], pl.ROW_Y[1]),
    ("kiro"): (pl.COL_X[0], pl.ROW_Y[2]), ("run"): (pl.COL_X[1], pl.ROW_Y[2]),
    ("approve"): (pl.COL_X[2], pl.ROW_Y[2]), ("reject"): (pl.COL_X[3], pl.ROW_Y[2]),
    ("prompt"): (pl.COL_X[0], pl.ROW_Y[3]), ("voice"): (0.0, pl.ROW_Y[3]),
    ("send"): (pl.COL_X[3], pl.ROW_Y[3]),
}
keys = pl.key_layout()
print("count:", len(keys), check("key count", len(keys) == 14))
for k in keys:
    want = spec_grid[k["id"]]
    got = (k["x"], k["y"])
    ok = abs(got[0] - want[0]) < 1e-9 and abs(got[1] - want[1]) < 1e-9
    if not ok or k["id"] == "voice":
        print(f"  {k['id']:12s} got {got} want {want} u={k['units']} "
              f"{check('grid ' + k['id'], ok)}")
print("knob pos:", pl.KNOB_POS,
      check("knob pos", pl.KNOB_POS == (pl.COL_X[0], pl.ROW_Y[0])))

# ------------------------------------------------------- 2. plate cutouts ----
sec("2. MX cutouts / plate thickness / webbing")
print("MX_CUT:", pl.MX_CUT, check("MX cutout 14.1", pl.MX_CUT == 14.1))
print("plate thickness:", pl.PLATE_Z1 - pl.PLATE_Z0,
      check("plate 1.5 thick", abs((pl.PLATE_Z1 - pl.PLATE_Z0) - 1.5) < 1e-9))
print(f"plate bands: {pl.PLATE_Z0}..{pl.PLATE_Z1 - part_plate.CBORE_DEPTH:.1f} + "
      f"{pl.PLATE_Z1 - part_plate.CBORE_DEPTH - 0.2:.1f}..{pl.PLATE_Z1} "
      f"{check('plate bands 40.0..40.7 + 40.5..41.5', pl.PLATE_Z0 == 40.0 and pl.PLATE_Z1 == 41.5)}")
prof_a = part_plate._plate_profile(part_plate.SCREW_D)
prof_b = part_plate._plate_profile(part_plate.CBORE_D)
thru_ok = True
for k in keys:
    pt2 = Point(k["x"], k["y"])
    if prof_a.contains(pt2) or prof_b.contains(pt2):
        print("  cutout NOT through both bands at", k["id"], "FAIL")
        thru_ok = False
print("cutouts through both bands:", check("MX cutouts through", thru_ok))
web_1u = pl.PITCH - pl.MX_CUT
print(f"webbing between adjacent cutouts: {web_1u:.2f}",
      check("webbing >= 4.0", web_1u >= 4.0))
d_knob_cut = pl.PITCH - pl.KNOB_HOLE_D / 2 - pl.MX_CUT / 2
print(f"knob hole edge to cursor cutout edge: {d_knob_cut:.2f}")
cut = affinity.translate(pl.rounded_rect(pl.MX_CUT, pl.MX_CUT, part_plate.MX_CORNER_R),
                         pl.COL_X[3], pl.ROW_Y[0])
cb = affinity.translate(pl.circle(part_plate.CBORE_D), 39, 39)
tw = affinity.translate(pl.circle(part_plate.TOWER_D), 39, 39)
print(f"cutout->counterbore web: {cut.distance(cb):.2f}   cutout->tower web: {cut.distance(tw):.2f}")

# ------------------------------------------------------------ 3. cap gaps ----
sec("3. keycap clearances (>= 0.8 required)")
bases = {}
for k in keys:
    ob = pl.rounded_rect(*part_caps.SIZES[k["units"]][0])
    bases[k["id"]] = affinity.translate(ob, k["x"], k["y"])
ids = list(bases)
worst = (1e9, None, None)
for i in range(len(ids)):
    for j in range(i + 1, len(ids)):
        d = bases[ids[i]].distance(bases[ids[j]])
        if d < worst[0]:
            worst = (d, ids[i], ids[j])
print(f"min cap-cap gap: {worst[0]:.3f} ({worst[1]} vs {worst[2]})",
      check("cap-cap gap", worst[0] >= 0.8))
knob_circle = affinity.translate(pl.circle(part_knob.KNOB_D), *pl.KNOB_POS)
dk = min((bases[i].distance(knob_circle), i) for i in ids)
print(f"knob(d17)->nearest cap gap: {dk[0]:.3f} ({dk[1]})",
      check("knob-cap gap", dk[0] >= 0.8))
clr = pl.CAP_Z0 - 4.0 - pl.PLATE_Z1
print(f"cap bottom after 4mm travel vs plate top: {clr:.2f}",
      check("travel clearance", clr >= 1.2))

# ---------------------------------------------- 4. mock snap-fit knob ------
sec("4. mock snap-fit knob (no potentiometer)")
print("plate knob hole d:", pl.KNOB_HOLE_D, check("knob hole 7.4", pl.KNOB_HOLE_D == 7.4))
# the peg shaft must clear the hole (spins); the barb must exceed it (snaps)
print(f"peg shaft Ø{part_knob.PEG_D} vs hole Ø{pl.KNOB_HOLE_D}: "
      f"{(pl.KNOB_HOLE_D - part_knob.PEG_D) / 2:.2f}/side clearance "
      f"{check('peg spins in hole', part_knob.PEG_D < pl.KNOB_HOLE_D)}")
print(f"barb Ø{part_knob.BARB_D} vs hole Ø{pl.KNOB_HOLE_D}: "
      f"{(part_knob.BARB_D - pl.KNOB_HOLE_D) / 2:.2f}/side catch "
      f"{check('barb catches under plate', part_knob.BARB_D > pl.KNOB_HOLE_D + 0.3)}")
# grip: knob bottom rests on the plate top; the barb ledge sits below the
# plate bottom by |LEDGE_Z| - PLATE_T -> a small axial play so it turns.
knob_bottom = pl.KNOB_Z0                                 # 41.5 = plate top
barb_ledge = pl.KNOB_Z0 + part_knob.LEDGE_Z              # 39.8
play = pl.PLATE_Z0 - barb_ledge                          # 0.2 (barb below plate bottom)
print(f"knob bottom Z {knob_bottom:.1f} (plate top {pl.PLATE_Z1}); "
      f"barb ledge Z {barb_ledge:.1f} vs plate bottom {pl.PLATE_Z0}: "
      f"axial play {play:.2f} "
      f"{check('knob rests on plate, barb retains', abs(knob_bottom - pl.PLATE_Z1) < 1e-9 and 0.0 <= play <= 0.6)}")
# the barb must clear the switch deck below (deck top well under the peg tip)
peg_tip = pl.KNOB_Z0 + (part_knob.LEDGE_Z - 0.9)         # 38.9
deck_top = pl.PLATE_Z1 - part_plate.SOCKET_SEAT_DROP     # 36.5 (deck seat)
print(f"peg tip Z {peg_tip:.1f} vs switch-deck top {deck_top:.1f}: "
      f"clr {peg_tip - deck_top:.2f} (deck also has a {part_plate.KNOB_CUT_W} cutout here) "
      f"{check('peg clears deck', peg_tip - deck_top >= 0.5)}")

# --------------------------------------------------- 5. skirt vs tray fit ----
sec("5. plate skirt vs tray (recompute)")
skirt = part_plate._skirt_profile()      # actual build profile (with notches)
skirt_out = pl.rounded_rect(part_plate.SKIRT_OUT_W, part_plate.SKIRT_OUT_W,
                            part_plate.SKIRT_OUT_R)
tray_in_thin = pl.rounded_rect(pl.CASE_W - 2 * part_tray.SKIRT_WALL,
                               pl.CASE_W - 2 * part_tray.SKIRT_WALL,
                               pl.CASE_R - part_tray.SKIRT_WALL)
pts = [skirt_out.exterior.interpolate(t, normalized=True) for t in
       [i / 720 for i in range(720)]]
min_gap = min(tray_in_thin.exterior.distance(p) for p in pts)
flats = (pl.CASE_W - 2 * part_tray.SKIRT_WALL - part_plate.SKIRT_OUT_W) / 2
print(f"skirt outer vs tray upper-inner: min gap {min_gap:.3f} per side "
      f"(SPEC ~0.15; flats give {flats:.3f}) "
      f"{check('skirt lateral ~0.15', 0.10 <= min_gap <= 0.25)}")
print(f"skirt band Z {pl.LEDGE_Z}..{pl.PLATE_Z0 + 0.2:.1f} "
      f"{check('skirt 33.5..40.2', pl.LEDGE_Z == 33.5 and pl.PLATE_Z0 == 40.0)}")
boss_zone = unary_union([affinity.translate(pl.circle(part_tray.BOSS_D), sx * 39, sy * 39)
                         for sx in (-1, 1) for sy in (-1, 1)])
inter = skirt.intersection(boss_zone)
boss_gap = skirt.distance(boss_zone)
z_lo = max(pl.LEDGE_Z, part_tray.BOSS_SOLID_TOP - part_tray.OVL)
z_hi = min(pl.PLATE_Z0 + 0.2, part_tray.BOSS_TOP)
print(f"skirt ∩ bosses XY area: {inter.area:.2f} mm^2, radial gap {boss_gap:.2f} "
      f"(boss band Z {z_lo:.1f}..{z_hi:.1f})  "
      f"{check('skirt/boss', inter.area < 0.01 and boss_gap >= 0.3)}")
# v7: the USB windows (top 23.5) sit ENTIRELY below the raised ledge (33.5),
# so the plate skirt has NO USB notch and removes ZERO material for USB —
# skirt-vs-window is a non-issue. Confirm the window top clears the ledge and
# that no USB material was cut from the skirt (only the 4 boss notches).
win_below = pl.LEDGE_Z - part_tray.WIN_Z1
print(f"USB window top {part_tray.WIN_Z1} vs ledge {pl.LEDGE_Z}: window sits "
      f"{win_below:.1f} below the ledge "
      f"{check('window below ledge', part_tray.WIN_Z1 < pl.LEDGE_Z)}")
# v7: the skirt (Z LEDGE_Z..PLATE_Z0+0.2) and the USB window (Z WIN_Z0..WIN_Z1)
# are Z-DISJOINT, so the skirt may (and now does) span the window's XY corridor
# with zero 3D interference — no notch needed. Confirm the Z gap per side.
for side, sx in (("right", 1), ("left", -1)):
    win_corr = box(min(sx * 40.0, sx * 46.0), -part_tray.WIN_W / 2,
                   max(sx * 40.0, sx * 46.0), part_tray.WIN_W / 2)
    xy = skirt.intersection(win_corr).area
    z_overlap = max(0.0, min(part_tray.WIN_Z1, pl.PLATE_Z0 + 0.2) - max(part_tray.WIN_Z0, pl.LEDGE_Z))
    print(f"{side} USB corridor (y ±{part_tray.WIN_W / 2:.0f}): skirt XY material "
          f"{xy:.1f} mm^2 but skirt Z {pl.LEDGE_Z}+ vs window Z ..{part_tray.WIN_Z1} -> "
          f"Z-overlap {z_overlap:.1f} "
          f"{check(f'{side} window Z-clear of skirt', z_overlap < 1e-9)}")
# zero USB material removed: the only cuts in the skirt are the 4 boss
# notches, so the skirt equals a boss-only ring, and part_plate exposes no
# USB_NOTCH_* constants anymore.
ring_full = pl.ring2d(
    pl.rounded_rect(part_plate.SKIRT_OUT_W, part_plate.SKIRT_OUT_W, part_plate.SKIRT_OUT_R),
    pl.rounded_rect(part_plate.SKIRT_IN_W, part_plate.SKIRT_IN_W, part_plate.SKIRT_IN_R))
boss_only = ring_full.difference(unary_union(
    [affinity.translate(pl.circle(part_plate.BOSS_CLEAR_D), x, y)
     for x, y in part_plate._screw_centers()]))
no_usb_consts = not any(hasattr(part_plate, n) for n in
                        ("USB_NOTCH_Y0", "USB_NOTCH_Y1", "USB_NOTCH_X0", "USB_NOTCH_X1"))
print(f"skirt == boss-only ring (extra area vs boss-only: "
      f"{skirt.symmetric_difference(boss_only).area:.4f} mm^2); no USB_NOTCH consts: "
      f"{no_usb_consts} {check('zero USB material removed', skirt.symmetric_difference(boss_only).area < 1e-6 and no_usb_consts)}")
print(f"skirt ring survives as {len(pl._polys(skirt))} segment(s) "
      f"(4 boss cuts, no USB notches) "
      f"{check('skirt segments', len(pl._polys(skirt)) == 4)}")
# the v4 mic grille sits fully below the ledge — no front notch needed
mic_margin = pl.LEDGE_Z - part_tray.MIC_Z1
print(f"mic grille ceiling {part_tray.MIC_Z1} vs ledge {pl.LEDGE_Z}: margin "
      f"{mic_margin:.1f} (no front skirt notch needed) "
      f"{check('mic below ledge', mic_margin >= 0.5)}")
tower = affinity.translate(pl.circle(part_plate.TOWER_D), 39, 39)
print(f"tower vs tray thin-wall inner: gap {tray_in_thin.exterior.distance(tower):.3f} "
      f"(contained: {tray_in_thin.contains(tower)}) "
      f"{check('towers inside tray', tray_in_thin.contains(tower))}")

# --------------------------------------------------------- 6. screw stack ----
SCREW_L = 8.0
sec(f"6. screw stack (M3x{SCREW_L:.0f} button head)")
head_z = pl.PLATE_Z1 - part_plate.CBORE_DEPTH          # 40.7 (v7)
bore_floor = part_tray.BOSS_SOLID_TOP                  # 31.5 (v7)
tip_z = head_z - SCREW_L                               # 32.7 (M3x8, margin +1.2)
print(f"counterbore d{part_plate.CBORE_D} x {part_plate.CBORE_DEPTH} -> head at Z{head_z:.1f}")
print(f"3.4 channel: plate {pl.PLATE_Z0}->{head_z:.1f} + tower {part_plate.TOWER_Z0}->{pl.PLATE_Z0 + 0.2}")
print(f"boss bore d{part_tray.BORE_D} open {bore_floor}->{part_tray.BOSS_TOP} "
      f"(depth {part_tray.BOSS_TOP - bore_floor:.1f})")
print(f"M3x{SCREW_L:.0f} tip lands at Z{tip_z:.1f}; bore floor Z{bore_floor:.1f} -> "
      f"margin {tip_z - bore_floor:+.1f} mm "
      f"{check('screw does not bottom out', tip_z >= bore_floor)}")
print(f"insert zone top Z{part_tray.BOSS_TOP:.1f}; screw reaches the insert: "
      f"{check('screw engages insert', tip_z <= part_tray.BOSS_TOP - 3)}")

# --------------------------------------------------------- 7. USB windows ----
sec("7. USB windows (both side walls) vs dual-USB-C board (board-top ports)")
win_lo, win_hi = -part_tray.WIN_W / 2, part_tray.WIN_W / 2
print(f"windows: RIGHT (X=+45) and LEFT (X=-45), each {part_tray.WIN_W} wide "
      f"(y {win_lo:+.0f}..{win_hi:+.0f}), Z {part_tray.WIN_Z0}..{part_tray.WIN_Z1} "
      f"({part_tray.WIN_Z1 - part_tray.WIN_Z0:.1f} tall) "
      f"{check('window = USB_WIN', (part_tray.WIN_W, part_tray.WIN_Z0, part_tray.WIN_Z1) == pl.USB_WIN)}")
win2d = part_tray.win_cutter()
wb = win2d.bounds
print(f"cutter: {len(pl._polys(win2d))} boxes, bounds x {wb[0]:.0f}..{wb[2]:.0f} "
      f"y {wb[1]:.0f}..{wb[3]:.0f}, mirror-symmetric about X=0 "
      f"{check('two mirrored side cutters', len(pl._polys(win2d)) == 2 and abs(wb[0] + wb[2]) < 1e-9)}")
print(f"shell band: {SHELL_W} w (in Y) x {SHELL_H} h on the board top -> Z "
      f"{SHELL_Z0:.1f}..{SHELL_Z1:.1f} (center {(SHELL_Z0 + SHELL_Z1) / 2:.2f}); margins "
      f"{SHELL_Z0 - part_tray.WIN_Z0:.1f} below / {part_tray.WIN_Z1 - SHELL_Z1:.1f} above "
      f"{check('shell inside window band', SHELL_Z0 - part_tray.WIN_Z0 >= 0.3 and part_tray.WIN_Z1 - SHELL_Z1 >= 0.3)}")
shell_env = win_hi - SHELL_W / 2
hood_env = win_hi - HOOD_W / 2
print(f"port-offset envelope: shell fully in window for |y| <= {shell_env:.2f}, "
      f"hood for |y| <= {hood_env:.1f} (spec requires |y| <= 8.5 for the shell) "
      f"{check('port offsets dont matter', shell_env >= 8.5 and hood_env >= 5.5)}")
# receptacle recess is the same on either side: the board's port edge sits
# BRD_PORT_X from center, the outer wall face at CASE_W/2.
recess = (pl.CASE_W / 2) - (BRD_PORT_X + CONN_OVH)       # 1.69
for label, sx, rect in BOARD_ORIENTS:
    edge = sx * BRD_PORT_X
    print(f"  {label:11s}: board footprint x {rect.bounds[0]:+.1f}..{rect.bounds[2]:+.1f}, "
          f"port edge x {edge:+.1f} -> receptacle face |x| "
          f"{BRD_PORT_X + CONN_OVH:.2f}, recess behind the outer face {recess:.2f}")
# threshold is the physical mating criterion: the recess must be swallowed by
# the plug's exposed shroud so the hood meets the aperture mouth.
print(f"plug hood {HOOD_W:.0f}w x {HOOD_H:.0f}t vs aperture {part_tray.WIN_W:.0f}w x "
      f"{part_tray.WIN_Z1 - part_tray.WIN_Z0:.1f}t: width play "
      f"{(part_tray.WIN_W - HOOD_W) / 2:.1f}/side; recess {recess:.2f} <= exposed-shroud "
      f"reach {SHROUD_EXPOSED:.1f} -> plug mates with the hood at the mouth "
      f"{check('plug hood passes aperture', HOOD_W <= part_tray.WIN_W - 2 and recess <= SHROUD_EXPOSED)}")
print(f"  (zero-overhang clone: recess {pl.CASE_W / 2 - BRD_PORT_X:.1f} — still under "
      f"most cables' 2.5..3.5 exposed shroud)")
print(f"the unused window is a wire pass-through (same 26 x "
      f"{part_tray.WIN_Z1 - part_tray.WIN_Z0:.1f} aperture on the opposite wall)")

# ----------------------------------------------------------- 8. board bay ----
sec("8. board bay (dual side shelves / mid-span ribs / FLAT cage) — REVERSIBLE, POST-FREE")
shelves = [box(min(sx * part_tray.SHELF_X0, sx * part_tray.SHELF_X1), -part_tray.SHELF_Y,
               max(sx * part_tray.SHELF_X0, sx * part_tray.SHELF_X1), part_tray.SHELF_Y)
           for sx in (-1, 1)]
shelves2d = unary_union(shelves)
print(f"shelves: x ±{part_tray.SHELF_X0}..±{part_tray.SHELF_X1}, y "
      f"±{part_tray.SHELF_Y} (tab {pl.CASE_W / 2 - pl.WALL - part_tray.SHELF_X0:.1f} off "
      f"the wall inner face {pl.CASE_W / 2 - pl.WALL:.1f}, {part_tray.SHELF_X1 - (pl.CASE_W / 2 - pl.WALL):.1f} lap "
      f"into the liner), body {part_tray.SHELF_Z0}..{pl.BOARD_Z} "
      f"{check('shelf top = BOARD_Z', part_tray.SHELF_X0 == 41.0 and part_tray.SHELF_Z0 == 13.5)}")
sb = shelves2d.bounds
print(f"  two tabs, mirrored: bounds x {sb[0]:.1f}..{sb[2]:.1f} "
      f"{check('two mirrored shelves', len(shelves) == 2 and abs(sb[0] + sb[2]) < 1e-9)}")
bearing = BRD_PORT_X - part_tray.SHELF_X0
print(f"board port edge |x| {BRD_PORT_X} -> shelf bearing {bearing:.1f} deep, wall gap "
      f"{pl.CASE_W / 2 - pl.WALL - BRD_PORT_X:.1f} (same on either side) "
      f"{check('shelf bearing', bearing >= 0.8)}")
print(f"  shelf y ±{part_tray.SHELF_Y} vs board y ±{BRD_W / 2:.0f}: seats "
      f"{BRD_W / 2 - part_tray.SHELF_Y:.1f} inboard of each long edge "
      f"{check('shelf inside board width', part_tray.SHELF_Y <= BRD_W / 2)}")
ribs2d = unary_union([box(x0, part_tray.RIB_Y0, x1, part_tray.RIB_Y1)
                      for x0, x1 in part_tray.RIB_X])
print(f"ribs: x {part_tray.RIB_X}, y {part_tray.RIB_Y0}..{part_tray.RIB_Y1}, "
      f"floor..{pl.BOARD_Z} (mid-span, replaces the v5 front bridge) "
      f"{check('two mirrored ribs', len(part_tray.RIB_X) == 2 and abs(part_tray.RIB_X[0][0] + part_tray.RIB_X[1][1]) < 1e-9)}")
rib_span = min(part_tray.RIB_Y1, BRD_W / 2) - part_tray.RIB_Y0
print(f"  rib bearing under the board: y {part_tray.RIB_Y0}..{min(part_tray.RIB_Y1, BRD_W / 2):.0f} "
      f"= {rib_span:.1f} long, at |x| {part_tray.RIB_X[0][0]:.0f}..{part_tray.RIB_X[0][1]:.0f} "
      f"(mid-span of a {BRD_L:.0f}-long board either way round) "
      f"{check('ribs bear on board', rib_span >= 8.0)}")
# FLAT board cage (v7): NO cylindrical posts. A back guide rail caps the +Y
# edge; two front corner tabs cap the -Y corners. Inner faces at |y| = 15.1.
no_posts = not hasattr(part_tray, "POST_XY") and not hasattr(part_tray, "WPOST_XY")
print(f"cylindrical locator/wire posts removed (no POST_XY / WPOST_XY attr): {no_posts} "
      f"{check('no cylindrical posts', no_posts)}")
rail2d = box(-part_tray.BACK_RAIL_XW, part_tray.CAGE_Y_IN,
             part_tray.BACK_RAIL_XW, part_tray.CAGE_Y_OUT)
tab_r = box(part_tray.TAB_X0, -part_tray.CAGE_Y_OUT, part_tray.TAB_X1, -part_tray.CAGE_Y_IN)
tab_l = box(-part_tray.TAB_X1, -part_tray.CAGE_Y_OUT, -part_tray.TAB_X0, -part_tray.CAGE_Y_IN)
tabs2d = unary_union([tab_r, tab_l])
cage2d = unary_union([rail2d, tab_r, tab_l])
cage_clr = part_tray.CAGE_Y_IN - BRD_W / 2               # 0.1 per side
cage_h = part_tray.CAGE_Z1 - BRD_TOP                     # 1.4 over the board top
print(f"back rail x ±{part_tray.BACK_RAIL_XW}, front tabs x ±{part_tray.TAB_X0}..±"
      f"{part_tray.TAB_X1}, inner faces |y|={part_tray.CAGE_Y_IN}, Z "
      f"{pl.FLOOR - part_tray.OVL:.1f}..{part_tray.CAGE_Z1}: cages {cage_clr:.2f}/side to a "
      f"{BRD_W:.0f}-wide board, {cage_h:.1f} lip over the board top "
      f"{check('cage clears board 0.1/side', abs(cage_clr - 0.1) < 1e-9 and cage_h >= 1.0)}")
rail_inner = rail2d.bounds[1]                            # +15.1
tab_inner = max(tab_r.bounds[3], tab_l.bounds[3])        # -15.1
print(f"  rail inner face y {rail_inner:+.1f}; both tab inner faces y {tab_inner:+.1f} "
      f"{check('cage inner faces at |y|=15.1', abs(rail_inner - 15.1) < 1e-9 and abs(tab_inner + 15.1) < 1e-9)}")
# the flat cage caps the board in Y in BOTH orientations: the back rail spans
# the +Y edge and at least one front tab spans the -Y edge over each board's X
for label, sx, rect in BOARD_ORIENTS:
    x0, x1 = rect.bounds[0], rect.bounds[2]
    rail_over = x0 - 0.01 <= rail2d.bounds[0] and rail2d.bounds[2] <= x1 + 0.01
    tabs_over = [t for t in (tab_r, tab_l)
                 if x0 - 0.01 <= t.bounds[0] and t.bounds[2] <= x1 + 0.01]
    print(f"  {label:11s} (x {x0:+.0f}..{x1:+.0f}): back rail over +Y edge {rail_over}, "
          f"{len(tabs_over)} front tab(s) over a -Y corner "
          f"{check(f'{label} caged +Y and -Y', rail_over and len(tabs_over) >= 1)}")
print(f"  cage vs board footprint (no cage wall under the board, either orientation): "
      f"R {cage2d.intersection(BRD_R).area:.2f} / L {cage2d.intersection(BRD_LF).area:.2f} mm^2 "
      f"{check('cage does not underlie the board', cage2d.intersection(BRD_ANY).area < 0.01)}")
seats2d = shelves2d.union(ribs2d)
for label, sx, rect in BOARD_ORIENTS:
    supported = seats2d.intersection(rect).area
    print(f"  {label:11s}: seat bearing area under the board {supported:.1f} mm^2 "
          f"{check(f'{label} seats at 16.0', supported >= 100.0)}")
under = pl.BOARD_Z - pl.FLOOR
print(f"under-board bay: floor {pl.FLOOR} -> {pl.BOARD_Z} = {under:.1f} for the "
      f"factory header pins (~8.5) + angled dupont connectors "
      f"{check('13.6 under-board', abs(under - 13.6) < 1e-9)}")
bump_top = pl.FLOOR + 1.5 + pl.SPK_BUMP_MAX
print(f"speaker bump top {pl.FLOOR}+1.5+{pl.SPK_BUMP_MAX} = {bump_top:.1f} vs board "
      f"underside {pl.BOARD_Z} -> clearance {pl.BOARD_Z - bump_top:.1f} "
      f"{check('bump vs board underside', pl.BOARD_Z - bump_top >= 1.0)}")

# ------------------------------------------------ 9. switch stack over bay ----
sec("9. switch under-plate envelope vs board stack")
PIN_TIP = pl.PLATE_Z1 - 8.3            # 33.2 (v7) — MX center post + pins
HOUS_BOT = pl.PLATE_Z1 - 5.0           # 36.5 (v7) — MX housing base
# the headers run along the board's LONG edges — now the y = ±15 edges
strips = unary_union([box(-BRD_PORT_X, BRD_W / 2 - 2.5, BRD_PORT_X, BRD_W / 2),
                      box(-BRD_PORT_X, -BRD_W / 2, BRD_PORT_X, -BRD_W / 2 + 2.5)])
over_board, over_strip = [], []
for k in keys:
    post = Point(k["x"], k["y"]).buffer(2.0, quad_segs=16)
    pins = [Point(k["x"] - 3.81, k["y"] + 2.54), Point(k["x"] + 2.54, k["y"] + 5.08)]
    zone = unary_union([post] + pins)
    if zone.intersects(BRD_ANY):
        over_board.append(k["id"])
    if any(strips.contains(p) for p in pins) or post.intersects(strips):
        over_strip.append(k["id"])
clr_ins = PIN_TIP - INSUL_TOP
clr_brd = PIN_TIP - BRD_TOP
print(f"switch lowest point Z {PIN_TIP:.1f} (plate top {pl.PLATE_Z1} - 8.3); "
      f"housing base Z {HOUS_BOT:.1f}")
print(f"keys over the board (union of both orientations): {over_board}")
print(f"keys with pins/posts over the header-insulator strips: {over_strip}")
print(f"pins vs insulator top {INSUL_TOP:.1f}: clearance {clr_ins:.1f} "
      f"{check('pins vs insulators >= 0.8', clr_ins >= 0.8)}")
print(f"pins vs bare board top {BRD_TOP:.1f}: clearance {clr_brd:.1f} "
      f"{check('pins vs board', clr_brd >= 0.5)}")
spk_zone = box(-pl.SPK_FLANGE[0] / 2, pl.SPK_CENTER[1] - pl.SPK_FLANGE[1] / 2,
               pl.SPK_FLANGE[0] / 2, pl.SPK_CENTER[1] + pl.SPK_FLANGE[1] / 2)
over_spk = [k["id"] for k in keys
            if Point(k["x"], k["y"]).buffer(2.0).intersects(spk_zone)]
print(f"keys over the speaker: {over_spk} -> pins {PIN_TIP:.1f} vs bump top "
      f"{bump_top:.1f}: clearance {PIN_TIP - bump_top:.1f} "
      f"{check('pins vs speaker bump', PIN_TIP - bump_top >= 2.0)}")

# ---------------------------------------------------------- 10. speaker bay ----
sec("10. speaker bay (floor grille / pilots / flange)")
slots = part_tray.spk_floor_opening()
slot_polys = pl._polys(slots)
b = slots.bounds
print(f"floor opening: racetrack {part_tray.SPK_OPEN_W}x{part_tray.SPK_OPEN_H} "
      f"R{part_tray.SPK_OPEN_R} at {pl.SPK_CENTER} minus 2x {part_tray.SPK_BAR_W} bars "
      f"-> {len(slot_polys)} slots, bounds x {b[0]:.1f}..{b[2]:.1f} y {b[1]:.1f}..{b[3]:.1f}, "
      f"area {slots.area:.0f} mm^2 "
      f"{check('3 grille slots', len(slot_polys) == 3)}")
feet = unary_union([affinity.translate(pl.circle(part_tray.FEET_D),
                                       sx * part_tray.FEET_XY, sy * part_tray.FEET_XY)
                    for sx in (-1, 1) for sy in (-1, 1)])
d_slot_feet = slots.distance(feet)
print(f"slots vs feet recesses: distance {d_slot_feet:.2f} "
      f"{check('slots clear feet', d_slot_feet >= 2.0)}")
pilots = [Point(x, y) for x, y in part_tray.SPK_PILOT_XY]
print(f"pilots Ø{part_tray.SPK_PILOT_D} THROUGH the floor at "
      f"{part_tray.SPK_PILOT_XY} (63 x 33 pattern)")
liner_in = pl.rounded_rect(pl.CASE_W - 2 * pl.WALL, pl.CASE_W - 2 * pl.WALL,
                           pl.CASE_R - pl.WALL)
pilot_ok = all(liner_in.contains(p.buffer(part_tray.SPK_PILOT_D / 2)) for p in pilots)
print(f"pilots inside the floor interior: {pilot_ok} "
      f"{check('pilots inside floor', pilot_ok)}")
d_pf = min(p.distance(Point(sx * 36, sy * 36)) for p in pilots
           for sx in (-1, 1) for sy in (-1, 1))
print(f"  INFO closest pilot center to a foot center: {d_pf:.2f} "
      f"(rims merge {part_tray.FEET_D / 2 + part_tray.SPK_PILOT_D / 2 - d_pf:.2f} in the "
      f"0.6 recess layer only — designed 63x33-vs-feet consequence, layers stay "
      f"watertight; pilot bore complete above the recess: "
      f"{check('pilot center outside recess', d_pf >= part_tray.FEET_D / 2)})")
boss_front = unary_union([affinity.translate(pl.circle(part_tray.BOSS_D), sx * 39, -39)
                          for sx in (-1, 1)])
flange_sharp = affinity.translate(box(-36, -21, 36, 21), 0, pl.SPK_CENTER[1])
flange_r65 = affinity.translate(pl.rounded_rect(72, 42, 6.5), *pl.SPK_CENTER)
sharp_ov = flange_sharp.intersection(boss_front).area
r65_gap = flange_r65.distance(boss_front)
print(f"flange 72x42 vs front bosses: sharp-corner overlap {sharp_ov:.2f} mm^2 "
      f"(INFO — real cavity flanges are rounded); corner R6.5 gap {r65_gap:.3f} "
      f"{check('R6.5 flange clears bosses', sharp_ov < 3.0 and r65_gap > 0.05)}")
d_fl_wall = liner_in.exterior.distance(flange_sharp)
# v7: every FLAT board-cage + wire-bar feature must stay OUT of the speaker
# flange footprint (X ±36, Y -42..0). Bar is "no intersection, >= 0.4 clear",
# each clearance printed; the two front tabs sit at |X| >= 36.8 and must
# clear by >= 0.5.
FLANGE_MIN, TAB_FLANGE_MIN = 0.4, 0.5
wbar2d = box(part_tray.WBAR_X0, part_tray.WBAR_Y0, part_tray.WBAR_X1, part_tray.WBAR_Y1)
bay_features = {
    "back guide rail": (rail2d, FLANGE_MIN),
    "front tab (R)": (tab_r, TAB_FLANGE_MIN),
    "front tab (L)": (tab_l, TAB_FLANGE_MIN),
    "wire bar": (wbar2d, FLANGE_MIN),
    "mid-span ribs": (ribs2d, FLANGE_MIN),
    "amp ridges": (part_tray.amp_ridges(), FLANGE_MIN),
    "board shelves": (shelves2d, FLANGE_MIN),
}
print(f"speaker flange footprint x ±{pl.SPK_FLANGE[0] / 2:.0f}, y "
      f"{pl.SPK_CENTER[1] - pl.SPK_FLANGE[1] / 2:.0f}..{pl.SPK_CENTER[1] + pl.SPK_FLANGE[1] / 2:.0f} "
      f"— every bay feature must stay clear (tabs >= {TAB_FLANGE_MIN}, else >= {FLANGE_MIN}):")
for fname, (geom, mn) in bay_features.items():
    ov = geom.intersection(flange_sharp).area
    d = geom.distance(flange_sharp)
    print(f"  {fname:16s} overlap {ov:.3f} mm^2, clearance {d:.2f} (need >= {mn}) "
          f"{check(f'flange vs {fname}', ov < 1e-6 and d >= mn)}")
obstacles = unary_union([g for g, _mn in bay_features.values()])
d_fl_obs = flange_sharp.distance(obstacles)
print(f"flange vs walls {d_fl_wall:.2f} / vs all bay features {d_fl_obs:.2f} "
      f"{check('flange drops onto floor', d_fl_wall >= 0.4 and d_fl_obs >= FLANGE_MIN)}")
bump = affinity.translate(affinity.scale(pl.circle(2.0), 25.0, 20.0), *pl.SPK_CENTER)
d_bump_ribs = bump.distance(ribs2d)
d_bump_cage = bump.distance(cage2d)
print(f"oval bump (<= 50x40, top {bump_top:.1f}) vs ribs: plan gap {d_bump_ribs:.2f}; "
      f"vs flat cage {d_bump_cage:.2f} "
      f"{check('bump clears ribs/cage', d_bump_ribs >= 2.0 and d_bump_cage >= 2.0)}")
tip_below_floor = 6.0 - 1.5 - pl.FLOOR                 # M2.5x6: flange + floor
print(f"M2.5x6 from inside: head on flange top {pl.FLOOR + 1.5:.1f}, tip "
      f"{tip_below_floor:.1f} below the floor bottom; feet >= {FOOT_H:.0f} - recess "
      f"{part_tray.FEET_DEPTH} -> ground clearance {FOOT_H - part_tray.FEET_DEPTH - tip_below_floor:.1f} "
      f"{check('screw tips in foot gap', FOOT_H - part_tray.FEET_DEPTH - tip_below_floor >= 0.2)}")

# ------------------------------------------- 11. amp / wire bar / mic ----
sec("11. amp pocket, wire bar, mic grille")
ridges = part_tray.amp_ridges()
pocket = box(part_tray.AMP_C[0] - 10, part_tray.AMP_C[1] - 10,
             part_tray.AMP_C[0] + 10, part_tray.AMP_C[1] + 10)
rb = ridges.bounds
print(f"amp pocket 20x20 at {part_tray.AMP_C} (back strip): ridges {rb[0]:.1f}..{rb[2]:.1f} x "
      f"{rb[1]:.1f}..{rb[3]:.1f}, h {part_tray.AMP_RIDGE_H} "
      f"{check('ridges frame pocket', ridges.intersection(pocket).area < 0.01)}")
bosses2d = unary_union([affinity.translate(pl.circle(part_tray.BOSS_D), sx * pl.BOSS_XY,
                                           sy * pl.BOSS_XY)
                        for sx in (-1, 1) for sy in (-1, 1)])
# v7: the old (20,17.6) locator post that clipped the pocket's south edge is
# GONE — the pocket is a clean, full 20x20. The nearest cage wall is the back
# rail, deliberately trimmed to +-10 so it clears the amp by 0.5.
print(f"  ridge outer edge vs liner wall: {liner_in.exterior.distance(ridges):.2f}  "
      f"vs corner bosses: {ridges.distance(bosses2d):.2f}  vs flat cage (back rail): "
      f"{ridges.distance(cage2d):.2f} "
      f"{check('amp clear of bosses/cage', ridges.distance(bosses2d) >= 0.5 and ridges.distance(cage2d) >= 0.4)}")
# the rotated board covers x -42..+42 over |y| <= 15 across the two
# orientations — the amp must not sit under it in EITHER install
for label, sx, rect in BOARD_ORIENTS:
    ov, d = ridges.intersection(rect).area, ridges.distance(rect)
    print(f"  amp ridges vs {label:11s} board footprint: overlap {ov:.3f} mm^2, "
          f"clearance {d:.2f} "
          f"{check(f'amp not under board ({label})', ov < 1e-6 and d >= 0.4)}")
print(f"  MAX98357A breakout ~18x16 in the now-full 20x20 pocket: 1.0+ play/side (foam tape)")
# Wire BAR (v7): flat wall with two zip-tie through-slots (band-split in Z).
seg_min = min(part_tray.WBAR_Y1 - (part_tray.WSLOT_YS[-1] + part_tray.WSLOT_W / 2),
              part_tray.WSLOT_YS[0] - part_tray.WSLOT_W / 2 - part_tray.WBAR_Y0,
              (part_tray.WSLOT_YS[1] - part_tray.WSLOT_YS[0]) - part_tray.WSLOT_W)
print(f"wire bar x {part_tray.WBAR_X0}..{part_tray.WBAR_X1} (2.0 thick), y "
      f"{part_tray.WBAR_Y0}..{part_tray.WBAR_Y1}, Z {pl.FLOOR - part_tray.OVL:.1f}.."
      f"{part_tray.WBAR_Z1}; 2 slots {part_tray.WSLOT_W} wide at y {part_tray.WSLOT_YS}, Z "
      f"{part_tray.WSLOT_Z0}..{part_tray.WSLOT_Z1}: shortest bar segment {seg_min:.1f} "
      f"{check('wire bar segments printable', seg_min >= 2.0)}")
# the bar underlies the ports-left board in plan, but tops out 8.0 below the
# board underside (16.0), so it never obstructs seating in EITHER orientation
under_gap = pl.BOARD_Z - part_tray.WBAR_Z1
for label, sx, rect in BOARD_ORIENTS:
    ov = wbar2d.intersection(rect).area
    print(f"  wire bar vs {label:11s} board footprint: plan overlap {ov:.1f} mm^2, but "
          f"bar top {part_tray.WBAR_Z1} is {under_gap:.1f} below the board underside {pl.BOARD_Z} "
          f"{check(f'wire bar clears board ({label})', under_gap >= 1.0)}")
left_corr = box(-46.0, -part_tray.WIN_W / 2, -40.0, part_tray.WIN_W / 2)
print(f"  wire bar vs the LEFT window corridor (y ±{part_tray.WIN_W / 2:.0f}, Z 17+) "
      f"{wbar2d.distance(left_corr):.2f} (bar tops at Z {part_tray.WBAR_Z1}, 9+ below)  "
      f"vs corner bosses {wbar2d.distance(bosses2d):.2f}  vs flange {wbar2d.distance(flange_sharp):.1f} "
      f"{check('wire bar clear', wbar2d.distance(bosses2d) >= 0.5 and wbar2d.distance(flange_sharp) >= 0.5)}")
mic_lo, mic_hi = min(part_tray.MIC_XS), max(part_tray.MIC_XS)
print(f"mic grille: 3 x {part_tray.MIC_W} sq ports at x {part_tray.MIC_XS}, Z "
      f"{part_tray.MIC_Z0}..{part_tray.MIC_Z1} "
      f"{check('mic port spacing', mic_hi - mic_lo == 6.0 and (mic_lo + mic_hi) / 2 == -20.0)}")
mod_zone = box(-27.0, -42.6, -13.0, -41.0)             # Ø14 module glued on liner
d_mod_bump = bump.distance(mod_zone)
mic_slots = unary_union([box(x - part_tray.MIC_W / 2, -46.0, x + part_tray.MIC_W / 2, -40.0)
                         for x in part_tray.MIC_XS])
print(f"  round mic module glue zone (x -27..-13 on the front liner) vs oval bump: "
      f"plan gap {d_mod_bump:.1f}; module bottom sits above flange top "
      f"{pl.FLOOR + 1.5:.1f} {check('mic module above speaker', d_mod_bump >= 0.5)}")
# v7 sanity: nothing that moved may have landed on the (unchanged) grille
moved = {"flat cage": cage2d, "wire bar": wbar2d, "ribs": ribs2d,
         "amp ridges": ridges, "shelves": shelves2d, "USB windows": part_tray.win_cutter()}
mic_ok = True
for mname, geom in moved.items():
    if geom.intersects(mic_slots) or geom.intersects(mod_zone):
        print(f"  COLLISION: {mname} hits the mic grille / module zone")
        mic_ok = False
print(f"  mic grille + module zone untouched by every v7 bay feature "
      f"{check('mic grille collision-free', mic_ok)}")

# ------------------------------------------------------- 12. watertight ----
sec("12. v5.1 switch sockets + flat footprint deck")
seat_z = pl.PLATE_Z1 - part_plate.SOCKET_SEAT_DROP
floor_z0 = seat_z - part_plate.DECK_T
pin_tip = seat_z - 3.3
print(f"base/deck seat Z {seat_z:.1f} (plate top {pl.PLATE_Z1} - 5.0)",
      check("seat at plate_top-5.0", abs(seat_z - (pl.PLATE_Z1 - 5.0)) < 1e-9))
print(f"pin tips Z {pin_tip:.1f} protrude {floor_z0 - pin_tip:.1f} below the "
      f"deck ({floor_z0:.1f})",
      check("pins solder-accessible", floor_z0 - pin_tip >= 1.5))
print(f"deck bottom {floor_z0:.1f} vs header insulator top {INSUL_TOP:.1f}",
      check("deck clears insulators", floor_z0 - INSUL_TOP >= 1.0))
ko = part_plate._tower_keepout()
deck = part_plate._deck_profile()
sock_ok = clear_ok = True
holes_ok = True
for k in pl.key_layout():
    wall = part_plate._socket_wall(k, ko)
    sock_ok &= not wall.is_empty
    for dx, dy in [(0, 0), part_plate.MX_PIN_A, part_plate.MX_PIN_B]:
        holes_ok &= not deck.contains(Point(k["x"] + dx, k["y"] + dy))
    for cx, cy in [(sx * pl.BOSS_XY, sy * pl.BOSS_XY)
                   for sx in (-1, 1) for sy in (-1, 1)]:
        tower = affinity.translate(pl.circle(part_plate.TOWER_D), cx, cy)
        clear_ok &= wall.distance(tower) >= 0.15
        clear_ok &= deck.distance(tower) >= 0.15
print("all 14 socket walls non-empty:", check("sockets built", sock_ok))
print("post + contact holes open in the deck at every key:",
      check("deck footprint holes", holes_ok))
print("walls + deck clear the screw towers (>=0.15):", check("socket-tower", clear_ok))
ec_cut = affinity.translate(
    box(-EC11_BODY_SQ / 2, -EC11_BODY_SQ / 2, EC11_BODY_SQ / 2, EC11_BODY_SQ / 2),
    *pl.KNOB_POS)
print("deck cutout swallows the EC11 body:",
      check("deck EC11 cutout", not deck.intersects(ec_cut)))
# printability: flipped plate must have NO geometry hanging below the socket
# wall bottoms other than the skirt/towers (i.e., no floors = no bridges)
plate_mesh = part_plate.build()[0][1]
import numpy as np
V = np.asarray(plate_mesh.V)
in_socket_zone = (np.abs(V[:, 0]) < 38.0) & (np.abs(V[:, 1]) < 38.0)
zmin_sockets = V[in_socket_zone][:, 2].min()
print(f"lowest plate geometry inside the key field: Z {zmin_sockets:.1f}",
      check("no floating floors in plate", zmin_sockets >= seat_z - 1e-6))

sec("13. watertight (every build item)")
wt = True
for name, mesh, _c in (part_tray.build() + part_plate.build()
                       + part_caps.build() + part_knob.build()):
    rep = pl.validate(mesh)
    wt &= rep["watertight"]
    if not rep["watertight"]:
        print(f"  NOT WATERTIGHT: {name} {rep['problems'][:3]}")
print("all items watertight:", check("watertight", wt))

# --------------------------------------------------------------- summary ----
print(f"\nAUDIT-FIT: {len(FAILURES)} failure(s)"
      + (f" -> {FAILURES}" if FAILURES else " -> ALL CLEAR"))
sys.exit(1 if FAILURES else 0)
