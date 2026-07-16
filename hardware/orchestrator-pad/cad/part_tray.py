"""part_tray.py — Orchestrator Pad bottom shell (tray), in world position per SPEC.

One printable part = a union of individually-watertight prism shells that
overlap by OVL = 0.2 mm in Z wherever they stack (the slicer fuses them):

  floor   two slabs; the lower one carries the 4 feet-recess holes.
  walls   ring profiles split into Z bands (band-split trick) so the USB-C
          slot, the mic ports and the reset pinhole keep their exact spec
          edges: a band that carries a wall opening is stretched 0.2 into
          its solid neighbours (its cut runs the band's full height) while
          the solid neighbour ends exactly at the opening edge — the
          neighbour's cap face IS the opening's top/bottom face.
  bosses  4 corner screw bosses: solid base + insert-bore ring.
  rails   2 ridges guiding the ESP32-S3 DevKitC laterally (USB end toward +Y).
  pads    2 pedestals under the board's bare center strip seating the PCB
          bottom at Z=5.4 (rail-top height) so the USB port faces the slot.
"""
from __future__ import annotations

import os
import sys

from shapely import affinity
from shapely.geometry import box
from shapely.ops import unary_union

import partlib as pl

OVL = 0.2                                  # standard Z overlap between shells

# ---------------------------------------------------------- tray numbers ----
HALF = pl.CASE_W / 2.0                     # 45.0 — outer face of the walls

SKIRT_WALL = 1.2                           # wall thickness above LEDGE_Z (spec)

FEET_XY = 36.0                             # feet-recess centers (+-36, +-36)
FEET_D = 9.0                               # recess diameter
FEET_DEPTH = 0.6                           # recess depth into the bottom face

USB_W = 10.5                               # USB-C slot, back wall (Y=+45)
USB_X = 7.79                               # slot center X: the DevKitC-1 V1.1
#            drawing puts BOTH USB ports +-7.79 off the board centerline, so a
#            centered slot faces neither port. With the board centered by the
#            rails, the native/OTG port (HID + power + flashing) lands at
#            world X = +7.79 — the slot is centered on it.
USB_Z0, USB_Z1 = 6.4, 10.9                 # slot spans Z 6.4..10.9 (4.5 tall)

MIC_W = 1.5                                # three square mic ports, front wall
MIC_XS = (-3.0, 0.0, 3.0)
PORT_Z0, PORT_Z1 = 7.25, 8.75              # mic + reset ports: centered Z=8

RESET_W = 1.6                              # reset pinhole width, right wall
RESET_Y = 20.0

BOSS_D = 7.0                               # corner boss outer diameter
BORE_D = 4.0                               # M3 heat-set insert bore
BOSS_SOLID_TOP = 5.5                       # solid pedestal 2.2..5.5
BOSS_TOP = 11.5                            # bore ring 5.3..11.5 (bore 6.0 deep)

RAIL_W = 2.0                               # ESP32 rails: 2 wide x 3 tall x 40
RAIL_GAP = 26.0                            # inner faces 26.0 apart
RAIL_Y0, RAIL_Y1 = -2.0, 38.0              # along Y, USB end toward back wall
RAIL_TOP = pl.FLOOR + 3.0                  # 5.4

# Board support pads: the 25.4-wide board drops BETWEEN the 26.0-gap rails, so
# the rails are lateral guides only — these pads carry the PCB bottom at the
# rail-top height Z=5.4 (USB centerline then 5.4 + 1.6 + 1.63 = 8.63, centered
# in the 6.4..10.9 slot). They sit under the board's bare center strip,
# |x| <= 9.0, clear of the header rows (insulators cover |x| >= 10.16) and of
# the connector underside tabs near the back edge. BOM: header-less or
# clipped-flush pins — the 2.4 floor can never clear 8.5 mm factory pins.
PAD_HALF_W = 9.0                           # pads span x -9.0..+9.0
PAD_TOP = RAIL_TOP                         # PCB bottom seats at 5.4
PAD_YS = ((2.0, 8.0), (24.0, 30.0))        # two pads along the rail span

# reach of the wall-opening cutters: from inside any wall to past the outside
CUT_IN, CUT_OUT = HALF - 4.0, HALF + 1.0   # 41 .. 46


def _rr(w, r):
    """Square rounded-rect profile centered at origin."""
    return pl.rounded_rect(w, w, r)


