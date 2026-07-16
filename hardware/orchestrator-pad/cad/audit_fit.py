"""audit_fit.py — AUDIT 2 probe: component fit + SPEC compliance (read-only).

Recomputes every checklist quantity from the actual build() outputs / partlib
constants. Prints PASS/FAIL per item; no files modified.
"""
from __future__ import annotations

import math

from shapely import affinity
from shapely.geometry import box
from shapely.ops import unary_union

import partlib as pl
import part_plate
import part_tray
import part_caps
import part_knob

OK = "PASS"
BAD = "FAIL"


def sec(t):
    print(f"\n=== {t} ===")


# ---------------------------------------------------------------- 1. grid ----
sec("1. key grid vs SPEC")
spec_grid = {
    ("preset1"): (pl.COL_X[1], pl.ROW_Y[0]), ("preset2"): (pl.COL_X[2], pl.ROW_Y[0]),
    ("preset3"): (pl.COL_X[3], pl.ROW_Y[0]),
    ("codex"): (pl.COL_X[0], pl.ROW_Y[1]), ("claude"): (pl.COL_X[1], pl.ROW_Y[1]),
    ("antigravity"): (pl.COL_X[2], pl.ROW_Y[1]), ("opencode"): (pl.COL_X[3], pl.ROW_Y[1]),
    ("kiro"): (pl.COL_X[0], pl.ROW_Y[2]), ("run"): (pl.COL_X[1], pl.ROW_Y[2]),
    ("approve"): (pl.COL_X[2], pl.ROW_Y[2]), ("reject"): (pl.COL_X[3], pl.ROW_Y[2]),
    ("prompt"): (pl.COL_X[0], pl.ROW_Y[3]), ("voice"): (0.0, pl.ROW_Y[3]),
    ("send"): (pl.COL_X[3], pl.ROW_Y[3]),
}
keys = pl.key_layout()
print("count:", len(keys), OK if len(keys) == 14 else BAD)
for k in keys:
    want = spec_grid[k["id"]]
    got = (k["x"], k["y"])
    ok = abs(got[0] - want[0]) < 1e-9 and abs(got[1] - want[1]) < 1e-9
    if not ok or k["id"] == "voice":
        print(f"  {k['id']:12s} got {got} want {want} u={k['units']} {OK if ok else BAD}")
print("knob pos:", pl.KNOB_POS, OK if pl.KNOB_POS == (pl.COL_X[0], pl.ROW_Y[0]) else BAD)

# ------------------------------------------------------- 2. plate cutouts ----
sec("2. MX cutouts / plate thickness / webbing")
print("MX_CUT:", pl.MX_CUT, OK if pl.MX_CUT == 14.1 else BAD)
print("plate thickness:", pl.PLATE_Z1 - pl.PLATE_Z0,
      OK if abs((pl.PLATE_Z1 - pl.PLATE_Z0) - 1.5) < 1e-9 else BAD)
# cutouts full thickness in both bands?
prof_a = part_plate._plate_profile(part_plate.SCREW_D)
prof_b = part_plate._plate_profile(part_plate.CBORE_D)
for k in keys:
    pt = (k["x"], k["y"])
    ina = prof_a.contains(affinity.translate(box(-7, -7, 7, 7), *pt).centroid)
    inb = prof_b.contains(affinity.translate(box(-7, -7, 7, 7), *pt).centroid)
    if ina or inb:
        print("  cutout NOT through both bands at", k["id"], BAD)
web_1u = pl.PITCH - pl.MX_CUT
print(f"webbing between adjacent cutouts: {web_1u:.2f}", OK if web_1u >= 4.0 else BAD)
# knob hole to nearest cutout (preset1)
d_knob_cut = pl.PITCH - pl.KNOB_HOLE_D / 2 - pl.MX_CUT / 2
print(f"knob hole edge to preset1 cutout edge: {d_knob_cut:.2f}")
# min web to counterbore + tower at corners (r0c3 vs screw at (39,39))
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
      OK if worst[0] >= 0.8 else BAD)
knob_circle = affinity.translate(pl.circle(part_knob.KNOB_D), *pl.KNOB_POS)
dk = min((bases[i].distance(knob_circle), i) for i in ids)
print(f"knob(d17)->nearest cap gap: {dk[0]:.3f} ({dk[1]})", OK if dk[0] >= 0.8 else BAD)
# vertical travel clearance
clr = pl.CAP_Z0 - 4.0 - pl.PLATE_Z1
print(f"cap bottom after 4mm travel vs plate top: {clr:.2f}", OK if clr >= 1.2 else BAD)

