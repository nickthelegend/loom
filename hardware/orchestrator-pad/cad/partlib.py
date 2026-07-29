"""partlib — pure-python CAD kernel for the Orchestrator Pad.

Everything is built from 2D shapely profiles extruded/lofted into closed
triangle shells. There is deliberately NO 3D CSG: each printable part is a
union of individually-watertight shells (overlapping or coplanar shells are
merged by the slicer). 2D booleans (shapely) are allowed and encouraged.

Units: mm. X right, Y back, Z up. See SPEC.md for the dimensional contract.

Typical use:
    m = Mesh()
    m += prism(rounded_rect(90, 90, 8), 0.0, 2.4)              # a slab
    m += prism(ring2d(rounded_rect(90,90,8), rounded_rect(85.2,85.2,6.8)), 2.4, 14)
    report = validate(m)   # every connected shell must be closed & manifold
    stl_write("tray.stl", m)
    glb_write("tray.glb", [("tray", m, "#AEB4BC")])
"""
from __future__ import annotations

import json
import math
import struct

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

EPS = 1e-9

# ---------------------------------------------------------------- spec ----

PITCH = 19.05
COL_X = [-1.5 * PITCH, -0.5 * PITCH, 0.5 * PITCH, 1.5 * PITCH]
ROW_Y = [1.5 * PITCH, 0.5 * PITCH, -0.5 * PITCH, -1.5 * PITCH]

CASE_W = 90.0
CASE_R = 8.0
TRAY_H = 40.0          # v7: taller/fatter case (+12 over v6's 28) — lots of
#                        open headroom above the board (~24 mm now)
WALL = 2.4
FLOOR = 2.4
LEDGE_Z = 33.5         # above this the tray wall thins to 1.2 (skirt seat)
BOSS_XY = 39.0         # corner boss / screw centers at (+-39, +-39)
PLATE_Z0, PLATE_Z1 = 40.0, 41.5
MX_CUT = 14.1
KNOB_HOLE_D = 7.4
CAP_Z0 = 47.0          # assembled: keycap bottom face height
KNOB_Z0 = 41.5         # v7.1: mock knob rests ON the plate top (snap-fit peg,
#                        no potentiometer) instead of floating over an EC11 nut

# v4 fat-base component bay (SPEC.md "Tray"): dual-USB-C ESP32-S3 clone board
# with factory pin headers (pins DOWN, components + USB-C on TOP), down-firing
# cavity speaker under the board, MAX98357A amp, round I2S mic.
BOARD_Z = 16.0         # board underside height (shelf/bridge top faces)
BOARD_W = 30.0         # board width in Y (|y|<=15; caged by the flat cage)
BOARD_L = 64.0         # board max length (Y, back edge at Y=+42.0)
USB_WIN = (26.0, 17.0, 23.5)   # back-wall USB window: (width, z0, z1), X=0
SPK_CENTER = (0.0, -21.0)      # speaker center (flange ON the floor)
SPK_FLANGE = (72.0, 42.0)      # max flange footprint (X x Y)
SPK_BUMP_MAX = 11.0            # max driver-bump height above the 1.5 flange

COLORS = {
    "tray": "#AEB4BC", "plate": "#F4F5F7", "knob": "#E8E9EB",
    "preset": "#D8DCE2", "codex": "#6366F1", "claude": "#D97757",
    "antigravity": "#2D6BFF", "opencode": "#FAFAF8", "kiro": "#7A3FF2",
    "cursor": "#26282E", "grok": "#141414", "util": "#FFFFFF", "voice": "#FFFFFF",
}

# glyph legend infills (printed/painted contrast fill in the deboss):
# white on colored caps, dark on white/light caps so every legend is legible
LEGEND_LIGHT = "#FFFFFF"
LEGEND_DARK = "#3F444D"
LEGEND_MID = "#8A919E"


