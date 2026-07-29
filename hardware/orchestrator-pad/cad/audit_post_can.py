"""audit_post_can.py — v7 fatter/post-free probe (read-only): reversible board
bay seating, BOTH side USB apertures, speaker bay, under-plate stack, and the
ACCEPTANCE TABLE.

Expectations for the v7 taller base (+12 stack shift): tray 40.0 / ledge
33.5 / plate 40.0..41.5 / caps 47.0 / knob 42.5 / boss tops 31.5/37.5, the
ROTATED + REVERSIBLE board bay caged by FLAT features only — two side-wall
shelves + two mid-span ribs + a flat back guide rail + two flat front corner
tabs (NO cylindrical posts), all seating at BOARD_Z 16.0 — the TWO 26-wide
USB windows on the side walls (Z 17.0..23.5, now entirely BELOW the raised
ledge so the plate skirt has no USB notch), the down-firing speaker bay, a
flat zip-tie wire bar and the high mic grille. Mesh-level evidence uses
generalized-winding point sampling on the actual build() meshes. Exits
non-zero unless every check passes.

Component data (v7 hardware per SPEC):
  board: dual-USB-C ESP32-S3 clone, up to 64.0 (X) x 30.0 (Y) x 1.6, laid
    ALONG X and installed either way round —
        ports-right  X -22.0..+42.0        ports-left  X -42.0..+22.0
    underside Z 16.0 -> top 17.6; factory header pins DOWN (~8.5 under the
    PCB); header insulators ON TOP, 2.5 tall -> top 20.1; USB-C shells on
    TOP at the port edge, 8.94 w (in Y) x 3.3 h -> Z 17.6..20.9 (center
    19.25), overhanging the board edge ~1.31
  plug: overmold hood 12 w x 7 t on the port axis; ~2.5 of exposed shroud
    between hood front and receptacle face when fully mated
  speaker: flange <= 72 x 42 x 1.5 ON the floor; oval driver bump up to
    50(X) x 40(Y) x 11 tall -> bump top Z 14.9
  MX: plate top->housing base 5.0 -> base Z 36.5; center post + pins 3.3
    below base -> tips Z 33.2; post d4; pins (-3.81,+2.54),(+2.54,+5.08)
  EC11: body ~12 sq x 7.0 below the plate bottom -> Z 33.0; M7 panel nut
    ~11.5 across corners x 2.2, sits on the plate top.
"""
import sys

import numpy as np
from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union

import partlib as pl
import part_tray as pt
import part_plate as pp
import part_knob as pk
import part_caps as pc

BRD_W, BRD_L, BRD_T = pl.BOARD_W, pl.BOARD_L, 1.6   # 30 in Y, 64 in X
BRD_PORT_X = 42.0                              # port edge (ports-right)
BRD_FAR_X = BRD_PORT_X - BRD_L                 # -22.0 (far edge, ports-right)
BRD_TOP = pl.BOARD_Z + BRD_T                   # 17.6
INSUL_TOP = BRD_TOP + 2.5                      # 20.1
SHELL_W, SHELL_H = 8.94, 3.3
CONN_OVH = 1.31
HOOD_W, HOOD_H = 12.0, 7.0
SHROUD_EXPOSED = 2.5
PIN_TIP = pl.PLATE_Z1 - 8.3                    # 21.2
HOUS_BOT = pl.PLATE_Z1 - 5.0                   # 24.5
BUMP_TOP = pl.FLOOR + 1.5 + pl.SPK_BUMP_MAX    # 14.9
NUT_AF, NUT_H = 11.5, 2.2

FAILURES = []


def check(name, ok):
    FAILURES.extend([] if ok else [name])
    return "PASS" if ok else "FAIL"


def board_rect(sx):
    """Board footprint for sx=+1 (ports-right) / sx=-1 (ports-left)."""
    a, b = sx * BRD_PORT_X, sx * BRD_FAR_X
    return box(min(a, b), -BRD_W / 2, max(a, b), BRD_W / 2)


BRD_R, BRD_LF = board_rect(1), board_rect(-1)
BRD_ANY = BRD_R.union(BRD_LF)                  # x -42..42, |y| <= 15
ORIENTS = (("ports-right", 1, BRD_R), ("ports-left", -1, BRD_LF))


