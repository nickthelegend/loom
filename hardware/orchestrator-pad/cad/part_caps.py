"""part_caps.py — all 14 keycaps for the Orchestrator Pad (13 x 1u + 1 x 2u).

Each cap is a union of individually-watertight shells (no 3D CSG; the slicer
unions overlapping shells):

  1. main body   — ONE welded closed shell: tapered outer loft wall, flat top
                   at Z 6.9, bottom rim (outer minus cavity), cavity wall
                   (CW ring -> normals face the cavity) and cavity ceiling.
  2. glyph crown — top of the cap as prism(OT minus glyph, 6.5 -> 7.5): the
                   0.6 mm deboss (glyph floor = body top at 6.9). Starts
                   0.4 mm below the body top so it fuses; glyph islands
                   (center of `O`, `ring`, `target`) become their own
                   overlapping shells automatically.
  3. stem        — MX post Ø5.8 with 4.15 x 1.35 cross slots, Z 2.0 -> 6.1:
                   3.9 mm below the cavity ceiling (5.9) and overlapping
                   0.2 mm into it.

build() -> [(key id, Mesh, "#RRGGBB")] in WORLD position: each cap at its
key_layout() (x, y) with the bottom face at Z = partlib.CAP_Z0.
"""
from __future__ import annotations

import os

from shapely.geometry import box

import partlib as pl

# ---------------------------------------------------------------- sizes ----
# SPEC.md "Keycaps": 1u base 18.2 sq R2.5 -> top 16.4 sq R2.2, height 7.5,
# wall 1.6 (cavity 15.0 sq R2.0); 2u voice bar 37.25/35.4/34.0 wide.
CAP_H = 7.5                 # total height (top face of the glyph crown)
BODY_TOP = 6.9              # main-shell top = glyph floor (0.6 deboss)
CROWN_Z0 = 6.5              # crown start: 0.4 overlap into the body
CAVITY_TOP = 5.9            # cavity ceiling height
GLYPH_SIZE = 9.0            # fits inside OT with >1.5 mm margin

# (w, h, r) for outer-base, outer-top, inner-cavity profiles per key width.
SIZES = {
    1: ((18.2, 18.2, 2.5), (16.4, 16.4, 2.2), (15.0, 15.0, 2.0)),
    2: ((37.25, 18.2, 2.5), (35.4, 16.4, 2.2), (34.0, 15.0, 2.0)),
}

STEM_D = 5.8                # MX post diameter
SLOT_L, SLOT_W = 4.15, 1.35  # friction-fit cross slots
STEM_Z0 = 2.0
STEM_Z1 = CAVITY_TOP + 0.2  # 6.1 — fuse into the cavity ceiling


def _hollow_body(ob, ot, ib):
    """Hollow tapered cap body as one welded, closed shell."""
    m = pl.Mesh(weld=True)
    m.add_loft_wall(pl._rings(ob)[0], 0.0, pl._rings(ot)[0], BODY_TOP)
    m.add_cap(ot, BODY_TOP, up=True)                              # top face
    m.add_cap(ob.difference(ib), 0.0, up=False)                   # bottom rim
    m.add_ring_wall(list(reversed(pl._rings(ib)[0])), 0.0, CAVITY_TOP)
    m.add_cap(ib, CAVITY_TOP, up=False)                           # cavity ceiling
    return m


def _stem():
    """Center MX stem: Ø5.8 post with the cross slots subtracted in 2D."""
    cross = box(-SLOT_L / 2, -SLOT_W / 2, SLOT_L / 2, SLOT_W / 2).union(
        box(-SLOT_W / 2, -SLOT_L / 2, SLOT_W / 2, SLOT_L / 2))
    return pl.prism(pl.circle(STEM_D).difference(cross), STEM_Z0, STEM_Z1)


def _cap(key):
    """One finished keycap (local Z0 at the bottom) moved to world position."""
    ob, ot, ib = (pl.rounded_rect(*dims) for dims in SIZES[key["units"]])
    m = _hollow_body(ob, ot, ib)
    m += pl.prism(ot.difference(pl.glyph(key["glyph"], GLYPH_SIZE)),
                  CROWN_Z0, CAP_H)                                # glyph crown
    m += _stem()
    return m.translate(key["x"], key["y"], pl.CAP_Z0)


def build():
    """All 14 caps: [(key id, Mesh in world position, key color)]."""
    return [(k["id"], _cap(k), k["color"]) for k in pl.key_layout()]


if __name__ == "__main__":
    items = build()
    all_ok, tris = True, 0
    for name, mesh, _ in items:
        rep = pl.validate(mesh)
        all_ok &= rep["watertight"]
        tris += rep["triangles"]
        print(f"{name:12s} shells={rep['shells']:2d} tris={rep['triangles']:5d} "
              f"vol={rep.get('volume_mm3', float('nan')):9.2f} "
              f"watertight={rep['watertight']} {rep['problems'][:2]}")
    exports = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exports")
    os.makedirs(exports, exist_ok=True)
    out = os.path.join(exports, "preview-caps.glb")
    pl.glb_write(out, items)
    print(f"{'PASS' if all_ok else 'FAIL'}: {len(items)} caps, "
          f"{tris} triangles -> {out}")