def key_layout():
    """All 14 switch positions: id, glyph, grid center, width in units,
    cap color, legend (infill) color."""
    K = lambda i, g, c, r, u, col, leg: dict(
        id=i, glyph=g, x=COL_X[c] if u == 1 else 0.0, y=ROW_Y[r], units=u,
        color=col, legend=leg)
    return [
        K("cursor",  "cursor", 1, 0, 1, COLORS["cursor"], LEGEND_LIGHT),
        K("codex",   "codex",  2, 0, 1, COLORS["codex"], LEGEND_LIGHT),
        K("preset3", "target", 3, 0, 1, COLORS["preset"], LEGEND_MID),
        K("grok",    "grok",   0, 1, 1, COLORS["grok"], LEGEND_LIGHT),
        K("claude",  "claude", 1, 1, 1, COLORS["claude"], LEGEND_LIGHT),
        K("antigravity", "antigravity", 2, 1, 1, COLORS["antigravity"], LEGEND_LIGHT),
        K("opencode", "opencode", 3, 1, 1, COLORS["opencode"], LEGEND_DARK),
        K("kiro",    "kiro",   0, 2, 1, COLORS["kiro"], LEGEND_LIGHT),
        K("run",     "bolt",   1, 2, 1, COLORS["util"], LEGEND_DARK),
        K("approve", "check",  2, 2, 1, COLORS["util"], LEGEND_DARK),
        K("reject",  "cross",  3, 2, 1, COLORS["util"], LEGEND_DARK),
        K("prompt",  "prompt", 0, 3, 1, COLORS["util"], LEGEND_DARK),
        K("voice",   "mic",    0, 3, 2, COLORS["voice"], LEGEND_DARK),  # x forced to 0
        K("send",    "send",   3, 3, 1, COLORS["util"], LEGEND_DARK),
    ]


KNOB_POS = (COL_X[0], ROW_Y[0])

# ------------------------------------------------------------ 2D shapes ----

def rounded_rect(w, h, r, seg=10):
    """Axis-aligned rounded rectangle centered at origin (CCW)."""
    r = min(r, w / 2 - 1e-6, h / 2 - 1e-6)
    cx, cy = w / 2 - r, h / 2 - r
    corners = [((cx, -cy), -90), ((cx, cy), 0), ((-cx, cy), 90), ((-cx, -cy), 180)]
    pts = []
    for (ox, oy), a0 in corners:
        for t in np.linspace(math.radians(a0), math.radians(a0 + 90), seg + 1):
            pts.append((ox + r * math.cos(t), oy + r * math.sin(t)))
    return Polygon(pts)


def circle(d, seg=64):
    t = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    return Polygon(np.column_stack([d / 2 * np.cos(t), d / 2 * np.sin(t)]))


def ring2d(outer, inner):
    """outer minus inner — convenience for wall/annulus profiles."""
    return outer.difference(inner)


def d_shaft(d=6.1, flat=4.6, seg=64):
    """EC11 D-shaft bore profile: circle of dia d with a flat at `flat` from
    the round side (flat faces +X)."""
    c = circle(d, seg)
    return c.intersection(box(-d / 2 - 1, -d / 2 - 1, flat - d / 2, d / 2 + 1))


def resample_ring(poly, n, start_angle=0.0):
    """Resample a polygon's exterior to exactly n points by arclength,
    starting near the boundary point in direction start_angle from centroid.
    Use to give two profiles matching vertex counts before loft_solid()."""
    ring = orient(poly, 1.0).exterior
    L = ring.length
    cx, cy = poly.centroid.x, poly.centroid.y
    probe = LineString([(cx, cy), (cx + 1e4 * math.cos(start_angle),
                                   cy + 1e4 * math.sin(start_angle))])
    hit = ring.intersection(probe)
    d0 = ring.project(list(hit.geoms)[0] if hit.geom_type.startswith("Multi") else
                      (hit if hit.geom_type == "Point" else Point(ring.coords[0])))
    pts = [ring.interpolate((d0 + L * i / n) % L) for i in range(n)]
    return Polygon([(p.x, p.y) for p in pts])

# --------------------------------------------------------------- glyphs ----

def _stroke(coords, w=1.9):
    return LineString(coords).buffer(w / 2, quad_segs=6)