# ------------------------------------------------------------ winding ray ----
def winding_inside(mesh, pts, eps=1e-9):
    """Generalized winding via +Z ray: bool array 'inside any positive
    shell' (robust to the intended overlapping-shell construction)."""
    V, F = mesh._np()
    tri = V[F]
    ax, ay, az = tri[:, 0, 0], tri[:, 0, 1], tri[:, 0, 2]
    bx, by, bz = tri[:, 1, 0], tri[:, 1, 1], tri[:, 1, 2]
    cx, cy, cz = tri[:, 2, 0], tri[:, 2, 1], tri[:, 2, 2]
    area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    keep = np.abs(area2) > 1e-12
    ax, ay, az = ax[keep], ay[keep], az[keep]
    bx, by, bz = bx[keep], by[keep], bz[keep]
    cx, cy, cz = cx[keep], cy[keep], cz[keep]
    area2 = area2[keep]
    sgn = np.sign(area2).astype(np.int64)
    txmin = np.minimum(np.minimum(ax, bx), cx)
    txmax = np.maximum(np.maximum(ax, bx), cx)
    tymin = np.minimum(np.minimum(ay, by), cy)
    tymax = np.maximum(np.maximum(ay, by), cy)

    pts = np.asarray(pts, float)
    W = np.zeros(len(pts), np.int64)
    CH = 512
    for i0 in range(0, len(pts), CH):
        P = pts[i0:i0 + CH]
        pxmin, pxmax = P[:, 0].min(), P[:, 0].max()
        pymin, pymax = P[:, 1].min(), P[:, 1].max()
        m = (txmax >= pxmin) & (txmin <= pxmax) & (tymax >= pymin) & (tymin <= pymax)
        if not m.any():
            continue
        A2, S = area2[m][None, :], sgn[m][None, :]
        Ax, Ay, Az = ax[m][None, :], ay[m][None, :], az[m][None, :]
        Bx, By, Bz = bx[m][None, :], by[m][None, :], bz[m][None, :]
        Cx, Cy, Cz = cx[m][None, :], cy[m][None, :], cz[m][None, :]
        px, py, pz = P[:, 0][:, None], P[:, 1][:, None], P[:, 2][:, None]
        e0 = (Bx - Ax) * (py - Ay) - (By - Ay) * (px - Ax)
        e1 = (Cx - Bx) * (py - By) - (Cy - By) * (px - Bx)
        e2 = (Ax - Cx) * (py - Cy) - (Ay - Cy) * (px - Cx)
        inside2d = ((np.sign(e0) == S) | (np.abs(e0) < eps)) & \
                   ((np.sign(e1) == S) | (np.abs(e1) < eps)) & \
                   ((np.sign(e2) == S) | (np.abs(e2) < eps))
        zs = (e1 * Az + e2 * Bz + e0 * Cz) / A2
        crossed = inside2d & (zs > pz + 1e-7)
        W[i0:i0 + CH] += (crossed * S).sum(axis=1)
    return W >= 1


def grid_pts(x0, x1, y0, y1, zs, step=0.7):
    xs = np.arange(x0, x1 + 1e-9, step)
    ys = np.arange(y0, y1 + 1e-9, step)
    return np.array([(x, y, z) for x in xs for y in ys for z in zs])


tray_mesh = pt.build()[0][1]
plate_mesh = pp.build()[0][1]

print("=== A. reversible board bay: drop-in volume, seats, cage ===")
# the board slab volume must be free for BOTH installs -> sample the union
pts = grid_pts(-BRD_PORT_X + 0.05, BRD_PORT_X - 0.05, -BRD_W / 2 + 0.05,
               BRD_W / 2 - 0.05, (16.05, 16.8, 17.55), 1.1)
hit = winding_inside(tray_mesh, pts)
print(f"  board slab envelope (x ±{BRD_PORT_X}, y ±{BRD_W / 2}, z 16.05..17.55) "
      f"— covers ports-right AND ports-left: {int(hit.sum())}/{len(pts)} samples "
      f"inside tray {check('board volume free', hit.sum() == 0)}")
seat_ok, seat_n = True, 0
for sx in (-1, 1):
    xs = sorted([sx * (pt.SHELF_X0 + 0.1), sx * 42.55])
    sp = grid_pts(xs[0], xs[1], -pt.SHELF_Y + 0.3, pt.SHELF_Y - 0.3, (15.9,), 0.5)
    hs = winding_inside(tray_mesh, sp)
    seat_ok &= bool(hs.all())
    seat_n += len(sp)
    print(f"    {'right' if sx > 0 else 'left ':5s} shelf material at z 15.9: "
          f"{int(hs.sum())}/{len(sp)}")
rib_ok, rib_n = True, 0
for x0, x1 in pt.RIB_X:
    rp = grid_pts(x0 + 0.3, x1 - 0.3, pt.RIB_Y0 + 0.1, pt.RIB_Y1 - 0.1, (15.9,), 0.5)
    hr = winding_inside(tray_mesh, rp)
    rib_ok &= bool(hr.all())
    rib_n += len(rp)
print(f"    both ribs material at z 15.9 over {rib_n} samples: {rib_ok}")
print(f"  every seat present at BOARD_Z ({seat_n} shelf + {rib_n} rib samples) "
      f"{check('seats at BOARD_Z', seat_ok and rib_ok)}")
