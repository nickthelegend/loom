"""render_docs.py — turn the exported GLBs into README product shots.

Pure python: numpy z-buffer rasterizer + stdlib PNG writer. No GPU, no PIL.
Regenerate docs/images/*.png after any CAD change:

    python render_docs.py
"""
from __future__ import annotations

import json
import math
import struct
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
EXPORTS = ROOT / "exports"
OUT = ROOT / "docs" / "images"
SS = 2  # supersampling factor

# ------------------------------------------------------------- GLB load ----

def load_glb(path):
    """-> list of (name, tris float32 (m,3,3), srgb color (3,))."""
    data = Path(path).read_bytes()
    _, _, _ = struct.unpack_from("<III", data, 0)
    jlen, _ = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + jlen])
    blen, _ = struct.unpack_from("<II", data, 20 + jlen)
    buf = data[28 + jlen:28 + jlen + blen]

    def acc_array(i, dtype, ncomp):
        acc = gltf["accessors"][i]
        view = gltf["bufferViews"][acc["bufferView"]]
        off = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        n = acc["count"] * ncomp
        return np.frombuffer(buf, dtype=dtype, count=n, offset=off).reshape(acc["count"], ncomp)

    def to_srgb(c):
        c = np.asarray(c[:3])
        return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)

    items = []
    for node in gltf["nodes"]:
        mesh = gltf["meshes"][node["mesh"]]
        prim = mesh["primitives"][0]
        pos = acc_array(prim["attributes"]["POSITION"], np.float32, 3)
        idx = acc_array(prim["indices"], np.uint32, 1).ravel()
        tris = pos[idx].reshape(-1, 3, 3).astype(np.float64)
        mat = gltf["materials"][prim["material"]]
        rgb = to_srgb(mat["pbrMetallicRoughness"]["baseColorFactor"])
        items.append((node.get("name", f"item{len(items)}"), tris, rgb))
    return items

# ------------------------------------------------------------ rasterize ----

def _look_at(azim_deg, elev_deg, dist, target):
    az, el = math.radians(azim_deg), math.radians(elev_deg)
    eye = target + dist * np.array([math.cos(el) * math.sin(az),
                                    -math.cos(el) * math.cos(az),
                                    math.sin(el)])
    f = target - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, np.array([0.0, 0.0, 1.0]))
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return eye, np.stack([r, u, f])  # rows: right, up, fwd