def _arc(cx, cy, r, a0, a1, n=40):
    t = np.linspace(math.radians(a0), math.radians(a1), n)
    return list(np.column_stack([cx + r * np.cos(t), cy + r * np.sin(t)]))


def _smooth(g, r):
    return g.buffer(r, quad_segs=8).buffer(-r, quad_segs=8)


# Logo silhouettes (v2 caps). Deboss semantics: the geometry is cut into the
# cap top; interior holes (eyes, cube facet, frame window) stay RAISED and
# read as the logo's negative space. Simplified geometric homages — the
# original marks belong to their respective projects.

def _logo_claude():
    """Claude Code pixel-pal: blocky body, ear tabs, square eyes, leg slots."""
    body = unary_union([
        box(-3.5, -3.9, 3.5, 3.7),
        box(-4.65, 0.4, -3.5, 2.2),
        box(3.5, 0.4, 4.65, 2.2),
    ])
    for hole in (box(-2.5, 1.1, -1.35, 2.3), box(1.35, 1.1, 2.5, 2.3),
                 box(-2.35, -4.2, -1.35, -2.0), box(1.35, -4.2, 2.35, -2.0)):
        body = body.difference(hole)
    return body


def _logo_antigravity():
    """Antigravity arch: gaussian bell stroked with round feet."""
    xs = np.linspace(-4.15, 4.15, 61)
    ys = -3.15 + 6.9 * np.exp(-((xs / 2.15) ** 2))
    return LineString(np.column_stack([xs, ys])).buffer(1.28, quad_segs=10)


def _logo_opencode():
    """opencode terminal frame: heavy block with an offset window (raised)."""
    return box(-3.0, -4.0, 3.0, 4.0).difference(box(-1.25, -1.55, 1.85, 2.2))


def _logo_kiro():
    """Kiro ghost: dome, scalloped feet, two round eyes (raised)."""
    body = unary_union([
        Point(0, 0.9).buffer(2.95, quad_segs=16),
        box(-2.95, -3.1, 2.95, 0.9),
        Point(-2.4, -3.1).buffer(0.9, quad_segs=10),
    ])
    body = body.difference(Point(-0.65, -3.35).buffer(1.05, quad_segs=10))
    body = body.difference(Point(1.85, -3.35).buffer(1.05, quad_segs=10))
    body = _smooth(body, 0.35)
    body = body.difference(Point(-0.85, 1.15).buffer(0.62, quad_segs=10))
    body = body.difference(Point(1.05, 1.15).buffer(0.62, quad_segs=10))
    return body


def _logo_cursor():
    """Cursor cube: pointy-top hexagon with a folded facet (raised wedge)."""
    hexpts = [(4.05 * math.cos(math.radians(a)), 4.05 * math.sin(math.radians(a)))
              for a in range(90, 451, 60)]
    hexagon = _smooth(Polygon(hexpts), 0.35)
    return hexagon.difference(Polygon([(-1.15, 0.55), (3.42, 1.62), (0.12, -3.88)]))


def _logo_codex():
    """Codex cloud: 7-lobe puff with a raised >_ prompt inside."""
    lobes = [Point(2.55 * math.cos(math.radians(a)),
                   2.55 * math.sin(math.radians(a))).buffer(rr, quad_segs=14)
             for a, rr in [(95, 2.25), (40, 2.0), (-5, 2.05), (-55, 2.0),
                           (-115, 2.1), (-170, 2.0), (145, 2.05)]]
    cloud = _smooth(unary_union(lobes + [Point(0, 0).buffer(3.3, quad_segs=16)]), 0.45)
    chev = _stroke([(-2.05, 1.45), (-0.55, 0.1), (-2.05, -1.25)], 1.2)
    bar = box(0.15, -1.45, 2.05, -0.5)
    return cloud.difference(chev.union(bar))