# FLAT board cage (v7): NO cylindrical posts — a back guide rail caps the +Y
# edge, two front corner tabs cap the -Y corners, inner faces at |y| = 15.1.
no_posts = not hasattr(pt, "POST_XY") and not hasattr(pt, "WPOST_XY")
rail2d = box(-pt.BACK_RAIL_XW, pt.CAGE_Y_IN, pt.BACK_RAIL_XW, pt.CAGE_Y_OUT)
tab_r = box(pt.TAB_X0, -pt.CAGE_Y_OUT, pt.TAB_X1, -pt.CAGE_Y_IN)
tab_l = box(-pt.TAB_X1, -pt.CAGE_Y_OUT, -pt.TAB_X0, -pt.CAGE_Y_IN)
cage2d = unary_union([rail2d, tab_r, tab_l])
cage_clr = pt.CAGE_Y_IN - BRD_W / 2
print(f"  flat cage (no posts: {no_posts}): back rail x ±{pt.BACK_RAIL_XW} + front tabs "
      f"x ±{pt.TAB_X0}..±{pt.TAB_X1}, inner faces |y|={pt.CAGE_Y_IN} -> {cage_clr:.2f}/side "
      f"vs board ±{BRD_W / 2}; tops {pt.CAGE_Z1} = board top {BRD_TOP:.1f} + "
      f"{pt.CAGE_Z1 - BRD_TOP:.1f} "
      f"{check('cage caps board', no_posts and abs(cage_clr - 0.1) < 1e-9 and pt.CAGE_Z1 - BRD_TOP >= 1.0)}")
# mesh evidence: rail material present at the +Y edge, both tabs at -Y corners
cage_pts = np.array([(0, 16.1, 10.0), (5, 16.1, 5.0),           # back rail
                     (38.4, -16.1, 10.0), (-38.4, -16.1, 10.0)]) # front tabs R/L
hc = winding_inside(tray_mesh, cage_pts)
print(f"    cage walls present (rail + 2 tabs): {int(hc.sum())}/4 "
      f"{check('cage walls present', hc.all())}")
for label, sx, rect in ORIENTS:
    x0, x1 = rect.bounds[0], rect.bounds[2]
    rail_over = x0 - 0.01 <= rail2d.bounds[0] and rail2d.bounds[2] <= x1 + 0.01
    tabs_over = sum(1 for t in (tab_r, tab_l)
                    if x0 - 0.01 <= t.bounds[0] and t.bounds[2] <= x1 + 0.01)
    print(f"    {label:11s} (x {x0:+.0f}..{x1:+.0f}): back rail over +Y edge {rail_over}, "
          f"{tabs_over} front tab(s) over a -Y corner "
          f"{check(f'{label} caged', rail_over and tabs_over >= 1)}")
# the under-board wiring bay: three clear pockets either side of the ribs.
# Exclude the intentional flat wire bar (x -38..-36, y 6..30, Z <= 8) — it is
# a feature IN the bay, not an obstruction to the board (8.0 below it).
bar_solid = lambda x, y, z: (pt.WBAR_X0 - 0.3 <= x <= pt.WBAR_X1 + 0.3
                             and pt.WBAR_Y0 - 0.3 <= y <= pt.WBAR_Y1 + 0.3
                             and z <= pt.WBAR_Z1 + 0.3)
bay_ok, bay_n, bay_hits = True, 0, 0
for x0, x1, tag in ((8.0, 39.5, "east"), (-39.5, -8.0, "west"), (-3.5, 3.5, "center")):
    bp = grid_pts(x0, x1, -14.5, 14.5, (2.45, 6.0, 9.5, 13.0, 15.95), 1.3)
    bp = np.array([p for p in bp if not bar_solid(*p)])   # skip the wire bar
    hb = winding_inside(tray_mesh, bp)
    bay_ok &= hb.sum() == 0
    bay_n += len(bp)
    bay_hits += int(hb.sum())
    print(f"    {tag:6s} pocket x {x0:+.1f}..{x1:+.1f}: {int(hb.sum())}/{len(bp)} inside")
print(f"  wiring bay under the board (floor->16.0 = {pl.BOARD_Z - pl.FLOOR:.1f}, wire bar "
      f"excluded): {bay_hits}/{bay_n} samples inside "
      f"{check('13.6 wiring bay open', bay_ok)}")

print("\n=== B. USB windows (BOTH side walls): aperture, band, plug ===")
win_open = True
for side, sx in (("right", 1), ("left", -1)):
    xs = sorted([sx * 42.65, sx * 44.95])
    pts = grid_pts(xs[0], xs[1], -pt.WIN_W / 2 + 0.05, pt.WIN_W / 2 - 0.05,
                   (17.05, 18.5, 20.25, 22.0, 23.45), 0.8)
    hit = winding_inside(tray_mesh, pts)
    win_open &= hit.sum() == 0
    print(f"  {side.upper():5s} aperture corridor (x {xs[0]:+.2f}..{xs[1]:+.2f}, y "
          f"±{pt.WIN_W / 2}, through both wall columns, z 17.05..23.45): "
          f"{int(hit.sum())}/{len(pts)} samples inside "
          f"{check(f'{side} window open through wall', hit.sum() == 0)}")
    edge = np.array([(sx * 44.4, 0, 16.95), (sx * 44.4, 0, 23.55),
                     (sx * 44.4, -13.05, 20.25), (sx * 44.4, 13.05, 20.25)])
    he = winding_inside(tray_mesh, edge)
    print(f"        wall present just outside its edges (sill/ceiling/jambs): "
          f"{int(he.sum())}/4 {check(f'{side} window edges exact', he.all())}")
