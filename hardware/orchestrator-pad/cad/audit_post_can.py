"""audit_post_can.py — RE-AUDIT 3 probe (read-only, throwaway).

Independent check of the switch-underside vs DevKitC module conflict and the
UART-shell vs plate-skirt conflict, using the ACTUAL build() meshes where a
printed part is involved.

Component data (official V1.1 drawing / Cherry MX datasheet, as already used
by audit_fit/audit_recheck):
  PCB 25.4 x 62.87 x 1.6, on pads -> bottom Z 5.4, top Z 7.0
  USB shells 8.94 w x 3.26 h at x = +-7.79, overhang the back edge 1.31
  WROOM-1 module 18.0 wide x 25.5 long x 3.1 tall, centered x=0, at the front
    end; antenna (~6.3 of the 25.5) overhangs the front edge (photos/V1.1);
    shield-can region on-board, top Z 10.1; antenna PCB ~1.0 thick, top ~8.0
  MX: plate top->housing base 5.0 -> base Z 10.5; center post + pins 3.3 below
    base -> tips Z 7.2; post d4 at key center; pins (-3.81,+2.54),(+2.54,+5.08)
"""
import numpy as np
from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union

import partlib as pl
import part_tray as pt
import part_plate as pp
from audit_recheck import winding_inside

BRD_W, BRD_L, BRD_T = 25.4, 62.87, 1.6
OVH = 1.31
PIN_TIP = pl.PLATE_Z1 - 8.3            # 7.2
CAN_TOP = pt.PAD_TOP + BRD_T + 3.1     # 10.1
ANT_TOP = pt.PAD_TOP + BRD_T + 1.0     # ~8.0 (module PCB only, no can)

print("=== A. board max-back seat (what stops the board first?) ===")
WALL_THICK_IN = pl.CASE_W / 2 - pl.WALL          # 42.6 (z<7.5)
skirt = pp._skirt_profile()
uart_shell_x = (-7.79 - 8.94 / 2, -7.79 + 8.94 / 2)
# candidate stops for the UART shell nose (z 7.0..10.26) and board edge:
#   thick wall inner 42.6 (z<7.5), skirt inner face (z>=7.5), thin wall 43.8
sk_seg_back = [g for g in pl._polys(skirt) if g.bounds[3] > 42 and g.bounds[0] < -3]
sk_inner_y = min(g.bounds[1] for g in sk_seg_back)          # 42.10
stops = {
    "thick wall (z7.0..7.5)": WALL_THICK_IN,
    "plate skirt (z7.5..10.26)": sk_inner_y,
}
for name, y in sorted(stops.items(), key=lambda kv: kv[1]):
    edge = y - OVH
    recess = 45.0 - (edge + OVH)
    print(f"  {name}: UART nose stops at y={y:.2f} -> board edge {edge:.2f} "
          f"-> native receptacle face recess {recess:.2f} mm")
lim = min(stops.values()) - OVH                  # skirt is the binding stop
print(f"  binding: board back edge {lim:.2f}; usable plug recess needs <=~1.5 "
      f"(overmold >4.5 tall never passes the 4.5-tall slot)")

print("\n=== B. skirt band vs UART connector shell (mesh winding samples) ===")
plate_mesh = pp.build()[0][1]
# UART shell volume when the board is pushed to the SPEC seat (edge at 42.6):
xs = np.arange(uart_shell_x[0] + 0.1, uart_shell_x[1], 0.35)
ys = np.arange(WALL_THICK_IN + 0.05, WALL_THICK_IN + OVH, 0.18)
zs = np.arange(7.55, 10.26, 0.45)
pts = np.array([(x, y, z) for x in xs for y in ys for z in zs])
hit = winding_inside(plate_mesh, pts)
print(f"  samples in UART-shell overhang box (board edge at 42.6): {len(pts)}, "
      f"inside PLATE mesh: {int(hit.sum())} "
      f"{'-> SKIRT OCCUPIES SHELL VOLUME (collision)' if hit.sum() else '-> clear'}")

print("\n=== C. module can / antenna vs switch center posts + pins ===")
for edge_name, back_edge in (("skirt-limited seat", lim),
                             ("SPEC seat (UART relief assumed)", WALL_THICK_IN)):
    front = back_edge - BRD_L
    can = box(-9.0, front, 9.0, front + (25.5 - 6.3))       # antenna overhangs
    ant = box(-9.0, front - 6.3, 9.0, front)                # antenna zone
    print(f"  [{edge_name}] board edge {back_edge:.2f}, front {front:.2f}, "
          f"can y {front:.2f}..{front + 19.2:.2f}, ant y {front - 6.3:.2f}..{front:.2f}")
    for k in pl.key_layout():
        post = Point(k["x"], k["y"]).buffer(2.0, quad_segs=16)   # d4 center post
        a_can = post.intersection(can).area
        a_ant = post.intersection(ant).area
        pins = [(k["x"] - 3.81, k["y"] + 2.54), (k["x"] + 2.54, k["y"] + 5.08)]
        pin_can = sum(can.contains(Point(*p)) for p in pins)
        pin_ant = sum(ant.contains(Point(*p)) for p in pins)
        if a_can > 0.01 or pin_can or a_ant > 0.01 or pin_ant:
            msg = []
            if a_can > 0.01 or pin_can:
                msg.append(f"CAN: post {a_can:.1f} mm2, pins {pin_can} "
                           f"(interf {CAN_TOP - PIN_TIP:.1f} mm)")
            if a_ant > 0.01 or pin_ant:
                msg.append(f"ANT: post {a_ant:.1f} mm2, pins {pin_ant} "
                           f"(interf {ANT_TOP - PIN_TIP:.1f} mm)")
            print(f"    {k['id']:12s} " + "; ".join(msg))

print("\n=== D. Y-stop inventory ===")
tray_mesh = pt.build()[0][1]
# any tray material in the board's forward path (board slab z 5.4..7.0)?
xs = np.arange(-BRD_W / 2 + 0.4, BRD_W / 2, 0.8)
ys = np.arange(-40.0, lim - BRD_L, 0.8)          # ahead of the board front edge
pts = np.array([(x, y, z) for x in xs for y in ys for z in (5.6, 6.4, 6.9)])
hit = winding_inside(tray_mesh, pts)
print(f"  tray material ahead of board front edge (z 5.4..7.0): "
      f"{int(hit.sum())}/{len(pts)} samples -> "
      f"{'stop exists' if hit.sum() else 'NO forward stop: insertion force slides board'}")