def _logo_grok():
    """Grok: circle broken by a long diagonal slash with pointed ends."""
    ring = _stroke(_arc(0, 0, 2.95, 0, 360, 90), 1.15)
    blade = affinity.rotate(
        Polygon([(-6.1, 0), (0, 0.6), (6.1, 0), (0, -0.6)]), 45, origin=(0, 0))
    blade = blade.intersection(box(-4.6, -4.6, 4.6, 4.6))
    return ring.difference(blade.buffer(0.5)).union(blade)


def glyph(name, size=10.0):
    """Deboss glyph as shapely geometry in a size x size box centered at 0."""
    g = {
        "X": lambda: _stroke([(-3.4, -4), (3.4, 4)]).union(_stroke([(-3.4, 4), (3.4, -4)])),
        "C": lambda: _stroke(_arc(0, 0, 3.9, 40, 320)),
        "A": lambda: unary_union([_stroke([(-3.6, -4.2), (0, 4.2)]),
                                  _stroke([(0, 4.2), (3.6, -4.2)]),
                                  _stroke([(-1.9, -1.2), (1.9, -1.2)])]),
        "O": lambda: _stroke(_arc(0, 0, 3.9, 0, 360, 72)),
        "K": lambda: unary_union([_stroke([(-3.2, -4.2), (-3.2, 4.2)]),
                                  _stroke([(-3.0, -0.4), (3.1, 4.2)]),
                                  _stroke([(-1.2, 1.0), (3.2, -4.2)])]),
        "bolt": lambda: Polygon([(1.2, 5), (-3.2, -0.6), (-0.4, -0.6),
                                 (-1.2, -5), (3.2, 0.6), (0.4, 0.6)]),
        "check": lambda: _stroke([(-3.4, 0.2), (-0.8, -2.6), (3.6, 3.2)], 2.0),
        "cross": lambda: _stroke([(-3, -3), (3, 3)], 2.0).union(_stroke([(-3, 3), (3, -3)], 2.0)),
        "prompt": lambda: _stroke([(-3.6, 3), (-0.6, 0), (-3.6, -3)], 1.8)
                          .union(box(0.4, -3.4, 4.0, -1.8)),
        "mic": lambda: unary_union([
            LineString([(0, 0.8), (0, 2.6)]).buffer(1.9, quad_segs=8),
            _stroke(_arc(0, 0.9, 3.2, 200, 340), 1.2),
            _stroke([(0, -2.1), (0, -3.2)], 1.2),
            _stroke([(-1.7, -3.8), (1.7, -3.8)], 1.1)]),
        "send": lambda: Polygon([(-3.8, 3.4), (4.2, 0), (-3.8, -3.4), (-1.6, 0)]),
        "dot": lambda: Point(0, 0).buffer(1.8, quad_segs=12),
        "ring": lambda: _stroke(_arc(0, 0, 3.2, 0, 360, 60), 1.7),
        "target": lambda: _stroke(_arc(0, 0, 3.7, 0, 360, 60), 1.3)
                          .union(Point(0, 0).buffer(1.5, quad_segs=12)),
        "claude": _logo_claude,
        "antigravity": _logo_antigravity,
        "opencode": _logo_opencode,
        "kiro": _logo_kiro,
        "cursor": _logo_cursor,
        "codex": _logo_codex,
        "grok": _logo_grok,
    }[name]()
    return affinity.scale(g, size / 10.0, size / 10.0, origin=(0, 0))


# Per-glyph deboss sizes (design box units on the cap top); logos run larger
# than the letter/symbol set. part_caps falls back to its default otherwise.
GLYPH_SIZES = {
    "claude": 10.6, "antigravity": 10.4, "opencode": 9.8,
    "kiro": 10.2, "cursor": 10.2, "codex": 10.8, "grok": 10.4,
}

# ----------------------------------------------------------------- mesh ----