shell_z0, shell_z1 = BRD_TOP, BRD_TOP + SHELL_H
print(f"  shell band z {shell_z0:.1f}..{shell_z1:.1f} (center "
      f"{(shell_z0 + shell_z1) / 2:.2f}) in window {pt.WIN_Z0}..{pt.WIN_Z1}: margins "
      f"{shell_z0 - pt.WIN_Z0:.1f}/{pt.WIN_Z1 - shell_z1:.1f} "
      f"{check('shell inside window band', shell_z0 - pt.WIN_Z0 >= 0.3 and pt.WIN_Z1 - shell_z1 >= 0.3)}")
shell_env = pt.WIN_W / 2 - SHELL_W / 2
print(f"  shell {SHELL_W} wide (in Y) stays inside the window for port offsets "
      f"|y| <= {shell_env:.2f} (spec needs 8.5) "
      f"{check('port offsets |y|<=8.5', shell_env >= 8.5)}")
recess = pl.CASE_W / 2 - (BRD_PORT_X + CONN_OVH)
print(f"  hood {HOOD_W:.0f}x{HOOD_H:.0f} vs aperture {pt.WIN_W:.0f}x"
      f"{pt.WIN_Z1 - pt.WIN_Z0:.1f}: width play {(pt.WIN_W - HOOD_W) / 2:.1f}/side "
      f"(port offsets to ±{pt.WIN_W / 2 - HOOD_W / 2:.1f}); receptacle recess "
      f"{recess:.2f} <= {SHROUD_EXPOSED} exposed shroud -> mates at the mouth "
      f"{check('plug hood passes aperture', HOOD_W <= pt.WIN_W - 2 and recess <= SHROUD_EXPOSED)}")
print(f"  the window on the unused side is an identical wire pass-through")
# v7: the plate skirt (Z 33.5..40.2) sits ENTIRELY above the window (Z ..23.5)
# and no longer needs a USB notch. Prove the plate has ZERO material in the
# window's Z-band in each side corridor (window unobstructed), while the skirt
# legitimately spans the corridor above the ledge (continuous, un-notched).
skirt_ok = True
for side, sx in (("right", 1), ("left", -1)):
    xs = sorted([sx * 42.55, sx * 43.6])
    win_band = grid_pts(xs[0], xs[1], -pt.WIN_W / 2 + 0.05, pt.WIN_W / 2 - 0.05,
                        (pt.WIN_Z0 + 1, 20.0, 22.0, pt.WIN_Z1 - 0.1), 0.8)
    skirt_band = grid_pts(xs[0], xs[1], -pt.WIN_W / 2 + 0.05, pt.WIN_W / 2 - 0.05,
                          (pl.LEDGE_Z + 0.5, 36.5, 39.0, pl.PLATE_Z0 + 0.1), 0.8)
    hw = winding_inside(plate_mesh, win_band)
    hs = winding_inside(plate_mesh, skirt_band)
    skirt_ok &= hw.sum() == 0 and hs.all()
    print(f"  {side} corridor: plate material in the window Z-band (..{pt.WIN_Z1}) "
          f"{int(hw.sum())}/{len(win_band)} (want 0); un-notched skirt present at "
          f"Z {pl.LEDGE_Z}+ {int(hs.sum())}/{len(skirt_band)} "
          f"{check(f'{side} skirt clears window (no notch)', hw.sum() == 0 and hs.all())}")

print("\n=== C. under-plate stack over the bay ===")
# headers run along the board's LONG edges — after the 90° turn, y = ±15
strips = unary_union([box(-BRD_PORT_X, BRD_W / 2 - 2.5, BRD_PORT_X, BRD_W / 2),
                      box(-BRD_PORT_X, -BRD_W / 2, BRD_PORT_X, -BRD_W / 2 + 2.5)])
over_b, over_s = [], []
for k in pl.key_layout():
    post = Point(k["x"], k["y"]).buffer(2.0, quad_segs=16)
    pins = [Point(k["x"] - 3.81, k["y"] + 2.54), Point(k["x"] + 2.54, k["y"] + 5.08)]
    if unary_union([post] + pins).intersects(BRD_ANY):
        over_b.append(k["id"])
    if any(strips.contains(p) for p in pins) or post.intersects(strips):
        over_s.append(k["id"])
clr_ins = PIN_TIP - INSUL_TOP
print(f"  switch lowest Z {PIN_TIP:.1f}; housings {HOUS_BOT:.1f}; board top "
      f"{BRD_TOP:.1f}; insulator top {INSUL_TOP:.1f}")
print(f"  keys over board (either orientation) {over_b}; over insulator strips {over_s}")
print(f"  pins vs insulators: {clr_ins:+.1f} (need >= 0.8) "
      f"{check('pins vs insulators', clr_ins >= 0.8)}")
print(f"  pins vs bare board: {PIN_TIP - BRD_TOP:+.1f} "
      f"{check('pins vs board', PIN_TIP - BRD_TOP >= 0.5)}")
