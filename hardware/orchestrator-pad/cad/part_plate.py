"""part_plate.py — Orchestrator Pad TOP PLATE (SPEC.md "Top plate").

One printable part, built as a union of individually-watertight shells
(no 3D CSG — the slicer unions overlapping shells):

  * plate slab in two Z bands (counterbore trick):
      band A  Z 28.0..28.7  — outline minus 14 MX cutouts, knob hole,
                              4x Ø3.4 screw through-holes
      band B  Z 28.5..29.5  — same, but corner holes are Ø6.4 counterbores
    the 0.2 overlap fuses the bands; net effect: full 1.5 plate with an
    0.8-deep Ø6.4 counterbore over a Ø3.4 through-hole at each corner.
  * skirt (drops into the tray's thinned upper wall), Z 33.5..40.2 — the ring
    is notched ONLY for the tray bosses now:
      - Ø8.6 corner clearances at (±39, ±39) around the tray bosses (Ø7.0
        rises to Z 37.5, straight through the skirt band; 0.8 radial gap)
    v7 made the case much taller, so the ledge rose to 33.5 while the USB
    windows still top out at Z 23.5 — the side windows sit ENTIRELY below the
    ledge and no longer cross into the skirt seat, so the v6 side USB notches
    are gone. The skirt only needs the boss clearances; the ring survives as
    4 arc segments (one per edge, severed at the 4 corner notches), each
    still fused to plate band A via the 0.2 lap. (The mic grille at Z
    19.4..20.9 is also far below the ledge — no front notch either.)
  * 4 screw towers Ø7.6/Ø3.4 at (±39, ±39), Z 37.5..40.2
    (towers land on the tray bosses; 0.2 into the plate slab)

World position per SPEC: XY centered on the case footprint, Z as listed.
"""
from __future__ import annotations

import os
import sys

from shapely import affinity
from shapely.geometry import box
from shapely.ops import unary_union

import partlib as pl
import part_tray                    # single source of truth for the corner-boss top

# ---- local parameters (SPEC "Top plate" / kernel overlap rule) ------------

OVERLAP = 0.2                       # min Z overlap so shells fuse when sliced
MX_CORNER_R = 0.5                   # MX cutout corner radius
SCREW_D = 3.4                       # M3 through-hole
CBORE_D = 6.4                       # M3 button-head counterbore
CBORE_DEPTH = 0.8                   # counterbore depth from the top face
SKIRT_OUT_W, SKIRT_OUT_R = 87.3, 6.9    # skirt outer profile (rr) — 0.15 per
                                    # side inside the tray's 87.6 upper wall
SKIRT_IN_W, SKIRT_IN_R = 85.0, 6.3      # skirt inner profile (1.15 wall)
BOSS_CLEAR_D = 8.6                  # skirt corner notch around the Ø7.0 tray
                                    # bosses (0.8 radial clearance)
# v7: the side USB notches are gone — the windows (Z 17.0..23.5) sit entirely
# below the raised ledge (33.5), so the skirt never crosses them.
TOWER_D = 7.6                       # screw tower outer diameter
TOWER_Z0 = part_tray.BOSS_TOP       # tray corner-boss top (37.5, SPEC "Tray")

# ---- v5.1 switch sockets + footprint deck (SPEC "Top plate") --------------
# Each switch drops into a pocket under its plate cutout; the pocket WALLS
# stop at the MX base-seat height, so the flipped plate prints as simple
# towers (no bridges, no supports). The donor-style footprint floor is a
# SEPARATE flat part — the "switch deck": one 1.2 sheet with all 14 MX
# footprint clusters that prints flat on the bed (perfect holes), presses
# up onto the switch posts/legs from below (friction fit), seats against
# the wall rims, and leaves the contact pins protruding ~2.1 for soldering.
SOCKET_WALL = 1.6                   # pocket wall thickness
SOCKET_OUT_W = 17.3                 # pocket outer square (14.1 + 2*1.6)
SOCKET_OUT_R = 1.7
SOCKET_SEAT_DROP = 5.0              # MX shoulder->base depth below plate top
DECK_T = 1.2                        # switch-deck sheet thickness
DECK_W, DECK_R = 78.0, 6.0          # deck outline (inside the skirt/towers)
MX_POST_D = 4.15                    # center post hole (snug on the Ø4 post)
MX_PIN_D = 2.0                      # the two contact pin holes (blade pins)
MX_PIN_A = (-3.81, 2.54)            # contact 1 (offsets from key center,
MX_PIN_B = (2.54, 5.08)             #  +Y toward the back — donor layout)
MX_LEG_D = 1.85                     # 5-pin leg holes (snug on Ø1.7 legs)
MX_LEGS = ((-5.08, 0.0), (5.08, 0.0))
TOWER_CLEAR_D = 8.8                 # socket/deck keep-out around the towers
KNOB_CUT_W = 16.0                   # deck cutout under the EC11 body


def _at(geom, x, y):
    return affinity.translate(geom, x, y)


def _screw_centers():
    return [(sx * pl.BOSS_XY, sy * pl.BOSS_XY)
            for sx in (-1.0, 1.0) for sy in (-1.0, 1.0)]


def _plate_profile(corner_hole_d):
    """Plate outline minus MX cutouts, knob hole and 4 corner holes of the
    given diameter (Ø3.4 through-band / Ø6.4 counterbore band)."""
    outline = pl.rounded_rect(pl.CASE_W, pl.CASE_W, pl.CASE_R)
    cuts = [_at(pl.rounded_rect(pl.MX_CUT, pl.MX_CUT, MX_CORNER_R),
                k["x"], k["y"])
            for k in pl.key_layout()]                       # 14 MX cutouts
    cuts.append(_at(pl.circle(pl.KNOB_HOLE_D), *pl.KNOB_POS))  # EC11 bush
    cuts += [_at(pl.circle(corner_hole_d), x, y)
             for x, y in _screw_centers()]                  # corner holes
    return outline.difference(unary_union(cuts))