# ------------------------------------------------------------- 4. EC11 ------
sec("4. EC11 knob/plate")
print("plate knob hole d:", pl.KNOB_HOLE_D, OK if pl.KNOB_HOLE_D == 7.4 else BAD)
print("bore profile:", part_knob.BORE_D, part_knob.BORE_FLAT,
      OK if (part_knob.BORE_D, part_knob.BORE_FLAT) == (6.1, 4.6) else BAD)
print("knob bottom vs plate top:", pl.KNOB_Z0 - pl.PLATE_Z1,
      OK if pl.KNOB_Z0 - pl.PLATE_Z1 > 0 else BAD)
# effective blind bore depth (ceiling slab starts at CEIL_Z0)
print(f"effective bore depth: {part_knob.CEIL_Z0:.1f} (spec 12.0, ceiling overlap eats 0.2)")
# M7 nut stack on plate top vs knob bottom (nut ~1.8-2.3 + washer)
gap = pl.KNOB_Z0 - pl.PLATE_Z1
print(f"gap under knob for M7 nut+washer: {gap:.2f} (typ nut stack ~2.0-2.5) "
      f"{'WARN nut collides / knob rides high' if gap < 2.0 else OK}")

# --------------------------------------------------- 5. skirt vs tray fit ----
sec("5. plate skirt vs tray (recompute)")
skirt = part_plate._skirt_profile()      # actual build profile (with notches)
skirt_out = pl.rounded_rect(part_plate.SKIRT_OUT_W, part_plate.SKIRT_OUT_W,
                            part_plate.SKIRT_OUT_R)
tray_in_thin = pl.rounded_rect(pl.CASE_W - 2 * part_tray.SKIRT_WALL,
                               pl.CASE_W - 2 * part_tray.SKIRT_WALL,
                               pl.CASE_R - part_tray.SKIRT_WALL)
# lateral gap skirt-outer -> tray-inner (sample boundary)
pts = [skirt_out.exterior.interpolate(t, normalized=True) for t in
       [i / 720 for i in range(720)]]
min_gap = min(tray_in_thin.exterior.distance(p) for p in pts)
print(f"skirt outer vs tray upper-inner: min gap {min_gap:.3f} per side "
      f"(SPEC text claims ~0.15; numbers give {(87.6 - 86.5) / 2:.3f} on the flats)")
# skirt vs corner bosses: XY overlap x Z overlap (need area 0, gap >= 0.3)
boss_zone = unary_union([affinity.translate(pl.circle(part_tray.BOSS_D), sx * 39, sy * 39)
                         for sx in (-1, 1) for sy in (-1, 1)])
inter = skirt.intersection(boss_zone)
boss_gap = skirt.distance(boss_zone)
z_lo = max(pl.LEDGE_Z, part_tray.BOSS_SOLID_TOP - part_tray.OVL)
z_hi = min(pl.PLATE_Z0 + 0.2, part_tray.BOSS_TOP)
print(f"skirt ∩ bosses XY area: {inter.area:.2f} mm^2, radial gap {boss_gap:.2f} "
      f"(boss band Z {z_lo:.1f}..{z_hi:.1f})  "
      f"{OK if inter.area < 0.01 and boss_gap >= 0.3 else BAD + ' INTERFERENCE'}")
if not inter.is_empty:
    for g in getattr(inter, "geoms", [inter]):
        b = g.bounds
        print(f"   lobe bounds x {b[0]:.2f}..{b[2]:.2f} y {b[1]:.2f}..{b[3]:.2f} area {g.area:.2f}")
# skirt must not stand behind the USB slot (plug corridor through the wall)
usb_corr = box(part_tray.USB_X - part_tray.USB_W / 2, 40.0,
               part_tray.USB_X + part_tray.USB_W / 2, 46.0)
blocked = skirt.intersection(usb_corr).area
print(f"skirt material inside USB plug corridor: {blocked:.2f} mm^2 "
      f"{OK if blocked < 0.01 else BAD + ' USB BLOCKED'}")
# towers vs tray wall
tower = affinity.translate(pl.circle(part_plate.TOWER_D), 39, 39)
print(f"tower vs tray thin-wall inner: gap {tray_in_thin.exterior.distance(tower):.3f} "
      f"(contained: {tray_in_thin.contains(tower)})")