print(f"  housings vs insulators: {HOUS_BOT - INSUL_TOP:+.1f} "
      f"{check('housings vs insulators', HOUS_BOT - INSUL_TOP >= 0.5)}")
ec_bot = pl.PLATE_Z0 - 7.0
ec_body = affinity.translate(box(-6.0, -6.0, 6.0, 6.0), *pl.KNOB_POS)
d_ec = ec_body.distance(BRD_ANY)
print(f"  EC11 body (12 sq, bottom Z {ec_bot:.1f}) at {pl.KNOB_POS[0]:.2f},"
      f"{pl.KNOB_POS[1]:.2f}: lateral gap to the board (either orientation) {d_ec:.2f} "
      f"{check('EC11 body clear of board', d_ec >= 0.5 or ec_bot - BRD_TOP >= 0.5)}")

print("\n=== D. speaker bay: grille, pilots, bump (mesh + analytics) ===")
slots = pt.spk_floor_opening()
slot_ok = True
for poly in pl._polys(slots):
    c = poly.representative_point()
    ppts = np.array([(c.x, c.y, z) for z in (0.1, 1.2, 2.3)]
                    + [(c.x + 6, c.y, 1.2), (c.x - 6, c.y, 1.2)])
    slot_ok &= not winding_inside(tray_mesh, ppts).any()
print(f"  3 grille slots open through both floor layers: "
      f"{check('slots open', slot_ok and len(pl._polys(slots)) == 3)}")
bar_pts = np.array([(0, -25.333, 1.2), (0, -16.667, 1.2), (0, -25.333, 0.1),
                    (0, -16.667, 2.3)])
hbar = winding_inside(tray_mesh, bar_pts)
print(f"  grille bars present (full floor thickness): {int(hbar.sum())}/4 "
      f"{check('grille bars', hbar.all())}")
pil_pts = np.array([(x, y, z) for x, y in pt.SPK_PILOT_XY for z in (0.1, 1.2, 2.3)])
hpil = winding_inside(tray_mesh, pil_pts)
print(f"  pilot bores open through the floor: {int(hpil.sum())}/{len(pil_pts)} "
      f"{check('pilots open', hpil.sum() == 0)}")
feet_pts = np.array([(sx * 36, sy * 36, 0.3) for sx in (-1, 1) for sy in (-1, 1)]
                    + [(sx * 36, sy * 36, 0.75) for sx in (-1, 1) for sy in (-1, 1)])
hf = winding_inside(tray_mesh, feet_pts)
print(f"  feet recesses: open below 0.6 ({int(hf[:4].sum())}/4 hits), ceiling "
      f"intact above ({int(hf[4:].sum())}/4 hits) "
      f"{check('feet-recess layers intact', hf[:4].sum() == 0 and hf[4:].all())}")
print(f"  bump top {BUMP_TOP:.1f} vs board underside {pl.BOARD_Z:.1f}: "
      f"{pl.BOARD_Z - BUMP_TOP:+.1f} (need >= 1.0) "
      f"{check('bump vs board underside', pl.BOARD_Z - BUMP_TOP >= 1.0)}")
bump = affinity.translate(affinity.scale(pl.circle(2.0), 25.0, 20.0), *pl.SPK_CENTER)
ribs2d = unary_union([box(x0, pt.RIB_Y0, x1, pt.RIB_Y1) for x0, x1 in pt.RIB_X])
wbar2d = box(pt.WBAR_X0, pt.WBAR_Y0, pt.WBAR_X1, pt.WBAR_Y1)
ridges2d = pt.amp_ridges()
shelves2d = unary_union([box(min(sx * pt.SHELF_X0, sx * pt.SHELF_X1), -pt.SHELF_Y,
                             max(sx * pt.SHELF_X0, sx * pt.SHELF_X1), pt.SHELF_Y)
                         for sx in (-1, 1)])
print(f"  oval bump (<=50x40) vs mid-span ribs: plan gap {bump.distance(ribs2d):.2f} "
      f"{check('bump clears ribs', bump.distance(ribs2d) >= 2.0)}")
# v7: NO board-cage or wire-bar feature may land inside the speaker flange
# footprint. Each clearance is printed; the two front tabs sit at |X| >= 36.8
# and must clear by >= 0.5 (the tightest board-cage clearance to the flange).
FLANGE_MIN, TAB_FLANGE_MIN = 0.4, 0.5
flange2d = box(-pl.SPK_FLANGE[0] / 2, pl.SPK_CENTER[1] - pl.SPK_FLANGE[1] / 2,
               pl.SPK_FLANGE[0] / 2, pl.SPK_CENTER[1] + pl.SPK_FLANGE[1] / 2)
flange_ok = True
print(f"  flange footprint x ±{pl.SPK_FLANGE[0] / 2:.0f}, y {flange2d.bounds[1]:.0f}.."
      f"{flange2d.bounds[3]:.0f} — bay features must stay out (tabs >= {TAB_FLANGE_MIN}, "
      f"else >= {FLANGE_MIN}):")