def render(items, out_path, w=1440, h=1080, azim=-32, elev=27, ortho=False,
           persp=34.0, margin=1.14, lift=0.0):
    """Render items to a transparent-background RGBA PNG with a soft
    ground-contact shadow. `persp` ~ focal length in mm-equivalent."""
    W, H = w * SS, h * SS
    all_v = np.concatenate([t.reshape(-1, 3) for _, t, _ in items])
    lo, hi = all_v.min(axis=0), all_v.max(axis=0)
    center = (lo + hi) / 2
    radius = float(np.linalg.norm(hi - lo)) / 2
    ground_z = float(lo[2])

    dist = radius * (persp / 12.0)
    eye, basis = _look_at(azim, elev, dist, center)

    def project(v):
        p = (v - eye) @ basis.T
        if ortho:
            return p[:, 0], p[:, 1], p[:, 2]
        s = dist / np.maximum(p[:, 2], 1e-6)
        return p[:, 0] * s, p[:, 1] * s, p[:, 2]

    # fit pass
    px, py, _ = project(all_v)
    span = max(px.max() - px.min(), (py.max() - py.min()) * (W / H) * (h / w)) + 1e-9
    scale = W / (span * margin)
    ox = W / 2 - (px.min() + px.max()) / 2 * scale
    oy = H / 2 + (py.min() + py.max()) / 2 * scale - lift * H

    zbuf = np.full((H, W), np.inf, dtype=np.float64)
    col = np.zeros((H, W, 3), dtype=np.float32)
    cov = np.zeros((H, W), dtype=np.float32)

    # lights in view space (pointing from surface toward light)
    L1 = np.array([-0.38, 0.62, -0.68]); L1 /= np.linalg.norm(L1)
    L2 = np.array([0.55, 0.12, -0.82]); L2 /= np.linalg.norm(L2)
    HV = (L1 + np.array([0, 0, -1.0])); HV /= np.linalg.norm(HV)

    for name, tris, rgb in items:
        v = tris.reshape(-1, 3)
        sx, sy, sz = project(v)
        sx = sx * scale + ox
        sy = -sy * scale + oy
        sx = sx.reshape(-1, 3); sy = sy.reshape(-1, 3); sz = sz.reshape(-1, 3)

        # flat normals in view space. The [r,u,f] basis is LEFT-handed
        # (f = -(r x u)), so cross products of transformed edges flip sign —
        # negate to get true view-space normals (else front faces get culled).
        e1 = (tris[:, 1] - tris[:, 0]) @ basis.T
        e2 = (tris[:, 2] - tris[:, 0]) @ basis.T
        n = -np.cross(e1, e2)
        nl = np.linalg.norm(n, axis=1, keepdims=True); nl[nl == 0] = 1
        n /= nl
        facing = n[:, 2] < 0  # toward camera (view fwd is +z)
        # lights have -z (into the screen): a camera-facing normal dotted
        # with them is POSITIVE when the face catches the light
        lam = (0.38 + 0.55 * np.clip(n @ L1, 0, None)
                    + 0.24 * np.clip(n @ L2, 0, None))
        spec = 0.20 * np.clip(n @ HV, 0, None) ** 30
        shade = lam[:, None] * np.asarray(rgb)[None, :] + spec[:, None]
        # fake cavity AO: upward faces sitting a hair below the item's top
        # surface are deboss floors (glyphs, counterbores) — darken them so
        # recesses read even under flat top-down light
        nw = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        nwl = np.linalg.norm(nw, axis=1); nwl[nwl == 0] = 1
        depth_below_top = tris[:, :, 2].max() - tris[:, :, 2].max(axis=1)
        cavity = (nw[:, 2] / nwl > 0.92) & (depth_below_top > 0.12) & (depth_below_top < 1.4)
        shade[cavity] *= 0.68
        shade = np.clip(shade, 0, 1).astype(np.float32)

        order = np.argsort(-sz.mean(axis=1))  # far-ish first reduces zbuf churn
        for ti in order:
            if not facing[ti]:
                continue
            x, y, z = sx[ti], sy[ti], sz[ti]
            x0 = max(int(x.min()), 0); x1 = min(int(x.max()) + 1, W)
            y0 = max(int(y.min()), 0); y1 = min(int(y.max()) + 1, H)
            if x0 >= x1 or y0 >= y1:
                continue
            area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0])
            if abs(area) < 1e-9:
                continue
            xx, yy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            w0 = ((x[1] - xx) * (y[2] - yy) - (x[2] - xx) * (y[1] - yy)) / area
            w1 = ((x[2] - xx) * (y[0] - yy) - (x[0] - xx) * (y[2] - yy)) / area
            w2 = 1.0 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue
            zi = w0 * z[0] + w1 * z[1] + w2 * z[2]
            zregion = zbuf[y0:y1, x0:x1]
            upd = inside & (zi < zregion)
            if not upd.any():
                continue
            zregion[upd] = zi[upd]
            col[y0:y1, x0:x1][upd] = shade[ti]
            cov[y0:y1, x0:x1][upd] = 1.0

    # soft ground shadow (screen-space ellipse per item footprint)
    sh = np.zeros((H, W), dtype=np.float32)
    for name, tris, rgb in items:
        v = tris.reshape(-1, 3).copy()
        v[:, 2] = ground_z
        gx, gy, _ = project(v)
        gx = gx * scale + ox
        gy = -gy * scale + oy
        cx, cy = gx.mean(), gy.mean()
        rx = (gx.max() - gx.min()) / 2 * 1.06
        ry = max((gy.max() - gy.min()) / 2 * 1.06, rx * 0.22)
        x0 = max(int(cx - rx * 1.6), 0); x1 = min(int(cx + rx * 1.6) + 1, W)
        y0 = max(int(cy - ry * 1.6), 0); y1 = min(int(cy + ry * 1.6) + 1, H)
        if x0 >= x1 or y0 >= y1:
            continue
        xx, yy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
        blob = np.clip(1.0 - d, 0, 1) ** 1.8 * 0.38
        sh[y0:y1, x0:x1] = np.maximum(sh[y0:y1, x0:x1], blob)

    a = cov
    rgb_out = col * a[..., None]                      # mesh over shadow over clear
    alpha = a + sh * (1 - a)
    img = np.concatenate([rgb_out, alpha[..., None]], axis=2)

    # downsample
    img = img.reshape(h, SS, w, SS, 4).mean(axis=(1, 3))
    a_px = img[..., 3:4]
    rgb8 = np.where(a_px > 1e-4, img[..., :3] / np.maximum(a_px, 1e-4), 0)
    out = np.concatenate([np.clip(rgb8, 0, 1), np.clip(a_px, 0, 1)], axis=2)
    write_png(out_path, (out * 255 + 0.5).astype(np.uint8))
    print("wrote", out_path)

# ------------------------------------------------------------------ png ----

def write_png(path, rgba):
    h, w, _ = rgba.shape
    raw = b"".join(b"\0" + rgba[y].tobytes() for y in range(h))

    def chunk(tag, payload):
        c = struct.pack(">I", len(payload)) + tag + payload
        return c + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(raw, 7)))
        fh.write(chunk(b"IEND", b""))

# ---------------------------------------------------------------- shots ----

def shift(items, dx=0.0, dy=0.0, dz=0.0):
    return [(n, t + np.array([dx, dy, dz]), c) for n, t, c in items]


def main():
    assembled = load_glb(EXPORTS / "orchestrator-pad-assembled.glb")
    exploded = load_glb(EXPORTS / "orchestrator-pad-exploded.glb")

    render(assembled, OUT / "hero.png", 1440, 1000, azim=-32, elev=26, persp=40)
    render(assembled, OUT / "top.png", 1200, 1200, azim=0, elev=89.5, ortho=True, margin=1.10)
    render(exploded, OUT / "exploded.png", 1440, 1200, azim=-28, elev=22, persp=44)

    tray = [i for i in assembled if i[0] == "tray"]
    plate = shift([i for i in assembled if i[0] == "plate"], dx=104, dz=-7.5)
    caps = shift([i for i in assembled if i[0] not in ("tray", "plate", "knob")], dx=212, dz=-21.0)
    knob = shift([i for i in assembled if i[0] == "knob"], dx=290, dz=-16.5)
    render(tray + plate + caps + knob, OUT / "parts.png", 1800, 720,
           azim=-18, elev=32, persp=60, margin=1.08)


if __name__ == "__main__":
    main()
