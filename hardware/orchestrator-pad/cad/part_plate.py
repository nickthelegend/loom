"""part_plate.py — Orchestrator Pad TOP PLATE (SPEC.md "Top plate").

One printable part, built as a union of individually-watertight shells
(no 3D CSG — the slicer unions overlapping shells):

  * plate slab in two Z bands (counterbore trick):
      band A  Z 14.0..14.7  — outline minus 14 MX cutouts, knob hole,
                              4x Ø3.4 screw through-holes
      band B  Z 14.5..15.5  — same, but corner holes are Ø6.4 counterbores
    the 0.2 overlap fuses the bands; net effect: full 1.5 plate with an
    0.8-deep Ø6.4 counterbore over a Ø3.4 through-hole at each corner.
  * skirt (drops into the tray's thinned upper wall), Z 7.5..14.2 — the ring
    is notched so the case can close and USB can mate:
      - Ø8.6 corner clearances at (±39, ±39) around the tray bosses (Ø7.0
        rises to Z 11.5, straight through the skirt band; 0.8 radial gap)
      - 14-wide notch (y 41..44) centered on the USB slot at X=+7.79 so a
        plug can reach through the back wall to the DevKitC receptacle
    the remaining segments each still fuse to plate band A via the 0.2 lap.
  * 4 screw towers Ø7.6/Ø3.4 at (±39, ±39), Z 11.5..14.2
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
import part_tray                    # single source of truth for the USB slot X

# ---- local parameters (SPEC "Top plate" / kernel overlap rule) ------------

OVERLAP = 0.2                       # min Z overlap so shells fuse when sliced
MX_CORNER_R = 0.5                   # MX cutout corner radius
SCREW_D = 3.4                       # M3 through-hole
CBORE_D = 6.4                       # M3 button-head counterbore
CBORE_DEPTH = 0.8                   # counterbore depth from the top face
SKIRT_OUT_W, SKIRT_OUT_R = 86.5, 6.5    # skirt outer profile (rr)
SKIRT_IN_W, SKIRT_IN_R = 84.2, 5.35     # skirt inner profile (1.15 wall)
BOSS_CLEAR_D = 8.6                  # skirt corner notch around the Ø7.0 tray
                                    # bosses (0.8 radial clearance)
USB_NOTCH_W = 14.0                  # skirt notch over the 10.5 USB slot
USB_NOTCH_Y0, USB_NOTCH_Y1 = 41.0, 44.0  # full skirt band (y 42.10..43.25)
TOWER_D = 7.6                       # screw tower outer diameter
TOWER_Z0 = 11.5                     # tray corner-boss top (SPEC "Tray")


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
    """Skirt ring minus the tray-boss corner clearances and the USB notch.

    The Ø7.0 tray bosses rise to Z 11.5 straight through the skirt band
    (their reach past the shared corner-arc center exceeds even the skirt's
    outer radius), and the back band would stand 0.55 behind the USB slot —
    both notches are mandatory for the case to close / the plug to mate.
    The cuts split the ring into segments; every segment still spans the
    full skirt height, so each stays a watertight prism fused to plate
    band A by the 0.2 overlap.
    """
    skirt = pl.ring2d(pl.rounded_rect(SKIRT_OUT_W, SKIRT_OUT_W, SKIRT_OUT_R),
                      pl.rounded_rect(SKIRT_IN_W, SKIRT_IN_W, SKIRT_IN_R))
    boss_clear = unary_union([_at(pl.circle(BOSS_CLEAR_D), x, y)
                              for x, y in _screw_centers()])
    usb_notch = box(part_tray.USB_X - USB_NOTCH_W / 2, USB_NOTCH_Y0,
                    part_tray.USB_X + USB_NOTCH_W / 2, USB_NOTCH_Y1)
    return skirt.difference(boss_clear).difference(usb_notch)


def build():
    z_a1 = pl.PLATE_Z1 - CBORE_DEPTH        # 14.7 — deep band top
    z_b0 = z_a1 - OVERLAP                   # 14.5 — counterbore band bottom
    z_into_plate = pl.PLATE_Z0 + OVERLAP    # 14.2 — skirt/tower fuse height

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

    return [("plate", m, pl.COLORS["plate"])]


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