for fname, geom, mn in (("mid-span ribs", ribs2d, FLANGE_MIN),
                        ("back guide rail", rail2d, FLANGE_MIN),
                        ("front tab (R)", tab_r, TAB_FLANGE_MIN),
                        ("front tab (L)", tab_l, TAB_FLANGE_MIN),
                        ("amp ridges", ridges2d, FLANGE_MIN),
                        ("wire bar", wbar2d, FLANGE_MIN),
                        ("board shelves", shelves2d, FLANGE_MIN)):
    ov, d = geom.intersection(flange2d).area, geom.distance(flange2d)
    flange_ok &= ov < 1e-6 and d >= mn
    print(f"    {fname:16s} overlap {ov:.3f} mm^2, clearance {d:.2f} (need >= {mn})")
print(f"  no bay feature intersects the speaker flange "
      f"{check('bay features clear the flange', flange_ok)}")
tip_below = 6.0 - 1.5 - pl.FLOOR
print(f"  M2.5x6 tips {tip_below:.1f} under the floor; >=3mm feet stand the case "
      f"{3.0 - pt.FEET_DEPTH:.1f} off the desk -> {3.0 - pt.FEET_DEPTH - tip_below:.1f} "
      f"ground clearance {check('screw tips in foot gap', 3.0 - pt.FEET_DEPTH - tip_below >= 0.2)}")

print("\n=== E. amp pocket / wire bar / mic grille (mesh) ===")
# v7: the locator posts are GONE, so the amp pocket is a clean, full 20x20.
# Sample the whole pocket interior above the floor (must be empty) and prove
# the corner ridges are present.
pk_pts = grid_pts(pt.AMP_C[0] - 9.95, pt.AMP_C[0] + 9.95, pt.AMP_C[1] - 9.95,
                  pt.AMP_C[1] + 9.95, (2.45, 3.3, 4.35), 1.0)
hpk = winding_inside(tray_mesh, pk_pts)
rr = pt.AMP_POCKET / 2 + pt.AMP_RIDGE_W / 2                 # 10.75 — ridge mid
ridge_pts = np.array([(pt.AMP_C[0] + sx * rr, pt.AMP_C[1] + sy * rr, 3.3)
                      for sx in (-1, 1) for sy in (-1, 1)])
hr = winding_inside(tray_mesh, ridge_pts)
print(f"  20x20 pocket at {pt.AMP_C} interior free above the floor: "
      f"{int(hpk.sum())}/{len(pk_pts)}; corner ridges present {int(hr.sum())}/4 "
      f"{check('amp pocket', hpk.sum() == 0 and hr.all())}")
print(f"    post-free full 20x20 pocket (no locator post clips it now); "
      f"MAX98357A breakout ~18 x 16 fits with 1.0/side "
      f"{check('amp module fits pocket', pt.AMP_POCKET >= 18.0)}")
for label, sx, rect in ORIENTS:
    ov, d = ridges2d.intersection(rect).area, ridges2d.distance(rect)
    print(f"    amp ridges vs {label:11s} board footprint: overlap {ov:.3f} mm^2, "
          f"clearance {d:.2f} "
          f"{check(f'amp not under board ({label})', ov < 1e-6 and d >= 0.4)}")
# Wire BAR (v7): flat wall x -38..-36, y 6..30, Z 2.2..8, with two zip-tie
# through-slots (Z 3..5) cut in X. xc = bar center.
xc = (pt.WBAR_X0 + pt.WBAR_X1) / 2
wb_ok = True
open_pts = np.array([(xc, y, 4.0) for y in pt.WSLOT_YS])            # inside 2 slots
solid_pts = np.array([(xc, pt.WBAR_Y0 + 2.0, 4.0),                  # bar segments at
                      (xc, sum(pt.WSLOT_YS) / 2, 4.0),              #   slot Z (non-slot Y)
                      (xc, pt.WBAR_Y1 - 2.0, 4.0),
                      (xc, pt.WSLOT_YS[0], pt.WSLOT_Z0 - 0.4),      # shaft below a slot
                      (xc, pt.WSLOT_YS[0], pt.WSLOT_Z1 + 0.5),      # shaft above a slot
                      (xc, pt.WSLOT_YS[1], pt.WBAR_Z1 - 0.5)])      # shaft below the top
top_pts = np.array([(xc, y, pt.WBAR_Z1 + 0.5) for y in pt.WSLOT_YS])  # above the bar top
wb_ok &= not winding_inside(tray_mesh, open_pts).any()
wb_ok &= winding_inside(tray_mesh, solid_pts).all()
wb_ok &= not winding_inside(tray_mesh, top_pts).any()
print(f"  wire bar x {pt.WBAR_X0}..{pt.WBAR_X1}, y {pt.WBAR_Y0}..{pt.WBAR_Y1}: 2 zip-tie "
      f"slots open through, segments + shaft solid, top at {pt.WBAR_Z1} "
      f"{check('wire bar', wb_ok)}")
