"""audit_recheck.py — RE-AUDIT probe (read-only, throwaway).

1. mesh-level tray∧plate interference via generalized winding number (z-ray),
   sampled on the plate's skirt/tower domains against the ACTUAL tray mesh
   (robust to the intended overlapping-shell construction).
2. 2D fusion coverage: every skirt segment / tower ring must sit under solid
   plate band-A material (the 0.2 Z-lap only fuses if XY overlaps too).
3. skirt fragment inventory (sliver widths after the boss/USB notches).
4. real-component stack: MX switch under-plate envelope vs the DevKitC-1
   raised on the new support pads (board top Z 7.0):
     Cherry MX (datasheet): plate-top->housing-base 5.0 (=3.5 below plate
     underside); pins/post extend 3.3 below the base (=8.3 below plate top).
     -> housing bottoms Z 10.5, pin tips Z 7.2 (plate underside 14.0).
     ESP32-S3-WROOM-1 module: 18.0 x 25.5 x 3.1 tall; shield can on-board.
     DevKitC-1: PCB 25.4 x 62.87 x 1.6; USB shells 8.94w x 3.26h overhang the
     back edge ~1.31; ports +-7.79 off center.
5. board Y seating: UART connector vs solid back wall; free Y travel; USB
   plug recess arithmetic.
6. reset pinhole + mic flush-mount vs skirt; knob/EC11 stack.
"""
from __future__ import annotations

import numpy as np
from shapely import affinity
from shapely.geometry import box, Point
from shapely.ops import unary_union

import partlib as pl
import part_tray as pt
import part_plate as pp
import part_knob as pk

OK, BAD = "PASS", "FAIL"


def sec(t):
    print(f"\n=== {t} ===")


# ------------------------------------------------------------ winding ray ----
def winding_inside(mesh, pts, eps=1e-9):
    """Generalized winding via +Z ray: returns bool array 'inside any positive
    shell' (sum of signed crossings above the point >= 1). Robust to the
    intended overlapping shells (overlap counts 2, still inside)."""
    V, F = mesh._np()
    tri = V[F]
    ax, ay, az = tri[:, 0, 0], tri[:, 0, 1], tri[:, 0, 2]
    bx, by, bz = tri[:, 1, 0], tri[:, 1, 1], tri[:, 1, 2]
    cx, cy, cz = tri[:, 2, 0], tri[:, 2, 1], tri[:, 2, 2]
    area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    keep = np.abs(area2) > 1e-12                       # drop z-vertical walls
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
        e0 = (Bx - Ax) * (py - Ay) - (By - Ay) * (px - Ax)   # weight of C
        e1 = (Cx - Bx) * (py - By) - (Cy - By) * (px - Bx)   # weight of A
        e2 = (Ax - Cx) * (py - Cy) - (Ay - Cy) * (px - Cx)   # weight of B
        inside2d = ((np.sign(e0) == S) | (np.abs(e0) < eps)) & \
                   ((np.sign(e1) == S) | (np.abs(e1) < eps)) & \
                   ((np.sign(e2) == S) | (np.abs(e2) < eps))
        zs = (e1 * Az + e2 * Bz + e0 * Cz) / A2
        crossed = inside2d & (zs > pz + 1e-7)
        W[i0:i0 + CH] += (crossed * S).sum(axis=1)
    return W >= 1


def grid_in(polys, step, jit=0.013):
    """Sample points inside a (Multi)Polygon on a jittered grid."""
    out = []
    for poly in pl._polys(polys):
        x0, y0, x1, y1 = poly.bounds
        xs = np.arange(x0 + step / 2, x1, step)
        ys = np.arange(y0 + step / 2, y1, step)
        for x in xs:
            for y in ys:
                if poly.contains(Point(x, y)):
                    out.append((x + jit, y + jit))
    return out


tray_mesh = pt.build()[0][1]
plate_mesh = pp.build()[0][1]