def _skirt_profile():
    """Skirt ring minus the tray-boss corner clearances ONLY.

    The Ø7.0 tray bosses rise to Z 37.5 straight through the skirt band
    (their reach past the shared corner-arc center exceeds even the skirt's
    outer radius), so the four Ø8.6 corner notches are mandatory for the
    case to close. v7 dropped the side USB notches: the case is much taller,
    the ledge rose to 33.5, and the USB windows still top out at 23.5 — the
    windows sit entirely below the ledge and never cross the skirt seat.
    The four corner cuts sever the thin ring into 4 arc segments (one per
    edge); each still spans the full skirt height, so each stays a
    watertight prism fused to plate band A by the 0.2 overlap.
    """
    skirt = pl.ring2d(pl.rounded_rect(SKIRT_OUT_W, SKIRT_OUT_W, SKIRT_OUT_R),
                      pl.rounded_rect(SKIRT_IN_W, SKIRT_IN_W, SKIRT_IN_R))
    boss_clear = unary_union([_at(pl.circle(BOSS_CLEAR_D), x, y)
                              for x, y in _screw_centers()])
    return skirt.difference(boss_clear)


def _tower_keepout():
    return unary_union([_at(pl.circle(TOWER_CLEAR_D), x, y)
                        for x, y in _screw_centers()])


def _socket_wall(key, keepout):
    """Pocket wall ring for one switch, in world XY (clipped by the
    screw-tower keep-out on the three corner-adjacent keys)."""
    x, y = key["x"], key["y"]
    outer = _at(pl.rounded_rect(SOCKET_OUT_W, SOCKET_OUT_W, SOCKET_OUT_R), x, y)
    inner = _at(pl.rounded_rect(pl.MX_CUT, pl.MX_CUT, MX_CORNER_R), x, y)
    return outer.difference(inner).difference(keepout)


def _deck_profile():
    """The switch deck: one flat sheet with every MX footprint cluster.
    Prints flat (perfect holes), presses onto the switch posts/legs from
    below. Notched at the four screw towers/bosses, cut out under the EC11."""
    sheet = pl.rounded_rect(DECK_W, DECK_W, DECK_R)
    holes = []
    for k in pl.key_layout():
        x, y = k["x"], k["y"]
        holes += [_at(pl.circle(MX_POST_D), x, y),
                  _at(pl.circle(MX_PIN_D), x + MX_PIN_A[0], y + MX_PIN_A[1]),
                  _at(pl.circle(MX_PIN_D), x + MX_PIN_B[0], y + MX_PIN_B[1])]
        holes += [_at(pl.circle(MX_LEG_D), x + lx, y + ly) for lx, ly in MX_LEGS]
    holes.append(_at(pl.rounded_rect(KNOB_CUT_W, KNOB_CUT_W, 2.0), *pl.KNOB_POS))
    return sheet.difference(unary_union(holes)).difference(_tower_keepout())


def build():
    z_a1 = pl.PLATE_Z1 - CBORE_DEPTH        # 28.7 — deep band top
    z_b0 = z_a1 - OVERLAP                   # 28.5 — counterbore band bottom
    z_into_plate = pl.PLATE_Z0 + OVERLAP    # 28.2 — skirt/tower fuse height
    seat_z = pl.PLATE_Z1 - SOCKET_SEAT_DROP  # 24.5 — switch base / deck seat
    floor_z0 = seat_z - DECK_T               # 23.3 — deck bottom (pins +2.1)

    m = pl.Mesh()

    # plate slab, two bands (holes are through BOTH bands except the corner
    # holes, which widen from Ø3.4 to the Ø6.4 counterbore in the top band)
    m += pl.prism(_plate_profile(SCREW_D), pl.PLATE_Z0, z_a1)
    m += pl.prism(_plate_profile(CBORE_D), z_b0, pl.PLATE_Z1)

    # skirt: seats inside the tray's thinned upper wall (boss + USB notches)
    m += pl.prism(_skirt_profile(), pl.LEDGE_Z, z_into_plate)

    # 4 screw towers: continue the Ø3.4 bore down to the tray bosses
    for x, y in _screw_centers():
        tower = pl.ring2d(_at(pl.circle(TOWER_D), x, y),
                          _at(pl.circle(SCREW_D), x, y))
        m += pl.prism(tower, TOWER_Z0, z_into_plate)

    # v5.1: socket walls stop AT the seat height — flipped for printing they
    # are plain towers off the slab (no bridges, no supports). The footprint
    # floors live on the separate flat-printed switch deck below.
    keepout = _tower_keepout()
    for key in pl.key_layout():
        m += pl.prism(_socket_wall(key, keepout), seat_z, z_into_plate)

    deck = pl.prism(_deck_profile(), floor_z0, seat_z)
    return [("plate", m, pl.COLORS["plate"]),
            ("switch-deck", deck, "#C9CFD6")]


if __name__ == "__main__":
    items = build()
    all_ok = True
    for name, mesh, _color in items:
        rep = pl.validate(mesh)
        print(name, rep)
        all_ok &= rep["watertight"]

    here = os.path.dirname(os.path.abspath(__file__))
    exports = os.path.normpath(os.path.join(here, "..", "exports"))
    os.makedirs(exports, exist_ok=True)
    out = os.path.join(exports, "preview-plate.glb")
    pl.glb_write(out, items)
    print("wrote", out)
    sys.exit(0 if all_ok else 1)