left_corr = box(-46.0, -pt.WIN_W / 2, -40.0, pt.WIN_W / 2)
under_gap = pl.BOARD_Z - pt.WBAR_Z1
for label, sx, rect in ORIENTS:
    ov = wbar2d.intersection(rect).area
    print(f"    wire bar vs {label:11s} board footprint: plan overlap {ov:.1f} mm^2, but "
          f"top {pt.WBAR_Z1} is {under_gap:.1f} below the board underside {pl.BOARD_Z} "
          f"{check(f'wire bar clears board ({label})', under_gap >= 1.0)}")
print(f"    wire bar vs the LEFT window corridor (y ±{pt.WIN_W / 2:.0f}, Z 17+): "
      f"{wbar2d.distance(left_corr):.2f} (bar tops at Z {pt.WBAR_Z1}); vs the (-39,+39) boss: "
      f"{wbar2d.distance(Point(-39, 39).buffer(pt.BOSS_D / 2)):.2f} "
      f"{check('wire bar clear window + boss', wbar2d.distance(Point(-39, 39).buffer(pt.BOSS_D / 2)) >= 0.5)}")
mic_ok = True
for x in pt.MIC_XS:
    open_pts = np.array([(x, -44.4, 20.15), (x, -42.75, 20.15), (x, -44.9, 20.15)])
    mic_ok &= not winding_inside(tray_mesh, open_pts).any()
edge_pts = np.array([(-20, -44.4, 19.3), (-20, -44.4, 21.0),
                     (-14.9, -44.4, 20.15), (-25.1, -44.4, 20.15)])
mic_ok &= winding_inside(tray_mesh, edge_pts).all()
print(f"  mic ports open through both columns, walls exact around them "
      f"{check('mic grille', mic_ok)}")
print(f"  mic grille ceiling {pt.MIC_Z1} vs ledge {pl.LEDGE_Z}: "
      f"{pl.LEDGE_Z - pt.MIC_Z1:.1f} below "
      f"{check('mic below ledge', pl.LEDGE_Z - pt.MIC_Z1 >= 0.5)}")

print("\n=== F. skirt fit / screw stack / EC11 (constants + 2D + mesh) ===")
skirt = pp._skirt_profile()
bosses = unary_union([affinity.translate(pl.circle(pt.BOSS_D), sx * 39, sy * 39)
                      for sx in (-1, 1) for sy in (-1, 1)])
inter = skirt.intersection(bosses).area
gap_boss = skirt.distance(bosses)
lat = (pl.CASE_W - 2 * pt.SKIRT_WALL - pp.SKIRT_OUT_W) / 2
print(f"  skirt ∩ bosses area {inter:.3f} mm^2, radial gap {gap_boss:.2f} "
      f"{check('skirt/boss', inter < 0.01 and gap_boss >= 0.3)}")
print(f"  skirt-tray lateral gap {lat:.3f}/side "
      f"{check('skirt lateral ~0.15', 0.10 <= lat <= 0.25)}")
sk_xy = []
for poly in pl._polys(skirt):
    x0, y0, x1, y1 = poly.bounds
    for x in np.arange(x0 + 0.15, x1, 0.3):
        for y in np.arange(y0 + 0.15, y1, 0.3):
            if poly.contains(Point(x, y)):
                sk_xy.append((x + 0.013, y + 0.013))
zsk = [33.65, 35.0, 36.5, 38.0, 39.5, 40.1]       # v7 skirt band 33.5..40.2
pts = np.array([(x, y, z) for x, y in sk_xy for z in zsk])
hit = winding_inside(tray_mesh, pts)
print(f"  skirt volume samples inside TRAY mesh: {int(hit.sum())}/{len(pts)} "
      f"{check('skirt vs tray mesh', hit.sum() == 0)}")

head_z = pl.PLATE_Z1 - pp.CBORE_DEPTH             # 40.7 (v7)
tip_z = head_z - 8.0                              # 32.7 (M3x8)
floor_z = pt.BOSS_SOLID_TOP                       # 31.5 (v7)
print(f"  M3x8: head Z {head_z:.1f}, tip Z {tip_z:.1f}, bore floor Z "
      f"{floor_z:.1f} (margin {tip_z - floor_z:+.1f}), insert zone top "
      f"{pt.BOSS_TOP:.1f} {check('screw stack', tip_z >= floor_z and tip_z <= pt.BOSS_TOP - 3)}")

# mock snap-fit knob (no potentiometer): peg spins in the hole, barb retains
barb_ledge = pl.KNOB_Z0 + pk.LEDGE_Z             # 39.8
play = pl.PLATE_Z0 - barb_ledge                  # 0.2 axial play
print(f"  mock knob: peg Ø{pk.PEG_D} < hole Ø{pl.KNOB_HOLE_D} (spins), "
      f"barb Ø{pk.BARB_D} > hole (snaps), rests on plate top {pl.PLATE_Z1}, "
      f"barb ledge Z {barb_ledge:.1f} vs plate bottom {pl.PLATE_Z0} (play {play:.1f}) "
      f"{check('mock knob clips + spins', pk.PEG_D < pl.KNOB_HOLE_D and pk.BARB_D > pl.KNOB_HOLE_D + 0.3 and pl.KNOB_Z0 == pl.PLATE_Z1 and 0.0 <= play <= 0.6)}")