sec("0. raycast sanity")
probe = np.array([
    (0.0, 0.0, 1.2),        # tray floor          -> True
    (39.0, 39.0, 4.0),      # boss pedestal        -> True
    (0.0, 44.4, 12.0),      # thin wall band       -> True
    (0.0, 0.0, 20.0),       # air                  -> False
    (42.7, 0.013, 10.0),    # skirt band (plate)   -> plate True / tray False
])
t_in = winding_inside(tray_mesh, probe)
p_in = winding_inside(plate_mesh, probe)
print("tray :", t_in.tolist(), OK if t_in.tolist() == [True, True, True, False, False] else BAD)
print("plate:", p_in.tolist(), OK if p_in.tolist() == [False, False, False, False, True] else BAD)

sec("1. mesh interference: plate skirt/tower domains vs ACTUAL tray mesh")
skirt = pp._skirt_profile()
sk_xy = grid_in(skirt, 0.30)
zs = [7.65, 8.5, 10.0, 11.2, 11.8, 13.2, 13.85]
pts = np.array([(x, y, z) for x, y in sk_xy for z in zs])
hit = winding_inside(tray_mesh, pts)
print(f"skirt samples: {len(pts)}  inside-tray: {int(hit.sum())} "
      f"{OK if hit.sum() == 0 else BAD}")
if hit.any():
    bad = pts[hit]
    print("   e.g.", bad[:6].round(2).tolist())

tow = []
for cx0, cy0 in pp._screw_centers():
    for r in np.arange(1.85, 3.75, 0.3):
        for a in np.arange(0, 2 * np.pi, np.pi / 18):
            tow.append((cx0 + r * np.cos(a) + 0.013, cy0 + r * np.sin(a) + 0.013))
pts_t = np.array([(x, y, z) for x, y in tow for z in (11.65, 12.5, 13.8)])
hit_t = winding_inside(tray_mesh, pts_t)
print(f"tower samples: {len(pts_t)}  inside-tray: {int(hit_t.sum())} "
      f"{OK if hit_t.sum() == 0 else BAD}")

# reverse: tray boss ring under plate towers (should stop below 11.5)
boss_pts = []
for cx0, cy0 in pp._screw_centers():
    for r in np.arange(2.2, 3.4, 0.4):
        for a in np.arange(0, 2 * np.pi, np.pi / 12):
            boss_pts.append((cx0 + r * np.cos(a) + 0.013, cy0 + r * np.sin(a) + 0.013))
pts_b = np.array([(x, y, z) for x, y in boss_pts for z in (10.6, 11.35)])
hit_b = winding_inside(plate_mesh, pts_b)
print(f"boss-ring samples below 11.5: {len(pts_b)}  inside-plate: {int(hit_b.sum())} "
      f"{OK if hit_b.sum() == 0 else BAD}")

sec("2. fusion coverage (XY): skirt segments & tower rings under plate band A")
bandA = pp._plate_profile(pp.SCREW_D)
left_sk = skirt.difference(bandA)
print(f"skirt area outside band-A solid: {left_sk.area:.4f} mm^2 "
      f"{OK if left_sk.area < 1e-6 else BAD}")
tow_ring = unary_union([
    affinity.translate(pl.circle(pp.TOWER_D), x, y).difference(
        affinity.translate(pl.circle(pp.SCREW_D), x, y))
    for x, y in pp._screw_centers()])
left_tw = tow_ring.difference(bandA)
print(f"tower-ring area outside band-A solid: {left_tw.area:.4f} mm^2 "
      f"{OK if left_tw.area < 1e-6 else BAD}")

sec("3. skirt fragments after notches")
frags = pl._polys(skirt)
print(f"segments: {len(frags)}")
for i, f in enumerate(frags):
    b = f.bounds
    # min feature width probe: how much negative buffer kills it
    w = 0.0
    for t in np.arange(0.05, 0.7, 0.05):
        if f.buffer(-t).is_empty:
            w = 2 * t
            break
    print(f"  seg{i}: area {f.area:7.2f}  bbox x {b[0]:6.2f}..{b[2]:6.2f} "
          f"y {b[1]:6.2f}..{b[3]:6.2f}  min-width<= {w:.2f}")