# --------------------------------------------------------- 6. screw stack ----
SCREW_L = 8.0            # BOM: M3x8 button head (an M3x10 tip would land at
                         # Z4.7, 0.8 BELOW the boss bore floor -> bottoms out)
sec(f"6. screw stack (M3x{SCREW_L:.0f} button head)")
head_z = pl.PLATE_Z1 - part_plate.CBORE_DEPTH          # head bearing face
bore_floor = part_tray.BOSS_SOLID_TOP                  # boss bore floor
tip_z = head_z - SCREW_L
print(f"counterbore d{part_plate.CBORE_D} x {part_plate.CBORE_DEPTH} -> head at Z{head_z:.1f}")
print(f"3.4 channel: plate {pl.PLATE_Z0}->{head_z:.1f} + tower {part_plate.TOWER_Z0}->{pl.PLATE_Z0 + 0.2}")
print(f"boss bore d{part_tray.BORE_D} open {bore_floor}->{part_tray.BOSS_TOP} "
      f"(depth {part_tray.BOSS_TOP - bore_floor:.1f})")
print(f"M3x{SCREW_L:.0f} tip lands at Z{tip_z:.1f}; bore floor Z{bore_floor:.1f} -> "
      f"margin {tip_z - bore_floor:+.1f} mm "
      f"({'FAIL bottoms out' if tip_z < bore_floor else OK})")
print(f"insert zone top Z{part_tray.BOSS_TOP:.1f}; screw below head length {SCREW_L:.0f} "
      f"reaches insert: {OK if tip_z < part_tray.BOSS_TOP - 3 else BAD}")

# ------------------------------------------------------ 7. USB slot / dev ----
sec("7. USB slot vs ESP32-S3-DevKitC-1 (official V1.1 drawing)")
BOARD_W = 25.40
BOARD_L = 62.87
PORT_OFF = 7.79          # both USB ports' centers off board centerline (DXF)
SHELL_W_USB_C = 8.94     # USB-C shell; micro-B shell ~7.5
slot = (part_tray.USB_X - part_tray.USB_W / 2, part_tray.USB_X + part_tray.USB_W / 2)
for name, off, need in (("UART port (unused)", -PORT_OFF, False),
                        ("native USB port", +PORT_OFF, True)):
    lo, hi = off - SHELL_W_USB_C / 2, off + SHELL_W_USB_C / 2
    ov = max(0.0, min(hi, slot[1]) - max(lo, slot[0]))
    verdict = (OK if ov >= SHELL_W_USB_C else BAD) if need else "(info)"
    print(f"  {name}: shell {lo:+.2f}..{hi:+.2f} vs slot {slot[0]:+.2f}..{slot[1]:+.2f} "
          f"-> overlap {ov:.2f}/{SHELL_W_USB_C:.2f} mm {verdict}")
print(f"rail channel: {part_tray.RAIL_GAP:.1f} between inner faces vs board {BOARD_W} "
      f"-> rails are lateral guides; support pads carry the PCB at Z {part_tray.PAD_TOP}")
pad_lo, pad_hi = -part_tray.PAD_HALF_W, part_tray.PAD_HALF_W
print(f"pads span x {pad_lo:+.1f}..{pad_hi:+.1f} vs header insulators |x| >= 10.16: "
      f"{OK if part_tray.PAD_HALF_W <= 10.16 - 0.5 else BAD}")
for cfg, z_bot, need in (
        ("board on support pads (headerless/clipped, per BOM)", part_tray.PAD_TOP, True),
        ("board on floor — reference, no pads", pl.FLOOR, False),
        ("board on factory header pins (~8.5 under PCB) — forbidden by BOM", pl.FLOOR + 8.5, False)):
    usb_c = z_bot + 1.6 + 1.63
    inside = part_tray.USB_Z0 <= usb_c <= part_tray.USB_Z1
    verdict = (OK if inside else BAD) if need else f"(info: {'in' if inside else 'out of'} slot)"
    print(f"  {cfg}: USB centerline Z {usb_c:.2f} vs slot {part_tray.USB_Z0}..{part_tray.USB_Z1} "
          f"{verdict}")
half_span = pl.CASE_W / 2 - pl.WALL
print(f"length room: board {BOARD_L} (+~6 antenna overhang) vs clear span {2 * half_span:.1f}  "
      f"{OK if BOARD_L + 6 < 2 * half_span else BAD}")

# --------------------------------------------------------------- summary ----
print("\ndone.")
