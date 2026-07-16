"""part_knob.py — effort dial knob for the Orchestrator Pad (EC11 encoder).

Knurled Ø17 x 15 cylinder: 24 scallop flutes on the rim, blind EC11 D-shaft
bore (Ø6.1, flat at 4.6), 1.5-ish chamfer crown lofting to Ø16, and a
debossed tick dot near the rim. Four overlapping watertight shells merged
into one Mesh (the slicer unions them); world position per SPEC/partlib.

Local frame: z0 = knob bottom; translated to (KNOB_POS, KNOB_Z0) in build().
"""
from __future__ import annotations

import math
import os

import numpy as np
from shapely import affinity
from shapely.ops import unary_union

import partlib as pl

# ---------------- parameters (SPEC.md "Knob" + build recipe) ----------------
KNOB_D = 17.0                    # outer diameter
KNOB_H = 15.0                    # total height
SEG = 96                         # rim / loft segmentation

FLUTES = 24                      # knurl scallop count
FLUTE_D = 1.6                    # scallop cutter diameter
FLUTE_R = 8.9                    # scallop center radius

BORE_D, BORE_FLAT = 6.1, 4.6     # EC11 D-shaft bore profile
BORE_Z1 = 12.0                   # blind bore wall section: 0 -> 12
CEIL_Z0, CEIL_Z1 = 11.8, 13.7    # bore ceiling + upper body (0.2 overlap down)
CROWN_Z0, CROWN_Z1 = 13.5, 14.7  # chamfer loft fluted -> Ø16 (0.2 overlap down)
TOP_D = 16.0                     # crown top / tick layer diameter
TICK_Z0 = 14.5                   # tick-dot layer: 14.5 -> 15.0 (0.2 overlap down)
DOT_SIZE = 3.2                   # glyph("dot") box size -> Ø~1.15 dot
DOT_Y = 5.5                      # dot center offset from axis (near rim)


def fluted_profile():
    """Ø17 circle with 24 Ø1.6 scallops bitten out of the rim (knurl)."""
    scallops = unary_union([
        affinity.translate(pl.circle(FLUTE_D, 24),
                           FLUTE_R * math.cos(a), FLUTE_R * math.sin(a))
        for a in np.linspace(0.0, 2.0 * math.pi, FLUTES, endpoint=False)])
    return pl.circle(KNOB_D, SEG).difference(scallops)


def build():
    """-> [("knob", Mesh, color)] in world position per SPEC."""
    fluted = fluted_profile()
    m = pl.Mesh()

    # 1. knurled body with blind D-shaft bore walls (through this section)
    m += pl.prism(pl.ring2d(fluted, pl.d_shaft(BORE_D, BORE_FLAT)), 0.0, BORE_Z1)

    # 2. bore ceiling + upper body (drops 0.2 into the bore section to fuse)
    m += pl.prism(fluted, CEIL_Z0, CEIL_Z1)

    # 3. chamfer crown: fluted rim lofts to the Ø16 top (0.2 overlap below).
    #    resample_ring + circle() both start at angle 0 -> no loft twist.
    m += pl.loft_solid(pl.resample_ring(fluted, SEG), CROWN_Z0,
                       pl.circle(TOP_D, SEG), CROWN_Z1)

    # 4. tick-dot layer: Ø16 disc with a dot-shaped hole near the rim
    #    (debossed tick marker; layer overlaps the crown top by 0.2)
    dot = affinity.translate(pl.glyph("dot", DOT_SIZE), 0.0, DOT_Y)
    m += pl.prism(pl.circle(TOP_D, SEG).difference(dot), TICK_Z0, KNOB_H)

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