sec("4. MX switch under-plate envelope vs DevKitC on pads (REAL components)")
PLATE_BOT = pl.PLATE_Z0                      # 14.0
HOUS_BOT = pl.PLATE_Z1 - 5.0                 # 10.5  (Cherry MX: plate top -> base 5.0)
PIN_TIP = pl.PLATE_Z1 - 8.3                  # 7.2   (pins/post 3.3 below base)
BRD_W, BRD_L, BRD_T = 25.4, 62.87, 1.6
BRD_BOT = pt.PAD_TOP                         # 5.4 on the new pads
BRD_TOP = BRD_BOT + BRD_T                    # 7.0
CAN_TOP = BRD_TOP + 3.1                      # 10.1 WROOM-1 module height
WALL_IN_THICK = pl.CASE_W / 2 - pl.WALL      # 42.6
CONN_OVH = 1.31
board_back = WALL_IN_THICK                   # best case: edge on wall face
board_front = board_back - BRD_L             # -20.27
board_poly = box(-BRD_W / 2, board_front, BRD_W / 2, board_back)
# module shield can on-board footprint, both antenna scenarios
can_s1 = box(-9.0, board_front, 9.0, board_front + 25.5 - 6.3)   # antenna overhangs
can_s2 = box(-9.0, board_front + 6.3, 9.0, board_front + 25.5)   # antenna on-board
print(f"board top Z {BRD_TOP:.2f} | module can top Z {CAN_TOP:.2f} | "
      f"switch housings Z {HOUS_BOT:.2f} | pin tips Z {PIN_TIP:.2f}")
print(f"pin-tip vs bare board top : {PIN_TIP - BRD_TOP:+.2f} mm")
print(f"pin-tip vs module can top : {PIN_TIP - CAN_TOP:+.2f} mm")
print(f"housing  vs module can top: {HOUS_BOT - CAN_TOP:+.2f} mm")
# per-switch: pins at (-3.81,+2.54) and (+2.54,+5.08) rel center (Cherry MX,
# north orientation); check 0/90/180/270 rotations.
PINS = [(-3.81, 2.54), (2.54, 5.08)]
rots = {0: lambda x, y: (x, y), 90: lambda x, y: (-y, x),
        180: lambda x, y: (-x, -y), 270: lambda x, y: (y, -x)}
print(f"{'key':12s} {'hous^board':>10s} {'hous^can(s1/s2)':>16s}  pin-on-can orientations")
for k in pl.key_layout():
    hous = box(k["x"] - 7, k["y"] - 7, k["x"] + 7, k["y"] + 7)
    ob = hous.intersection(board_poly).area
    oc1 = hous.intersection(can_s1).area
    oc2 = hous.intersection(can_s2).area
    bad_rots = []
    for deg, f in rots.items():
        for px, py in PINS:
            dx, dy = f(px, py)
            p = Point(k["x"] + dx, k["y"] + dy)
            if can_s1.contains(p) or can_s2.contains(p):
                bad_rots.append(deg)
                break
    if ob > 0 or oc1 > 0 or oc2 > 0:
        flag = BAD + " pins hit can" if bad_rots and (oc1 > 0 or oc2 > 0) else \
               ("clash-can(hous)" if (oc1 > 0 or oc2 > 0) and HOUS_BOT < CAN_TOP else "over board")
        print(f"  {k['id']:10s} {ob:10.1f} {oc1:7.1f}/{oc2:7.1f}  {bad_rots} {flag}")

sec("5. board Y seating / USB reach (REAL connector geometry)")
print(f"back wall: outer 45.0, inner {WALL_IN_THICK} (z<7.5) / 43.8 (z>=7.5)")
print(f"UART connector shell x -12.26..-3.32, overhang {CONN_OVH}; "
      f"slot only at x {pt.USB_X - pt.USB_W / 2:.2f}..{pt.USB_X + pt.USB_W / 2:.2f}")
