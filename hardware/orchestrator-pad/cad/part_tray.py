"""part_tray.py — Orchestrator Pad bottom shell (tray, v7 "fatter, post-free"),
in world position per SPEC.

The interior is a component bay: the dual-USB-C ESP32-S3 clone board rides
high (underside at Z=16.0, factory header pins DOWN into the bay), a
down-firing cavity speaker sits flange-on-floor under the board's south
half, the MAX98357A amp drops into a ridge-framed pocket on the back strip,
and jumper-wire bundles zip-tie to a low FLAT wire bar along the west wall.

v7 makes the case much taller (TRAY_H 40, +12 over v6) for lots of open
headroom above the board (~24 mm), and REMOVES every free-standing
cylindrical post from the bay (they got in the way). The board is caged by
FLAT features only: a back guide rail, two front corner tabs, the retained
mid-span ribs and dual side shelves. The board still turns 90° and runs
ALONG X (30 wide in Y, up to 64 long in X) with its USB-C ports facing a
SIDE wall, and the bay stays REVERSIBLE — ports-right (X -22..+42) or
ports-left (X -42..+22). Both side walls carry an identical USB window; the
unused one is a wire pass-through.

One printable part = a union of individually-watertight prism shells that
overlap by OVL = 0.2 mm in Z (or radially) wherever they stack (the slicer
fuses them):

  floor    two slabs; the lower one carries the 4 feet-recess holes; BOTH
           carry the speaker grille slots and the 4 M2.5 pilot holes.
  walls    TWO concentric columns, each split into Z bands (band-split
           trick) so the USB windows and the mic ports keep their exact spec
           edges: a band that carries a wall opening is stretched 0.2 into
           its solid neighbours (its cut runs the band's full height) while
           the solid neighbour ends exactly at the opening edge — the
           neighbour's cap face IS the opening's top/bottom face.
             outer column: the 1.2 skirt-seat wall profile, floor to TRAY_H
             liner column: the inner 1.2 (thick-wall remainder), floor to
             the ledge at Z=33.5; laps 0.2 radially into the outer column
             so the two columns fuse. Its top cap IS the ledge face. (The
             USB windows 17.0..23.5 now sit ENTIRELY below the raised ledge:
             both columns close the window at Z=23.5 with a solid cap and
             run solid up to their tops — liner to the ledge 33.5, outer to
             TRAY_H 40.0. The plate skirt no longer needs a USB notch.) The
             two side cuts split each cut band's annulus into a back arc and
             a front arc — every piece is still its own watertight prism,
             fused to the solid ring bands above and below by the 0.2 lap.
  bosses   4 corner screw bosses: solid pedestal (floor->31.5) + insert-bore
           ring (31.3..37.5, bore 6.0 deep). These MUST stay round — M3
           heat-set inserts thread into them.
  shelves  TWO side-wall board shelves (tabs off the right and left walls),
           mirror images about X=0: whichever way the board goes in, its
           port edge lands on one and its far edge on the other. Both top
           faces are the Z=16.0 seating plane.
  ribs     two mid-span rib walls from the floor to Z=16.0, north of the
           speaker flange (Y >= +1.0) — they carry the board's middle.
  cage     FLAT board cage (no cylinders): a back guide rail (inner face
           Y=+15.1) capping the board's +Y edge, and two front corner tabs
           (inner face Y=-15.1, at |X|>36) capping the -Y front corners.
           Mirror-symmetric about X=0; inner faces 0.1 off a 30-wide board.
  amp      four L-corner ridges framing the MAX98357A pocket (foam-tape),
           on the back strip clear of both board orientations.
  wire     a low FLAT wire bar along the west interior with two zip-tie
           through-slots (band-split in Z) — replaces the old wire posts.
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

# USB windows, BOTH side walls (X=+45 and X=-45): identical 26.0-wide (in Y,
# centered Y=0) apertures at Z 17.0..23.5. The board's two board-top USB-C
# ports exit through whichever side it is installed against; the opposite
# window is a wire pass-through. Wide and tall enough that the exact port
# offsets of any clone don't matter and a plug hood fits inside the
# aperture.
WIN_W, WIN_Z0, WIN_Z1 = pl.USB_WIN         # 26.0 wide, centered Y=0, Z 17.0..23.5

# Mic grille, front wall (Y=-45): 3 square ports, fully below the ledge.
# The round I2S mic module glues behind them, above the speaker body
# (supersedes the v3 low-Z round ports).
MIC_W = 1.5                                # port width/height (square)
MIC_XS = (-23.0, -20.0, -17.0)             # spacing 3.0, centered X=-20
MIC_Z0, MIC_Z1 = 19.4, 20.9                # 1.5 tall, far below LEDGE_Z (33.5)

BOSS_D = 7.0                               # corner boss outer diameter
BORE_D = 4.0                               # M3 heat-set insert bore
BOSS_SOLID_TOP = 31.5                      # v7 (+12): solid pedestal 2.2..31.5
BOSS_TOP = 37.5                            # bore ring 31.3..37.5 (bore 6.0 deep)

# Board bay (v7, ROTATED + REVERSIBLE, POST-FREE): board components-UP, header
# pins DOWN, running along X — BOARD_W (30) wide in Y (|y| <= 15), up to
# BOARD_L (64) long in X. It installs against EITHER side wall:
#     ports-right   X -22.0 .. +42.0   (USB-C exits the X=+45 window)
#     ports-left    X -42.0 .. +22.0   (USB-C exits the X=-45 window)
# Every FLAT cage feature is mirror-symmetric about X=0, so both orientations
# seat identically. The underside sits at BOARD_Z = 16.0 on the two side-wall
# shelves + the two mid-span ribs; the flat back rail + two front corner tabs
# cage it in Y (0.1 clearance per side to a 30-wide board). Under-board
# clearance floor->16.0 = 13.6 for the factory header pins + dupont
# connectors.
SHELF_Y = 14.0                             # both shelf tabs span |y| <= 14
SHELF_X0 = HALF - pl.WALL - 1.6            # 41.0 — tab protrudes 1.6 from the
SHELF_X1 = HALF - pl.WALL + OVL            # 42.8 —  wall inner face (0.2 lap)
SHELF_Z0 = 13.5                            # shelf body 13.5..16.0

# Mid-span ribs (they replace v5's single front bridge): two rib walls under
# the board's middle, floor..BOARD_Z. RIB_Y0 MUST stay >= +1.0 — the speaker
# flange occupies X ±36, Y -42..0, and a rib crossing that footprint would
# collide with the flange.
RIB_X = ((4.0, 7.0), (-7.0, -4.0))         # two 3.0-thick ribs, mirrored
RIB_Y0, RIB_Y1 = 1.0, 16.0                 # 15.0 long, 1.0 clear of the flange

# Board cage (v7): FLAT guide walls only — NO cylindrical locator posts. They
# live only in speaker-clear zones (the flange is X ±36, Y -42..0; supports
# may sit at Y > 0 anywhere, or at |X| > 36 anywhere). Inner faces at |y| =
# 15.1 give 0.1 clearance per side to the 30-wide board; each rises to a 1.4
# lip over the board top at 17.6.
CAGE_Y_IN = 15.1                           # cage inner face (0.1 off board @15)
CAGE_Y_OUT = 17.1                          # cage outer face (2.0-thick wall)
CAGE_Z1 = 19.0                             # cage top (1.4 over the board top)
# BACK GUIDE RAIL, capping the board's +Y edge. Nominal span was X -34..+34,
# but the amp L-ridges reach X 10.5 inside the rail's Y band (15.1..17.1), so
# a +-34/+-30 rail would fuse into the amp (18.3/12.9 mm^2 overlap). Trimmed
# to +-10.0 -> clears the amp by 0.5, stays symmetric + watertight. It fuses
# with the two mid-span ribs (X +-4..7) at Y 15.1..16 by design (ties the
# rail to the load-bearing ribs).
BACK_RAIL_XW = 10.0                        # rail spans X -10.0 .. +10.0
# FRONT CORNER GUIDE TABS, capping the board's -Y front corners. Both at
# |X| > 36 (clear of the flange edge at 36 by 0.8), Y -17.1 .. -15.1.
TAB_X0, TAB_X1 = 36.8, 40.0                # right tab X 36.8..40.0 (left mirror)

# Speaker bay (down-firing, flange ON the floor, centered SPK_CENTER):
# racetrack floor opening with two grille bars -> 3 slots; 4 M2.5
# self-tapper pilots THROUGH the floor (heads inside on the flange, tips
# end in the >=3mm foot gap). Fits flanges up to SPK_FLANGE (72x42), driver
# bump up to Ø50 x SPK_BUMP_MAX (11) tall: bump top 2.4+1.5+11 = 14.9
# clears the board underside at 16.0 by 1.1.
SPK_OPEN_W, SPK_OPEN_H = 54.0, 24.0        # racetrack opening (rounded R12)
SPK_OPEN_R = 12.0
SPK_BAR_W = 2.0                            # two bars along X -> 3 slots
SPK_PILOT_D = 2.4                          # M2.5 pilot holes, through the floor
SPK_PILOT_XY = tuple((sx * 31.5, y)        # 63 x 33 hole pattern @ (0,-21)
                     for sx in (-1, 1) for y in (-37.5, -4.5))

# Amp pocket: four L-corner ridges framing a square pocket on the BACK strip
# — the MAX98357A drops in, foam-tape mounted. The rotated board covers
# X -42..+42 over |y| <= 15 across the two orientations, so the pocket moved
# north out from under it: ridge outer edge reaches Y 15.5 vs the board edge
# at 15.0 (0.5 clear) and X 33.5 vs the corner bosses' inner face at 35.5.
AMP_C = (22.0, 27.0)                       # pocket center
AMP_POCKET = 20.0                          # pocket clear width (square)
AMP_RIDGE_W = 1.5                          # ridge width
AMP_RIDGE_H = 2.0                          # ridge height above the floor
AMP_RIDGE_L = 6.0                          # leg length from each outer corner

# Wire bar (v7, west wiring channel): a low FLAT wall — NO cylinders — with
# two zip-tie through-slots (band-split in Z, like the old wire-post notch).
# A zip tie threads a slot and cinches the harness against the bar. Tops out
# at Z 8.0, well below the left USB window (Z 17.0); Y 6..30 clears the
# speaker flange (Y <= 0) by 6.0 and the (-39,+39) boss by 5.5. It underlies
# the ports-left board footprint in plan but sits 8.0 below the board
# underside (16.0), so it never obstructs seating in either orientation.
WBAR_X0, WBAR_X1 = -38.0, -36.0            # 2.0 thick, inner face X=-36.0
WBAR_Y0, WBAR_Y1 = 6.0, 30.0               # 24 long along Y
WBAR_Z1 = 8.0                              # bar top
WSLOT_W = 3.2                              # zip-tie slot width (in Y)
WSLOT_YS = (12.0, 24.0)                    # two slots centered here
WSLOT_Z0, WSLOT_Z1 = 3.0, 5.0              # slot band (2.0 tall)

# reach of the wall-opening cutters: from inside any wall to past the outside
CUT_IN, CUT_OUT = HALF - 4.0, HALF + 1.0   # 41 .. 46


def _rr(w, r):
    """Square rounded-rect profile centered at origin."""
    return pl.rounded_rect(w, w, r)


def win_cutter():
    """The v6 USB wall cutter: BOTH side windows at once (RIGHT wall X=+45
    and LEFT wall X=-45), each WIN_W wide in Y centered Y=0, reaching from
    inside the liner to past the outer skin. Mirror-symmetric about X=0 —
    the board installs ports-right OR ports-left and the unused window
    serves as a wire pass-through. Subtracted in the Z 17.0..23.5 bands."""
    return unary_union([
        box(CUT_IN, -WIN_W / 2, CUT_OUT, WIN_W / 2),          # RIGHT wall X=+45
        box(-CUT_OUT, -WIN_W / 2, -CUT_IN, WIN_W / 2),        # LEFT  wall X=-45
    ])


def spk_floor_opening():
    """Speaker grille: racetrack 54 x 24 R12 at SPK_CENTER minus two 2.0
    bars along X -> a MultiPolygon of 3 slots (the actual floor holes)."""
    cx, cy = pl.SPK_CENTER
    track = affinity.translate(
        pl.rounded_rect(SPK_OPEN_W, SPK_OPEN_H, SPK_OPEN_R), cx, cy)
    slot_h = (SPK_OPEN_H - 2 * SPK_BAR_W) / 3.0          # 3 equal slots
    y0 = cy - SPK_OPEN_H / 2
    bars = unary_union([
        box(cx - SPK_OPEN_W / 2 - 1, y0 + slot_h, cx + SPK_OPEN_W / 2 + 1,
            y0 + slot_h + SPK_BAR_W),
        box(cx - SPK_OPEN_W / 2 - 1, y0 + 2 * slot_h + SPK_BAR_W,
            cx + SPK_OPEN_W / 2 + 1, y0 + 2 * (slot_h + SPK_BAR_W)),
    ])
    return track.difference(bars)


def amp_ridges():
    """Four L-corner ridges hugging the AMP_POCKET square from outside."""
    cx, cy = AMP_C
    h = AMP_POCKET / 2.0
    legs = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            x_in, x_out = cx + sx * h, cx + sx * (h + AMP_RIDGE_W)
            y_in, y_out = cy + sy * h, cy + sy * (h + AMP_RIDGE_W)
            legs.append(box(min(x_in, x_out), min(y_out, y_out - sy * AMP_RIDGE_L),
                            max(x_in, x_out), max(y_out, y_out - sy * AMP_RIDGE_L)))
            legs.append(box(min(x_out, x_out - sx * AMP_RIDGE_L), min(y_in, y_out),
                            max(x_out, x_out - sx * AMP_RIDGE_L), max(y_in, y_out)))
    return unary_union(legs)


def build():
    """-> [("tray", Mesh, COLORS["tray"])] in world position (Z=0 = bottom)."""
    outer = _rr(pl.CASE_W, pl.CASE_R)
    # outer column: the 1.2 skirt-seat wall, full height (43.8..45.0 radial)
    ring_thin = pl.ring2d(outer, _rr(pl.CASE_W - 2 * SKIRT_WALL,
                                     pl.CASE_R - SKIRT_WALL))
    # liner column: the inner 1.2 of the 2.4 wall, floor..LEDGE_Z; its outer
    # boundary laps 0.2 into the outer column so the two columns fuse
    # (concentric corner arcs — every profile shares corner centers)
    ring_liner = pl.ring2d(_rr(pl.CASE_W - 2 * SKIRT_WALL + 2 * OVL,
                               pl.CASE_R - SKIRT_WALL + OVL),
                           _rr(pl.CASE_W - 2 * pl.WALL, pl.CASE_R - pl.WALL))

    # wall-opening cutters (2D), reaching fully through both columns.
    # v6: the USB cutter is BOTH side windows at once — same width, same Y
    # centering, same Z band; the unused one is a wire pass-through.
    win = win_cutter()                                        # Z 17.0..23.5
    mics = unary_union([box(x - MIC_W / 2, -CUT_OUT, x + MIC_W / 2, -CUT_IN)
                        for x in MIC_XS])                     # Z 19.4..20.9

    m = pl.Mesh()

    # -- floor: recess layer (holes through it) + full slab above ----------
    # The hole layer runs 0.2 past the recess depth; the full slab starts at
    # the exact recess depth, so its bottom cap is the recess ceiling at 0.6.
    # The speaker slots + M2.5 pilots go through BOTH layers. (The two back
    # pilots merge with the adjacent feet-recess rims in the lower layer —
    # a designed 63x33 speaker pattern vs (+-36,+-36) feet consequence; the
    # merged 2D holes keep both layers watertight.)
    feet = unary_union([affinity.translate(pl.circle(FEET_D),
                                           sx * FEET_XY, sy * FEET_XY)
                        for sx in (-1, 1) for sy in (-1, 1)])
    slots = spk_floor_opening()
    pilots = unary_union([affinity.translate(pl.circle(SPK_PILOT_D), x, y)
                          for x, y in SPK_PILOT_XY])
    thru = slots.union(pilots)
    m += pl.prism(outer.difference(feet.union(thru)), 0.0, FEET_DEPTH + OVL)
    m += pl.prism(outer.difference(thru), FEET_DEPTH, pl.FLOOR)

    # -- walls: two columns of Z bands; cut bands stretch OVL into solid
    #    neighbours, solid neighbours' caps define the exact opening edges.
    #    v7: the ledge (33.5) is now ABOVE the window top (23.5), so BOTH
    #    columns close the window at WIN_Z1 with a solid cap and run solid up
    #    to their tops — the liner to the ledge (LEDGE_Z), the outer skin to
    #    TRAY_H. (In v6 the ledge sat inside the window, so the liner's window
    #    ceiling WAS the ledge; that special case is gone.) --
    for ring, top in ((ring_thin, pl.TRAY_H), (ring_liner, pl.LEDGE_Z)):
        # 2.2..17.0   solid (top cap = USB window floor at 17.0)
        m += pl.prism(ring, pl.FLOOR - OVL, WIN_Z0)
        # 16.8..19.4  - window   (top cap = mic port floor at 19.4)
        m += pl.prism(ring.difference(win), WIN_Z0 - OVL, MIC_Z0)
        # 19.2..21.1  - window - mics   (stretched both ways; the mic edges
        #             at 19.4/20.9 come from the solid caps around it)
        m += pl.prism(ring.difference(win).difference(mics),
                      MIC_Z0 - OVL, MIC_Z1 + OVL)
        # 20.9..23.7  - window  (bottom cap = mic ceiling at 20.9)
        m += pl.prism(ring.difference(win), MIC_Z1, WIN_Z1 + OVL)
        # 23.5..top   solid (bottom cap = window ceiling at 23.5; top is the
        #             ledge for the liner, TRAY_H for the outer skin)
        m += pl.prism(ring, WIN_Z1, top)

    # -- corner bosses: solid pedestal + insert-bore ring ------------------
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = sx * pl.BOSS_XY, sy * pl.BOSS_XY
            c_boss = affinity.translate(pl.circle(BOSS_D), cx, cy)
            c_bore = affinity.translate(pl.circle(BORE_D), cx, cy)
            m += pl.prism(c_boss, pl.FLOOR - OVL, BOSS_SOLID_TOP)
            m += pl.prism(c_boss.difference(c_bore),
                          BOSS_SOLID_TOP - OVL, BOSS_TOP)

    # -- board bay: two side-wall shelves (tabs off the walls, 0.2 radial lap
    #    into the liner) + two mid-span ribs (all flat seats to Z=16.0) -----
    for sx in (-1, 1):
        m += pl.prism(box(min(sx * SHELF_X0, sx * SHELF_X1), -SHELF_Y,
                          max(sx * SHELF_X0, sx * SHELF_X1), SHELF_Y),
                      SHELF_Z0, pl.BOARD_Z)
    for rx0, rx1 in RIB_X:
        m += pl.prism(box(rx0, RIB_Y0, rx1, RIB_Y1), pl.FLOOR - OVL, pl.BOARD_Z)

    # -- FLAT board cage (no cylinders): back guide rail (+Y edge) + two front
    #    corner tabs (-Y corners). Inner faces 0.1 off a 30-wide board. -----
    m += pl.prism(box(-BACK_RAIL_XW, CAGE_Y_IN, BACK_RAIL_XW, CAGE_Y_OUT),
                  pl.FLOOR - OVL, CAGE_Z1)
    for sx in (-1, 1):
        m += pl.prism(box(min(sx * TAB_X0, sx * TAB_X1), -CAGE_Y_OUT,
                          max(sx * TAB_X0, sx * TAB_X1), -CAGE_Y_IN),
                      pl.FLOOR - OVL, CAGE_Z1)

    # -- amp pocket ridges (MAX98357A drops between them) ------------------
    m += pl.prism(amp_ridges(), pl.FLOOR - OVL, pl.FLOOR + AMP_RIDGE_H)

    # -- FLAT wire bar with two zip-tie through-slots (band-split in Z) ----
    bar = box(WBAR_X0, WBAR_Y0, WBAR_X1, WBAR_Y1)
    slots = unary_union([box(WBAR_X0 - 1.0, y - WSLOT_W / 2,
                             WBAR_X1 + 1.0, y + WSLOT_W / 2)   # cut through in X
                         for y in WSLOT_YS])
    # 2.2..3.0  solid (top cap = slot floor at 3.0)
    m += pl.prism(bar, pl.FLOOR - OVL, WSLOT_Z0)
    # 2.8..5.2  - slots (bar segments; exact slot edges from the caps)
    m += pl.prism(bar.difference(slots), WSLOT_Z0 - OVL, WSLOT_Z1 + OVL)
    # 5.0..8.0  solid (bottom cap = slot ceiling at 5.0)
    m += pl.prism(bar, WSLOT_Z1, WBAR_Z1)

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
