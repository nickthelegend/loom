"""audit_probe.py — adversarial FDM/assembly audit probes (throwaway).

Checks, numerically:
  B. per-part shell fuse graph (bbox, z-overlap >= 0.099) -> no floating shells
  C. 2D profile analytics rebuilt from the part constants:
     - plate skirt annulus vs tray corner bosses (COLLISION?)
     - plate skirt vs USB-C slot zone (does the skirt wall stand behind the slot?)
     - plate tower vs tray thin-wall clearance
     - skirt vs tray wall clearance
     - cap side-wall min thickness over z
     - keycap stem cross tab min feature (erosion -0.4)
     - glyph crown islands + web min feature (erosion -0.4)
     - knurl peak width (erosion test, cosmetic)
     - plate / tray band profiles erosion -0.4 (min feature >= 0.8)
"""
import math

import numpy as np
from shapely import affinity
from shapely.geometry import box, LineString, Polygon
from shapely.ops import unary_union

import partlib as pl
import part_tray as pt
import part_plate as pp
import part_caps as pc
import part_knob as pk


def shells_of(mesh):
    """Union-find faces into shells; return list of (zmin, zmax, bbox2d, ntris)."""
    V, F = mesh._np()
    parent = list(range(len(F)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    by_edge = {}
    for fi, (a, b, c) in enumerate(F):
        for e in ((a, b), (b, c), (c, a)):
            k = (min(e), max(e))
            if k in by_edge:
                union(fi, by_edge[k])
            else:
                by_edge[k] = fi
    groups = {}
    for fi in range(len(F)):
        groups.setdefault(find(fi), []).append(fi)
    out = []
    for faces in groups.values():
        vids = set()
        for fi in faces:
            vids.update(F[fi])
        pts = V[list(vids)]
        out.append((pts[:, 2].min(), pts[:, 2].max(),
                    (pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max()),
                    len(faces)))
    return out


def fuse_components(shells, min_ovl=0.099):
    n = len(shells)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    edges = 0
    for i in range(n):
        z0i, z1i, (xa, xb, ya, yb), _ = shells[i]
        for j in range(i + 1, n):
            z0j, z1j, (xc, xd, yc, yd), _ = shells[j]
            zov = min(z1i, z1j) - max(z0i, z0j)
            if zov < min_ovl:
                continue
            if xb < xc - 1e-9 or xd < xa - 1e-9 or yb < yc - 1e-9 or yd < ya - 1e-9:
                continue
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[ri] = rj
            edges += 1
    comps = len({find(i) for i in range(n)})
    return comps, edges


print("== B. fuse graph (floating-shell check) ==")
for label, items in [("tray", pt.build()), ("plate", pp.build()),
                     ("knob", pk.build())] + [("cap:" + n, [(n, m, c)])
                                              for n, m, c in pc.build()]:
    for name, mesh, _c in items:
        sh = shells_of(mesh)
        comps, edges = fuse_components(sh)
        zr = [(round(a, 2), round(b, 2)) for a, b, _, _ in sh]
        flag = "OK " if comps == 1 else "FAIL"
        print(f"  {flag} {label}/{name}: shells={len(sh)} fuse-components={comps}")
        if comps != 1:
            for s in sh:
                print("      shell z", round(s[0], 2), "..", round(s[1], 2), "bbox", s[2])

print()
print("== C. profile analytics ==")

# --- rebuild the exact 2D profiles from the part constants ---
skirt_out = pl.rounded_rect(pp.SKIRT_OUT_W, pp.SKIRT_OUT_W, pp.SKIRT_OUT_R)
skirt_in = pl.rounded_rect(pp.SKIRT_IN_W, pp.SKIRT_IN_W, pp.SKIRT_IN_R)
skirt = pl.ring2d(skirt_out, skirt_in)
tray_thin_inner = pl.rounded_rect(pl.CASE_W - 2 * pt.SKIRT_WALL,
                                  pl.CASE_W - 2 * pt.SKIRT_WALL,
                                  pl.CASE_R - pt.SKIRT_WALL)
tray_thick_inner = pl.rounded_rect(pl.CASE_W - 2 * pl.WALL, pl.CASE_W - 2 * pl.WALL,
                                   pl.CASE_R - pl.WALL)

print("-- skirt (z 7.5..14.2) vs tray corner bosses (z 5.3..11.5): Z overlap 7.5..11.5")
for sx in (1, -1):
    for sy in (1, -1):
        boss = affinity.translate(pl.circle(pt.BOSS_D), sx * pl.BOSS_XY, sy * pl.BOSS_XY)
        inter = skirt.intersection(boss)
        # penetration: how far the boss crosses past the skirt INNER boundary
        pen_in = boss.exterior.distance(skirt_in.exterior)
        outside = boss.difference(skirt_in)   # boss material outside skirt inner face
        print(f"   boss({sx*39:+.0f},{sy*39:+.0f}): overlap-with-skirt-band area="
              f"{inter.area:.2f} mm^2, boss-area-outside-skirt-inner-face={outside.area:.2f} mm^2")
# radial penetration along the diagonal
c = (pp.SKIRT_IN_W / 2 - pp.SKIRT_IN_R)
d_center = math.hypot(39 - c, 39 - c)
print(f"   diagonal: boss reach from skirt corner-arc center = {d_center + 3.5:.3f} "
      f"vs skirt inner R {pp.SKIRT_IN_R} / outer R {pp.SKIRT_OUT_R} "
      f"-> radial penetration past inner face = {d_center + 3.5 - pp.SKIRT_IN_R:.3f} mm")

print("-- skirt vs USB-C slot zone (slot x +-5.25, z 6.4..10.9; skirt z 7.5..14.2)")
usb_zone = box(-pt.USB_W / 2, 40.0, pt.USB_W / 2, 45.0)
blocked = skirt.intersection(usb_zone)
print(f"   skirt material inside slot x-range at back wall: area={blocked.area:.2f} mm^2 "
      f"(y-extent {blocked.bounds[1]:.2f}..{blocked.bounds[3]:.2f}) "
      f"-> solid wall behind slot for z 7.5..10.9: {'YES - BLOCKS USB' if blocked.area > 1 else 'no'}")

print("-- plate screw tower vs tray thin wall inner face (both exist z 11.5..14.0)")
tower = affinity.translate(pl.circle(pp.TOWER_D), 39, 39)
print(f"   min gap tower->tray thin inner boundary = "
      f"{tower.exterior.distance(tray_thin_inner.exterior):.3f} mm "
      f"(tower inside? {tray_thin_inner.contains(tower)})")

print("-- skirt outer vs tray thin wall inner (seat slop)")
print(f"   min gap = {skirt_out.exterior.distance(tray_thin_inner.exterior):.3f} mm per side")

print("-- skirt bottom seat on tray ledge: contact width")
ledge = pl.ring2d(tray_thin_inner, tray_thick_inner)   # annulus 42.6..43.8
seat = skirt.intersection(ledge)
print(f"   skirt/ledge overlap area={seat.area:.1f} mm^2 of skirt {skirt.area:.1f} mm^2; "
      f"straight-side contact width = {43.8 - 43.25:.2f}... "
      f"skirt band 42.1..43.25 vs ledge 42.6..43.8 -> {43.25 - 42.6:.2f} mm wide ring contact")

print("-- cap side wall thickness over z (1u and 2u)")
for units in (1, 2):
    (ow, oh, orr), (tw, th, trr), (iw, ih, irr) = pc.SIZES[units]
    base = pl.rounded_rect(ow, oh, orr)
    top = pl.rounded_rect(tw, th, trr)
    cav = pl.rounded_rect(iw, ih, irr)
    bpts = np.array(pl._rings(base)[0])
    tpts = np.array(pl._rings(top)[0])
    worst = (1e9, None)
    for z in np.linspace(0, pc.CAVITY_TOP, 30):
        t = z / pc.BODY_TOP
        sec = Polygon(bpts * (1 - t) + tpts * t)
        d = sec.exterior.distance(cav.exterior)
        if d < worst[0]:
            worst = (d, z)
    print(f"   {units}u: min wall {worst[0]:.3f} mm at z={worst[1]:.2f} (cavity top {pc.CAVITY_TOP})")

print("-- keycap stem: erosion -0.4 feature test + slot-end tab thickness")
cross = box(-pc.SLOT_L / 2, -pc.SLOT_W / 2, pc.SLOT_L / 2, pc.SLOT_W / 2).union(
    box(-pc.SLOT_W / 2, -pc.SLOT_L / 2, pc.SLOT_W / 2, pc.SLOT_L / 2))
stem = pl.circle(pc.STEM_D).difference(cross)
er = stem.buffer(-0.4)
n_before = len(pl._polys(stem))
n_after = len(pl._polys(er))
tab = pc.STEM_D / 2 - pc.SLOT_L / 2
print(f"   stem profile pieces {n_before} -> after -0.4 erosion {n_after} "
      f"(pieces lost = features <0.8 mm); slot-end tab = {tab:.3f} mm; "
      f"slot {pc.SLOT_W} x {pc.SLOT_L}, depth {pc.STEM_Z1 - pc.STEM_Z0:.1f}")

print("-- glyph crown: islands & webs, erosion -0.4 (crown 16.4 sq)")
ot = pl.rounded_rect(16.4, 16.4, 2.2)
for g in ["X", "C", "A", "O", "K", "bolt", "check", "cross",
          "prompt", "mic", "send", "dot", "ring", "target"]:
    crown = ot.difference(pl.glyph(g, pc.GLYPH_SIZE))
    parts = pl._polys(crown)
    er = crown.buffer(-0.4)
    lost = len(parts) - len(pl._polys(er))
    # min groove width: erode the glyph itself
    gg = pl.glyph(g, pc.GLYPH_SIZE)
    groove_ok = not gg.buffer(-0.35).is_empty        # >=0.7 groove
    isl = sorted(p.area for p in parts)[:-1]         # all but the big web
    print(f"   {g:7s} crown pieces={len(parts)} lost@-0.4={lost} "
          f"islands(area mm^2)={[round(a,2) for a in isl]} groove>=0.7:{groove_ok}")

print("-- knob knurl peaks (cosmetic) and bore wall")
fl = pk.fluted_profile()
er2 = fl.buffer(-0.36)   # peaks < ~0.72 wide vanish
print(f"   fluted area {fl.area:.1f} -> -0.36 erosion pieces={len(pl._polys(er2))} "
      f"(peaks are decorative cusps ~0.7 mm wide)")
bore = pl.d_shaft(pk.BORE_D, pk.BORE_FLAT)
ring = pl.ring2d(fl, bore)
print(f"   min bore-to-flute wall = {fl.exterior.distance(bore.exterior)- 0:.3f} "
      f"... ring erosion -0.6 pieces={len(pl._polys(ring.buffer(-0.6)))}")

print("-- plate profiles erosion -0.4 (min web >= 0.8 check)")
for nm, d in [("bandA(3.4)", pp.SCREW_D), ("bandB(6.4)", pp.CBORE_D)]:
    prof = pp._plate_profile(d)
    before = len(pl._polys(prof))
    after = len(pl._polys(prof.buffer(-0.4)))
    print(f"   {nm}: pieces {before} -> {after} after -0.4 (lost => <0.8 feature)")

print("-- tray band profiles erosion -0.4")
outer = pl.rounded_rect(pl.CASE_W, pl.CASE_W, pl.CASE_R)
ring_thick = pl.ring2d(outer, tray_thick_inner)
ring_thin = pl.ring2d(outer, tray_thin_inner)
usb = box(-pt.USB_W / 2, pt.CUT_IN, pt.USB_W / 2, pt.CUT_OUT)
mics = unary_union([box(x - pt.MIC_W / 2, -pt.CUT_OUT, x + pt.MIC_W / 2, -pt.CUT_IN)
                    for x in pt.MIC_XS])
reset = box(pt.CUT_IN, pt.RESET_Y - pt.RESET_W / 2, pt.CUT_OUT, pt.RESET_Y + pt.RESET_W / 2)
ports = mics.union(reset)
for nm, prof in [("thick-usb", ring_thick.difference(usb)),
                 ("thick-usb-ports", ring_thick.difference(usb).difference(ports)),
                 ("thin-usb-ports", ring_thin.difference(usb).difference(ports)),
                 ("thin-usb", ring_thin.difference(usb))]:
    b = len(pl._polys(prof))
    a = len(pl._polys(prof.buffer(-0.4)))
    print(f"   {nm}: pieces {b} -> {a} after -0.4")

print("-- assembled clearances (world)")
print(f"   cap-cap gap: {pl.PITCH - 18.2:.2f} mm;  voice-edge to 1u-edge: "
      f"{(pl.COL_X[3] - 9.1) - 37.25 / 2:.2f} mm")
knob = affinity.translate(pl.circle(pk.KNOB_D), *pl.KNOB_POS)
cap1 = affinity.translate(pl.rounded_rect(18.2, 18.2, 2.5), pl.COL_X[1], pl.ROW_Y[0])
print(f"   knob to preset1 cap gap: {knob.distance(cap1):.2f} mm")
print(f"   knob bottom {pl.KNOB_Z0} vs plate top {pl.PLATE_Z1}: gap {pl.KNOB_Z0 - pl.PLATE_Z1:.1f} mm "
      f"(EC11 M7 panel nut is ~2.0-2.4 mm tall, nut dia ~10-11 > bore 6.1)")