class Mesh:
    """Triangle soup with optional coordinate welding.

    Mesh(weld=True): the add_* builders reuse a vertex index for identical
    (rounded) coordinates, so walls and caps of ONE shell stitch into a
    closed manifold. Merging meshes with `+=` never welds across meshes —
    that is how separate shells stay separate (the slicer unions them).
    Build each closed shell in its own welded Mesh, then merge.
    """

    def __init__(self, weld=False):
        self.V: list = []
        self.F: list = []
        self._weld = {} if weld else None

    # -- low-level builders (compose these for custom shells) --

    def _pt(self, x, y, z):
        if self._weld is None:
            self.V.append((x, y, z))
            return len(self.V) - 1
        key = (round(x, 6), round(y, 6), round(z, 6))
        i = self._weld.get(key)
        if i is None:
            self.V.append((x, y, z))
            i = self._weld[key] = len(self.V) - 1
        return i

    def add_ring_wall(self, pts, z0, z1):
        """Vertical wall around a 2D ring. CCW ring -> outward normals,
        CW ring (a hole) -> normals face into the hole (out of the solid)."""
        n = len(pts)
        b = [self._pt(x, y, z0) for x, y in pts]
        t = [self._pt(x, y, z1) for x, y in pts]
        for i in range(n):
            j = (i + 1) % n
            self.F.append((b[i], b[j], t[j]))
            self.F.append((b[i], t[j], t[i]))

    def add_loft_wall(self, pts_a, z0, pts_b, z1):
        """Wall between two index-aligned CCW rings at different heights."""
        if len(pts_a) != len(pts_b):
            raise ValueError("loft rings must have equal point counts "
                             f"({len(pts_a)} vs {len(pts_b)}); use resample_ring()")
        n = len(pts_a)
        b = [self._pt(x, y, z0) for x, y in pts_a]
        t = [self._pt(x, y, z1) for x, y in pts_b]
        for i in range(n):
            j = (i + 1) % n
            self.F.append((b[i], b[j], t[j]))
            self.F.append((b[i], t[j], t[i]))

    def add_cap(self, geom, z, up):
        """Flat triangulated face of a (Multi)Polygon at height z.
        up=True -> normal +Z, else -Z."""
        for poly in _polys(geom):
            poly = orient(poly, 1.0)
            tris = shapely.constrained_delaunay_triangles(poly)
            local = {}
            for ring in [poly.exterior, *poly.interiors]:
                for x, y in list(ring.coords)[:-1]:
                    local[(round(x, 6), round(y, 6))] = self._pt(x, y, z)
            for tri in tris.geoms:
                cs = [(round(x, 6), round(y, 6)) for x, y in tri.exterior.coords[:-1]]
                if not all(c in local for c in cs):
                    raise RuntimeError("CDT introduced a vertex not on the input rings")
                a, b, c = (local[c] for c in cs)
                area = ((cs[1][0] - cs[0][0]) * (cs[2][1] - cs[0][1])
                        - (cs[2][0] - cs[0][0]) * (cs[1][1] - cs[0][1]))
                if abs(area) < 1e-9:
                    continue
                if (area > 0) != up:
                    a, c = c, a
                self.F.append((a, b, c))

    # -- transforms / merge --

    def _np(self):
        return np.asarray(self.V, dtype=np.float64), np.asarray(self.F, dtype=np.int64)

    def translate(self, dx=0.0, dy=0.0, dz=0.0):
        self.V = [(x + dx, y + dy, z + dz) for x, y, z in self.V]
        return self

    def rotate_z(self, deg, about=(0.0, 0.0)):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        ox, oy = about
        self.V = [((x - ox) * c - (y - oy) * s + ox,
                   (x - ox) * s + (y - oy) * c + oy, z) for x, y, z in self.V]
        return self

    def __iadd__(self, other):
        base = len(self.V)
        self.V.extend(other.V)
        self.F.extend((a + base, b + base, c + base) for a, b, c in other.F)
        return self

    def copy(self):
        m = Mesh()
        m.V = list(self.V)
        m.F = list(self.F)
        return m


def _polys(geom):
    if isinstance(geom, Polygon):
        return [] if geom.is_empty else [geom]
    if isinstance(geom, MultiPolygon):
        return [p for p in geom.geoms if not p.is_empty]
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(_polys(g))
        return out
    raise TypeError(f"expected polygonal geometry, got {geom.geom_type}")