def build():
    """-> [("tray", Mesh, COLORS["tray"])] in world position (Z=0 = bottom)."""
    outer = _rr(pl.CASE_W, pl.CASE_R)
    ring_thick = pl.ring2d(outer, _rr(pl.CASE_W - 2 * pl.WALL,
                                      pl.CASE_R - pl.WALL))
    ring_thin = pl.ring2d(outer, _rr(pl.CASE_W - 2 * SKIRT_WALL,
                                     pl.CASE_R - SKIRT_WALL))

    # wall-opening cutters (2D), each reaching fully through the wall
    usb = box(USB_X - USB_W / 2, CUT_IN, USB_X + USB_W / 2, CUT_OUT)
    mics = unary_union([box(x - MIC_W / 2, -CUT_OUT, x + MIC_W / 2, -CUT_IN)
                        for x in MIC_XS])
    reset = box(CUT_IN, RESET_Y - RESET_W / 2, CUT_OUT, RESET_Y + RESET_W / 2)
    ports = mics.union(reset)              # mic + reset share Z 7.25..8.75

    m = pl.Mesh()

    # -- floor: recess layer (holes through it) + full slab above ----------
    # The hole layer runs 0.2 past the recess depth; the full slab starts at
    # the exact recess depth, so its bottom cap is the recess ceiling at 0.6.
    feet = unary_union([affinity.translate(pl.circle(FEET_D),
                                           sx * FEET_XY, sy * FEET_XY)
                        for sx in (-1, 1) for sy in (-1, 1)])
    m += pl.prism(outer.difference(feet), 0.0, FEET_DEPTH + OVL)
    m += pl.prism(outer, FEET_DEPTH, pl.FLOOR)

    # -- walls: Z bands; cut bands stretch OVL into solid neighbours -------
    # 2.2..6.4   thick ring, solid (top cap = USB slot floor at 6.4)
    m += pl.prism(ring_thick, pl.FLOOR - OVL, USB_Z0)
    # 6.2..7.25  thick ring - USB   (top cap = mic/reset port floor at 7.25)
    m += pl.prism(ring_thick.difference(usb), USB_Z0 - OVL, PORT_Z0)
    # 7.05..7.5  thick ring - USB - ports   (up to the skirt-seat ledge)
    m += pl.prism(ring_thick.difference(usb).difference(ports),
                  PORT_Z0 - OVL, pl.LEDGE_Z)
    # 7.3..8.95  thin ring - USB - ports   (stretched both ways: the ledge
    #            joint below is solid-vs-solid, the port top edge at 8.75 is
    #            defined by the solid band above)
    m += pl.prism(ring_thin.difference(usb).difference(ports),
                  pl.LEDGE_Z - OVL, PORT_Z1 + OVL)
    # 8.75..11.1 thin ring - USB   (bottom cap = port ceiling at 8.75)
    m += pl.prism(ring_thin.difference(usb), PORT_Z1, USB_Z1 + OVL)
    # 10.9..14   thin ring, solid  (bottom cap = USB slot ceiling at 10.9)
    m += pl.prism(ring_thin, USB_Z1, pl.TRAY_H)

    # -- corner bosses: solid pedestal + insert-bore ring ------------------
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = sx * pl.BOSS_XY, sy * pl.BOSS_XY
            c_boss = affinity.translate(pl.circle(BOSS_D), cx, cy)
            c_bore = affinity.translate(pl.circle(BORE_D), cx, cy)
            m += pl.prism(c_boss, pl.FLOOR - OVL, BOSS_SOLID_TOP)
            m += pl.prism(c_boss.difference(c_bore),
                          BOSS_SOLID_TOP - OVL, BOSS_TOP)

    # -- ESP32-S3 DevKitC locating rails (lateral guides) ------------------
    for s in (-1, 1):
        x_in, x_out = s * (RAIL_GAP / 2), s * (RAIL_GAP / 2 + RAIL_W)
        m += pl.prism(box(min(x_in, x_out), RAIL_Y0, max(x_in, x_out), RAIL_Y1),
                      pl.FLOOR - OVL, RAIL_TOP)

    # -- board support pads: PCB bottom seats at Z 5.4 ---------------------
    for y0, y1 in PAD_YS:
        m += pl.prism(box(-PAD_HALF_W, y0, PAD_HALF_W, y1),
                      pl.FLOOR - OVL, PAD_TOP)

    return [("tray", m, pl.COLORS["tray"])]


if __name__ == "__main__":
    items = build()
    ok = True
    for name, mesh, _ in items:
        rep = pl.validate(mesh)
        print(f"{name}: {rep}")
        ok &= rep["watertight"]

    here = os.path.dirname(os.path.abspath(__file__))
    exports = os.path.normpath(os.path.join(here, "..", "exports"))
    os.makedirs(exports, exist_ok=True)
    out = os.path.join(exports, "preview-tray.glb")
    pl.glb_write(out, items)
    print("wrote", out)
    sys.exit(0 if ok else 1)