print("\n=== G. watertight (every mesh) ===")
wt_all = True
for name, mesh, _c in ([("tray", tray_mesh, None), ("plate", plate_mesh, None)]
                       + [(n, m, c) for n, m, c in pc.build()]
                       + pk.build()):
    rep = pl.validate(mesh)
    wt_all &= rep["watertight"]
    if not rep["watertight"]:
        print(f"  NOT WATERTIGHT: {name} {rep['problems'][:3]}")
print(f"  tray + plate + 14 caps (+legends) + knob watertight: "
      f"{check('all meshes watertight', wt_all)}")

# ---------------------------------------------------------------- table ----
W = 66
print("\n" + "=" * (W + 10))
print("ACCEPTANCE TABLE (v7 fatter, post-free — reversible board bay)")
print("=" * (W + 10))
rows = [
    (f"switch lowest Z {PIN_TIP:.1f} vs header insulator top {INSUL_TOP:.1f} "
     f"(clr {clr_ins:.1f}, need >=0.8)", clr_ins >= 0.8),
    (f"speaker bump top {BUMP_TOP:.1f} vs board underside {pl.BOARD_Z:.1f} "
     f"(clr {pl.BOARD_Z - BUMP_TOP:.1f}, need >=1.0)",
     pl.BOARD_Z - BUMP_TOP >= 1.0),
    (f"USB windows 26x6.5 @ Z {pt.WIN_Z0}..{pt.WIN_Z1} on BOTH side walls: both "
     f"apertures open, shell band inside, hood mates (recess {recess:.2f})",
     win_open and shell_z0 - pt.WIN_Z0 >= 0.3 and recess <= SHROUD_EXPOSED),
    (f"reversible bay: slab free x ±{BRD_PORT_X:.0f}, dual shelves + 2 ribs seat "
     f"@16.0, FLAT cage (rail + 2 tabs, NO posts) caps {cage_clr:.2f}/side, 13.6 "
     f"wiring bay open",
     not [f for f in FAILURES if f in (
         'board volume free', 'seats at BOARD_Z', 'cage caps board',
         'cage walls present', '13.6 wiring bay open',
         'ports-right caged', 'ports-left caged')]),
    ("board installs ports-right (x -22..+42) OR ports-left (x -42..+22); the "
     "unused side window is a wire pass-through",
     not [f for f in FAILURES if f in (
         'right window open through wall', 'left window open through wall',
         'right window edges exact', 'left window edges exact')]),
    (f"skirt ∩ bosses {inter:.2f} mm^2 (gap {gap_boss:.2f}); lateral {lat:.2f}/side; "
     f"USB windows sit below the ledge -> skirt un-notched, Z-clear",
     inter < 0.01 and gap_boss >= 0.3 and 0.10 <= lat <= 0.25
     and not [f for f in FAILURES if f in (
         'right skirt clears window (no notch)', 'left skirt clears window (no notch)')]),
    (f"no bay feature intersects the speaker flange (x ±36, y -42..0); tightest "
     f"is the two front tabs at |X|=36.8 with 0.80 clear", flange_ok),
    (f"amp pocket @ {pt.AMP_C} (full 20x20) + wire bar @ x {pt.WBAR_X0}..{pt.WBAR_X1} "
     f"sit clear of the board in BOTH orientations",
     not [f for f in FAILURES if f.startswith(('amp not under board',
                                               'wire bar clears board'))
          or f in ('wire bar clear window + boss', 'amp module fits pocket',
                   'wire bar')]),
    (f"M3x8 stack: head {head_z:.1f} / tip {tip_z:.1f} / bore floor {floor_z:.1f} "
     f"(margin {tip_z - floor_z:+.1f}, insert top {pt.BOSS_TOP:.1f})",
     tip_z >= floor_z and tip_z <= pt.BOSS_TOP - 3),
    (f"mock knob clips into the Ø{pl.KNOB_HOLE_D} plate hole + spins (peg "
     f"Ø{pk.PEG_D}/barb Ø{pk.BARB_D}, {play:.1f} play); body clear of board "
     f"(lateral {d_ec:.1f})",
     (d_ec >= 0.5) and pk.PEG_D < pl.KNOB_HOLE_D and pk.BARB_D > pl.KNOB_HOLE_D + 0.3
     and pl.KNOB_Z0 == pl.PLATE_Z1 and 0.0 <= play <= 0.6),
    ("speaker floor: slots+pilots open, grille bars + feet-recess layers intact",
     not [f for f in FAILURES if f in (
         'slots open', 'grille bars', 'pilots open', 'feet-recess layers intact')]),
    ("every mesh watertight", wt_all),
]
for text, ok in rows:
    print(f"  {'PASS' if ok else 'FAIL'}  {text}")
print("=" * (W + 10))
print(f"POST-CAN AUDIT: {len(FAILURES)} failure(s) "
      + (f"-> {FAILURES}" if FAILURES else "-> ALL CLEAR"))
sys.exit(1 if FAILURES else 0)