def _rings(poly):
    """(exterior CCW, holes CW) as open point lists, consecutive dups removed."""
    poly = orient(poly, 1.0)
    def clean(ring):
        pts = [(x, y) for x, y in list(ring.coords)[:-1]]
        out = [p for i, p in enumerate(pts)
               if abs(p[0] - pts[i - 1][0]) > EPS or abs(p[1] - pts[i - 1][1]) > EPS]
        return out
    return clean(poly.exterior), [clean(r) for r in poly.interiors]


def prism(geom, z0, z1):
    """Closed extrusion of a (Multi)Polygon (holes supported)."""
    out = Mesh()
    for poly in _polys(geom):
        m = Mesh(weld=True)
        ext, holes = _rings(poly)
        m.add_ring_wall(ext, z0, z1)
        for h in holes:
            m.add_ring_wall(h, z0, z1)
        m.add_cap(poly, z1, up=True)
        m.add_cap(poly, z0, up=False)
        out += m
    return out


def loft_solid(poly_a, z0, poly_b, z1):
    """Closed solid between two hole-free profiles with equal vertex counts."""
    ea, ha = _rings(poly_a)
    eb, hb = _rings(poly_b)
    if ha or hb:
        raise ValueError("loft_solid: profiles must not have holes")
    m = Mesh(weld=True)
    m.add_loft_wall(ea, z0, eb, z1)
    m.add_cap(poly_b, z1, up=True)
    m.add_cap(poly_a, z0, up=False)
    return m

# ----------------------------------------------------------- validation ----

def validate(mesh):
    """Split into connected shells; each must be closed, edge-manifold,
    consistently wound, with positive volume. Returns a report dict."""
    V, F = mesh._np()
    report = {"vertices": len(V), "triangles": len(F), "shells": 0,
              "watertight": True, "problems": []}
    if len(F) == 0:
        report["watertight"] = False
        report["problems"].append("empty mesh")
        return report

    edges = {}
    for fi, (a, b, c) in enumerate(F):
        if a == b or b == c or a == c:
            report["problems"].append(f"degenerate face {fi}")
            continue
        for e in ((a, b), (b, c), (c, a)):
            edges.setdefault(e, 0)
            edges[e] += 1

    parent = list(range(len(F)))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry
    by_edge = {}
    for fi, (a, b, c) in enumerate(F):
        for e in ((a, b), (b, c), (c, a)):
            k = (min(e), max(e))
            if k in by_edge:
                union(fi, by_edge[k])
            else:
                by_edge[k] = fi

    for (a, b), n in edges.items():
        if n != 1 or edges.get((b, a), 0) != 1:
            report["watertight"] = False
            report["problems"].append(
                f"edge {a}->{b} count {n}, reverse {edges.get((b, a), 0)}")
            if len(report["problems"]) > 12:
                report["problems"].append("... (truncated)")
                return report

    shells = {}
    for fi in range(len(F)):
        shells.setdefault(find(fi), []).append(fi)
    report["shells"] = len(shells)
    vol_total = 0.0
    for faces in shells.values():
        vol = 0.0
        for fi in faces:
            a, b, c = F[fi]
            vol += np.dot(V[a], np.cross(V[b], V[c])) / 6.0
        if vol <= 0:
            report["watertight"] = False
            report["problems"].append(f"shell volume {vol:.3f} <= 0 (inverted?)")
        vol_total += vol
    report["volume_mm3"] = round(float(vol_total), 2)
    return report

# -------------------------------------------------------------- exports ----

def _explode(mesh):
    """Per-face vertices + flat normals (for GLB display)."""
    V, F = mesh._np()
    tri = V[F]                                   # (m,3,3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    n = n / ln
    pos = tri.reshape(-1, 3).astype(np.float32)
    nrm = np.repeat(n, 3, axis=0).astype(np.float32)
    return pos, nrm


def stl_write(path, mesh):
    V, F = mesh._np()
    tri = V[F]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    n = (n / ln).astype(np.float32)
    with open(path, "wb") as fh:
        fh.write(b"orchestrator-pad" + b"\0" * 64)
        fh.write(struct.pack("<I", len(F)))
        tri32 = tri.astype(np.float32)
        for i in range(len(F)):
            fh.write(n[i].tobytes())
            fh.write(tri32[i].tobytes())
            fh.write(b"\0\0")


