"""part_knob.py — effort dial knob for the Orchestrator Pad.

v7.1 MOCK knob: there is no potentiometer/EC11 in this build (hold-to-talk,
no dial electronics), so the knob is a display piece that CLIPS STRAIGHT INTO
the plate's Ø7.4 knob hole and spins freely — a snap-fit split peg on the
underside, no encoder shaft needed. The plate is unchanged: only this part
differs from an EC11 build (the old bored knob lives in git history).

Knurled Ø17 x 15 cylinder: 24 scallop flutes on the rim, a 1.2-ish chamfer
crown lofting to Ø16, a debossed tick dot near the rim, and a downward snap
peg. The peg is a Ø7.2 tube split by cross-slots into 4 flex fingers with a
Ø8.2 barb at the tip: push it through the Ø7.4 plate hole, the fingers
compress, and the barb springs out under the plate — the knob body rests on
the plate top and the barb catches the underside, so it stays on and turns.

Prints CROWN-DOWN (peg pointing up) so nothing overhangs — no supports.

Local frame: z0 = knob bottom (rests on the plate top); the body is +z, the
snap peg is -z. Translated to (KNOB_POS, KNOB_Z0) in build().
"""
from __future__ import annotations

import math
import os

import numpy as np
from shapely import affinity
from shapely.geometry import box
from shapely.ops import unary_union

import partlib as pl

# ---------------- body parameters (SPEC.md "Knob") --------------------------
KNOB_D = 17.0                    # outer diameter
KNOB_H = 15.0                    # total body height
SEG = 96                         # rim / loft segmentation

FLUTES = 24                      # knurl scallop count
FLUTE_D = 1.6                    # scallop cutter diameter
FLUTE_R = 8.9                    # scallop center radius

BODY_TOP = 13.7                  # solid body 0 -> 13.7 (was the EC11 bore zone)
CROWN_Z0, CROWN_Z1 = 13.5, 14.7  # chamfer loft fluted -> Ø16 (0.2 overlap down)
TOP_D = 16.0                     # crown top / tick layer diameter
TICK_Z0 = 14.5                   # tick-dot layer: 14.5 -> 15.0 (0.2 overlap down)
DOT_SIZE = 3.2                   # glyph("dot") box size -> Ø~1.15 dot
DOT_Y = 5.5                      # dot center offset from axis (near rim)

# ---------------- mock snap-fit peg -----------------------------------------
PLATE_T = pl.PLATE_Z1 - pl.PLATE_Z0     # 1.5 — plate the barb clamps under
PEG_D = 7.2                      # shaft OD: 0.1/side clearance in the Ø7.4 hole
#                                  -> the knob spins freely
PEG_BORE = 4.6                   # hollow core so the split fingers can flex
BARB_D = 8.2                     # snap-flange OD (0.4 catch under the Ø7.4 hole)
SLOT_W = 1.2                     # cross-slot width — splits the peg into 4 fingers
LEDGE_Z = -(PLATE_T + 0.2)       # -1.7: barb catch face, 0.2 below the plate
#                                  bottom -> ~0.2 axial play so it turns freely


def fluted_profile():
    """Ø17 circle with 24 Ø1.6 scallops bitten out of the rim (knurl)."""
    scallops = unary_union([
        affinity.translate(pl.circle(FLUTE_D, 24),
                           FLUTE_R * math.cos(a), FLUTE_R * math.sin(a))
        for a in np.linspace(0.0, 2.0 * math.pi, FLUTES, endpoint=False)])
    return pl.circle(KNOB_D, SEG).difference(scallops)


def _peg_slots():
    """A plus-shaped cutter that severs the peg annulus into 4 flex fingers."""
    b = KNOB_D
    return box(-b, -SLOT_W / 2, b, SLOT_W / 2).union(
        box(-SLOT_W / 2, -b, SLOT_W / 2, b))


def _snap_peg():
    """4-finger snap peg (local -z), fused into the body bottom at z 0..0.4."""
    m = pl.Mesh()
    bore = pl.circle(PEG_BORE, 48)
    slots = _peg_slots()

    def ann(od):                                     # slotted annulus -> 4 fingers
        return pl.ring2d(pl.circle(od, 48), bore).difference(slots)

    # unslit collar: joins the 4 fingers to the body (0.4 into the solid body)
    m += pl.prism(pl.ring2d(pl.circle(PEG_D, 48), bore), -0.5, 0.4)
    # flex fingers (shaft) down to the barb
    m += pl.prism(ann(PEG_D), LEDGE_Z - 0.3, -0.3)
    # barb: catch ledge (up face) at LEDGE_Z; wider than the hole
    m += pl.prism(ann(BARB_D), LEDGE_Z - 0.5, LEDGE_Z)
    # stepped lead-in chamfer under the barb (self-centers on insertion)
    m += pl.prism(ann(7.6), LEDGE_Z - 0.7, LEDGE_Z - 0.3)
    m += pl.prism(ann(6.6), LEDGE_Z - 0.9, LEDGE_Z - 0.5)
    return m


def build():
    """-> [("knob", Mesh, color)] in world position per SPEC."""
    fluted = fluted_profile()
    m = pl.Mesh()

    # 1. solid knurled body (no EC11 bore — mock knob)
    m += pl.prism(fluted, 0.0, BODY_TOP)

    # 2. chamfer crown: fluted rim lofts to the Ø16 top (0.2 overlap below).
    #    resample_ring + circle() both start at angle 0 -> no loft twist.
    m += pl.loft_solid(pl.resample_ring(fluted, SEG), CROWN_Z0,
                       pl.circle(TOP_D, SEG), CROWN_Z1)

    # 3. tick-dot layer: Ø16 disc with a dot-shaped hole near the rim
    #    (debossed tick marker; layer overlaps the crown top by 0.2)
    dot = affinity.translate(pl.glyph("dot", DOT_SIZE), 0.0, DOT_Y)
    m += pl.prism(pl.circle(TOP_D, SEG).difference(dot), TICK_Z0, KNOB_H)

    # 4. mock snap-fit peg on the underside (clips into the plate hole)
    m += _snap_peg()

    m.translate(pl.KNOB_POS[0], pl.KNOB_POS[1], pl.KNOB_Z0)
    return [("knob", m, pl.COLORS["knob"])]


if __name__ == "__main__":
    items = build()
    ok = True
    for name, mesh, _color in items:
        rep = pl.validate(mesh)
        print(f"{name}: {rep}")
        ok &= rep["watertight"]

    here = os.path.dirname(os.path.abspath(__file__))
    exports = os.path.join(os.path.dirname(here), "exports")
    os.makedirs(exports, exist_ok=True)
    out = os.path.join(exports, "preview-knob.glb")
    pl.glb_write(out, items)
    print("wrote", out)
    print("KNOB", "PASS" if ok else "FAIL")
    raise SystemExit(0 if ok else 1)