print(f"-> UART nose hits SOLID thick wall at 42.6 (its z 7.0..7.5 band) => "
      f"board stops {CONN_OVH} mm short of the wall")
board_back_real = WALL_IN_THICK - CONN_OVH
native_nose = board_back_real + CONN_OVH     # = 42.6
recess = 45.0 - native_nose
print(f"board back edge max {board_back_real:.2f}; native nose Z... y {native_nose:.2f}; "
      f"USB-C plug recess behind outer face: {recess:.2f} mm "
      f"({BAD + ' unmatable (max usable ~1.0-1.5)' if recess > 1.6 else 'marginal'})")
# what if UART had its own relief: board on wall, nose 1.31 into a relief
print(f"with UART relief: board edge 42.60, native nose 43.91, recess 1.09 (cable-marginal)")
# Y retention inventory
print("Y-stops for the board (x<=12.7 corridor):",
      "back wall 42.6 only; rails are lateral; pads are pedestals ->",
      f"free forward travel {42.6 - CONN_OVH - BRD_L - (-42.6):.1f} mm; "
      "USB insertion force (5-20 N) >> board friction => board slides away, no mate")

sec("6. reset pinhole / mic / knob stack")
reset_corr = box(41.5, pt.RESET_Y - 0.75, 44.5, pt.RESET_Y + 0.75)
blk = skirt.intersection(reset_corr).area
print(f"skirt in reset-pin corridor (z>=7.5): {blk:.2f} mm^2 "
      f"(pinhole z 7.25..8.75 -> blocked above 7.5: {'yes' if blk > 0 else 'no'})")
print("  note: DevKitC RST/BOOT buttons face UP at the back edge; a side pin at "
      "y=20 z=8 aims at the bare board edge — cannot actuate any button anyway")
mic_zone = box(-7.0, -43.25, 7.0, -42.1)
print(f"skirt in INMP441 flush-mount zone (front wall, |x|<=7): "
      f"{skirt.intersection(mic_zone).area:.2f} mm^2 (module on inner wall face "
      f"crosses z7.5 -> hits skirt unless notched or mounted low/angled)")
shaft_tip = 14.0 + 15.0                      # EC11 L15, mounting face = plate underside
bore_ceil = pl.KNOB_Z0 + pk.CEIL_Z0
print(f"EC11 L15 shaft tip Z {shaft_tip:.1f} vs knob bore ceiling Z {bore_ceil:.1f} "
      f"-> knob rides +{max(0.0, shaft_tip - bore_ceil):.1f}; nut stack (~2.0) on plate "
      f"top vs knob gap 1.0 -> rides on nut ~+1.0 (cosmetic)")

sec("7. tray shell inventory (28 shells)")
V, F = tray_mesh._np()
parent = list(range(len(F)))
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x
by_edge = {}
for fi, (a, b, c) in enumerate(F):
    for e in ((a, b), (b, c), (c, a)):
        k = (min(e), max(e))
        if k in by_edge:
            ra, rb = find(fi), find(by_edge[k])
            if ra != rb:
                parent[ra] = rb
        else:
            by_edge[k] = fi
groups = {}
for fi in range(len(F)):
    groups.setdefault(find(fi), []).append(fi)
for gi, faces in enumerate(sorted(groups.values(), key=len)):
    vs = np.unique(np.array([F[f] for f in faces]).ravel())
    P = V[vs]
    b0, b1 = P.min(axis=0), P.max(axis=0)
    print(f"  shell {gi:2d}: tris {len(faces):5d}  "
          f"x {b0[0]:6.1f}..{b1[0]:6.1f} y {b0[1]:6.1f}..{b1[1]:6.1f} "
          f"z {b0[2]:5.2f}..{b1[2]:5.2f}")

print("\ndone.")