def _srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def glb_write(path, items):
    """items: list of (name, Mesh, '#RRGGBB') -> one node+material each."""
    bin_chunk = b""
    views, accessors, meshes, nodes, materials = [], [], [], [], []

    def add_view(blob, target):
        nonlocal bin_chunk
        views.append({"buffer": 0, "byteOffset": len(bin_chunk),
                      "byteLength": len(blob), "target": target})
        bin_chunk += blob + b"\0" * (-len(blob) % 4)
        return len(views) - 1

    for i, (name, mesh, hexcol) in enumerate(items):
        pos, nrm = _explode(mesh)
        idx = np.arange(len(pos), dtype=np.uint32)
        vp = add_view(pos.tobytes(), 34962)
        vn = add_view(nrm.tobytes(), 34962)
        vi = add_view(idx.tobytes(), 34963)
        accessors += [
            {"bufferView": vp, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": [float(x) for x in pos.min(axis=0)],
             "max": [float(x) for x in pos.max(axis=0)]},
            {"bufferView": vn, "componentType": 5126, "count": len(pos), "type": "VEC3"},
            {"bufferView": vi, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ]
        rgb = [_srgb_to_linear(int(hexcol[j:j + 2], 16)) for j in (1, 3, 5)]
        materials.append({"name": f"{name}-mat", "pbrMetallicRoughness": {
            "baseColorFactor": [*rgb, 1.0], "metallicFactor": 0.05,
            "roughnessFactor": 0.55}})
        meshes.append({"name": name, "primitives": [{
            "attributes": {"POSITION": 3 * i, "NORMAL": 3 * i + 1},
            "indices": 3 * i + 2, "material": i}]})
        nodes.append({"mesh": i, "name": name})

    gltf = {"asset": {"version": "2.0", "generator": "orchestrator-pad partlib"},
            "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
            "nodes": nodes, "meshes": meshes, "materials": materials,
            "bufferViews": views, "accessors": accessors,
            "buffers": [{"byteLength": len(bin_chunk)}]}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_chunk)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk)

# ------------------------------------------------------------ smoke test ----

if __name__ == "__main__":
    import sys
    ok = True

    slab = prism(ring2d(rounded_rect(40, 30, 6), circle(10)), 0, 5)
    r = validate(slab)
    print("prism+hole:", r["shells"], "shell(s), watertight:", r["watertight"], r["problems"][:3])
    ok &= r["watertight"] and r["shells"] == 1

    cap = loft_solid(rounded_rect(18.2, 18.2, 2.5), 0, rounded_rect(16.4, 16.4, 2.2), 7.5)
    r = validate(cap)
    print("loft:", r["shells"], "shell(s), watertight:", r["watertight"], r["problems"][:3])
    ok &= r["watertight"]

    top = rounded_rect(16.4, 16.4, 2.2)
    layer = prism(top.difference(glyph("C", 9)), 6.5, 7.5)
    r = validate(layer)
    print("glyph layer:", r["shells"], "shell(s), watertight:", r["watertight"], r["problems"][:3])
    ok &= r["watertight"]

    knurl = circle(17, 96).difference(unary_union(
        [affinity.translate(circle(1.6, 24), 8.9 * math.cos(a), 8.9 * math.sin(a))
         for a in np.linspace(0, 2 * math.pi, 24, endpoint=False)]))
    body = prism(ring2d(knurl, d_shaft()), 0, 12)
    r = validate(body)
    print("knurl ring:", r["shells"], "shell(s), watertight:", r["watertight"], r["problems"][:3])
    ok &= r["watertight"]

    for g in ["X", "C", "A", "O", "K", "bolt", "check", "cross",
              "prompt", "mic", "send", "dot", "ring", "target"]:
        area = glyph(g).area
        if area < 1.0:
            print("glyph too small/empty:", g, area)
            ok = False

    print("SMOKE", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
