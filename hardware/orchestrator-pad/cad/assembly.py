"""assembly.py — Orchestrator Pad assembly + exports.

Collects the four printable parts (already in WORLD position per SPEC.md),
writes the two GLB previews, the per-part print STLs and a MANIFEST.json:

  exports/orchestrator-pad-assembled.glb   all 17 items as placed
  exports/orchestrator-pad-exploded.glb    copies lifted +Z per group
                                           (tray +0 / plate +20 / caps +40 / knob +52)
  exports/tray.stl                         as modeled (bottom already at Z=0)
  exports/plate.stl                        merged plate shells, min Z -> 0
  exports/caps-all.stl                     all 14 caps, XY grid kept, bottoms -> Z=0
  exports/knob.stl                         upright at origin XY, bottom -> Z=0
  exports/MANIFEST.json                    per-file stats + totals + key legend

Every item is re-validated here; the script exits non-zero unless every
shell of every item (and every merged STL mesh) is watertight.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import partlib as pl
import part_tray
import part_plate
import part_caps
import part_knob

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORTS = os.path.normpath(os.path.join(HERE, "..", "exports"))

# exploded-view Z lift per part group (assembly contract)
EXPLODE_DZ = {"tray": 0.0, "plate": 20.0, "caps": 40.0, "knob": 52.0}


def _merge(meshes):
    """Merge meshes into one Mesh (shells stay separate; slicer unions them)."""
    out = pl.Mesh()
    for m in meshes:
        out += m
    return out


def _min_z(mesh):
    return min(z for _x, _y, z in mesh.V)


def _validate_items(items, label):
    """Validate each (name, mesh, color); print compact report lines."""
    reports, ok = {}, True
    for name, mesh, _color in items:
        rep = pl.validate(mesh)
        reports[name] = rep
        ok &= rep["watertight"]
        print(f"  {label}/{name:12s} shells={rep['shells']:3d} "
              f"tris={rep['triangles']:6d} vol={rep.get('volume_mm3', 0.0):10.2f} "
              f"watertight={rep['watertight']} {rep['problems'][:2]}")
    return reports, ok


def build_groups():
    """The four part groups in canonical order, each [(name, Mesh, color)]."""
    return [
        ("tray", part_tray.build()),
        ("plate", part_plate.build()),
        ("caps", part_caps.build()),
        ("knob", part_knob.build()),
    ]


def main():
    os.makedirs(EXPORTS, exist_ok=True)
    groups = build_groups()
    items = [it for _g, its in groups for it in its]

    # ---- validate every item ------------------------------------------------
    print("validating items:")
    all_ok = True
    item_reports = {}
    for gname, gitems in groups:
        reps, ok = _validate_items(gitems, gname)
        item_reports.update(reps)
        all_ok &= ok

    # ---- GLB: assembled -----------------------------------------------------
    files = []  # (path, triangles, watertight)
    asm_path = os.path.join(EXPORTS, "orchestrator-pad-assembled.glb")
    pl.glb_write(asm_path, items)
    files.append((asm_path, sum(len(m.F) for _n, m, _c in items), all_ok))

    # ---- GLB: exploded (translated copies; originals untouched) -------------
    exploded = [(name, mesh.copy().translate(dz=EXPLODE_DZ[gname]), color)
                for gname, gitems in groups
                for name, mesh, color in gitems]
    exp_path = os.path.join(EXPORTS, "orchestrator-pad-exploded.glb")
    pl.glb_write(exp_path, exploded)
    files.append((exp_path, sum(len(m.F) for _n, m, _c in exploded), all_ok))

    # ---- print STLs ----------------------------------------------------------
    by_group = dict(groups)

    tray = _merge(m for _n, m, _c in by_group["tray"])          # already Z=0
    plate = _merge(m for _n, m, _c in by_group["plate"])
    plate.translate(dz=-_min_z(plate))                          # min Z -> 0
    caps = _merge(m for _n, m, _c in by_group["caps"])
    caps.translate(dz=-_min_z(caps))                            # bottoms -> 0, XY kept
    knob = _merge(m for _n, m, _c in by_group["knob"])
    knob.translate(-pl.KNOB_POS[0], -pl.KNOB_POS[1], -_min_z(knob))  # origin, upright

    print("validating print meshes:")
    for fname, mesh in [("tray.stl", tray), ("plate.stl", plate),
                        ("caps-all.stl", caps), ("knob.stl", knob)]:
        rep = pl.validate(mesh)
        all_ok &= rep["watertight"]
        print(f"  {fname:14s} shells={rep['shells']:3d} tris={rep['triangles']:6d} "
              f"vol={rep.get('volume_mm3', 0.0):10.2f} "
              f"watertight={rep['watertight']} {rep['problems'][:2]}")
        path = os.path.join(EXPORTS, fname)
        pl.stl_write(path, mesh)
        files.append((path, len(mesh.F), rep["watertight"]))

    # ---- MANIFEST.json --------------------------------------------------------
    repo = os.path.normpath(os.path.join(HERE, ".."))
    file_entries = [{
        "path": os.path.relpath(path, repo),
        "bytes": os.path.getsize(path),
        "triangles": tris,
        "watertight": bool(wt),
    } for path, tris, wt in files]

    legend = {
        "parts": {p: pl.COLORS[p] for p in ("tray", "plate", "knob")},
        "keys": [{"id": k["id"], "glyph": k["glyph"], "units": k["units"],
                  "x": k["x"], "y": k["y"], "color": k["color"]}
                 for k in pl.key_layout()],
    }
    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": file_entries,
        "totals": {
            "files": len(file_entries),
            "bytes": sum(f["bytes"] for f in file_entries),
            "triangles": sum(f["triangles"] for f in file_entries),
            "watertight": bool(all_ok),
        },
        "items": [{"name": n, "triangles": r["triangles"], "shells": r["shells"],
                   "volume_mm3": r.get("volume_mm3"),
                   "watertight": r["watertight"]}
                  for n, r in item_reports.items()],
        "legend": legend,
    }
    man_path = os.path.join(EXPORTS, "MANIFEST.json")
    with open(man_path, "w") as fh:
        json.dump(manifest, fh, indent=2)

    # ---- summary table ---------------------------------------------------------
    print(f"\n{'file':38s} {'bytes':>10s} {'triangles':>10s}  watertight")
    print("-" * 72)
    for f in file_entries:
        print(f"{f['path']:38s} {f['bytes']:>10,d} {f['triangles']:>10,d}  {f['watertight']}")
    t = manifest["totals"]
    print("-" * 72)
    print(f"{'TOTAL (' + str(t['files']) + ' files)':38s} "
          f"{t['bytes']:>10,d} {t['triangles']:>10,d}  {t['watertight']}")
    print(f"manifest: {os.path.relpath(man_path, repo)}")
    print("ASSEMBLY", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
