"""render_video.py — reveal animation of the assembled model.

Assembled → explode into layers (tray · switch-deck · plate · caps · knob) →
hold → reassemble, on a slow orbit. Pure-numpy orthographic rasterizer
(reuses render_docs helpers), frames rendered in parallel, encoded to MP4 by
ffmpeg. Deterministic; fixed framing so the model stays centered + same size
while it spins and explodes.

    python render_video.py            # -> docs/orchestrator-pad-reveal.mp4
"""
from __future__ import annotations

import math
import multiprocessing as mp
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_docs as rd

# ---- config ----------------------------------------------------------------
W, H = 1000, 720
FPS = 24
DUR = 15.0                       # seconds
SS = 2                           # supersample (2 = crisp)
MARGIN = 1.16
PERSP_TILT = True                # slight elevation change during explode

# explode offset (world +Z) per part group, at full explode
EXPLODE = {"tray": 0.0, "switch-deck": 14.0, "plate": 30.0,
           "cap": 50.0, "knob": 66.0}
CAP_IDS = {"cursor", "codex", "preset3", "grok", "claude", "antigravity",
           "opencode", "kiro", "run", "approve", "reject", "prompt",
           "voice", "send"}

BG_TOP = np.array([0.09, 0.10, 0.12])      # dark gradient background
BG_BOT = np.array([0.04, 0.045, 0.055])


def group_of(name):
    key = name[:-7] if name.endswith("-legend") else name
    return "cap" if key in CAP_IDS else key


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def timeline(t):
    """-> (explode_frac, azimuth_deg, elevation_deg) at time t (s)."""
    # explode: hold assembled, blow apart, hold, come back, hold
    e = (smoothstep(2.5, 6.0, t)
         - smoothstep(9.5, 13.0, t))
    az = -32.0 + 26.0 * (t / DUR)              # slow drift
    el = 15.0 + 16.0 * e                       # rise to peer into the layers
    return float(e), az, (el if PERSP_TILT else 18.0)


# ---- geometry (loaded once per worker) -------------------------------------
_PARTS = None
_FRAME = None                    # fixed framing (center, scale, radius)


def _load():
    global _PARTS, _FRAME
    if _PARTS is not None:
        return
    items = rd.load_glb(rd.EXPORTS / "orchestrator-pad-assembled.glb")
    parts = []
    for name, tris, rgb in items:
        g = group_of(name)
        off = np.array([0.0, 0.0, EXPLODE[g]])
        parts.append((tris.astype(np.float64), np.asarray(rgb), off))
    _PARTS = parts
    # fixed framing from the fully-exploded envelope (so nothing clips / rescales)
    allv = np.concatenate([t.reshape(-1, 3) + o for t, _, o in parts])
    lo, hi = allv.min(0), allv.max(0)
    center = (lo + hi) / 2
    radius = float(np.linalg.norm(hi - lo)) / 2
    _FRAME = (center, radius)


def _shade(tris, rgb, basis):
    e1 = (tris[:, 1] - tris[:, 0]) @ basis.T
    e2 = (tris[:, 2] - tris[:, 0]) @ basis.T
    n = -np.cross(e1, e2)                       # LH basis -> negate (render_docs note)
    nl = np.linalg.norm(n, axis=1, keepdims=True); nl[nl == 0] = 1
    n /= nl
    L1 = np.array([-0.34, 0.55, -0.76]); L1 /= np.linalg.norm(L1)
    L2 = np.array([0.6, 0.15, -0.78]); L2 /= np.linalg.norm(L2)
    HV = (L1 + np.array([0, 0, -1.0])); HV /= np.linalg.norm(HV)
    lam = 0.40 + 0.52 * np.clip(n @ L1, 0, None) + 0.22 * np.clip(n @ L2, 0, None)
    spec = 0.18 * np.clip(n @ HV, 0, None) ** 32
    col = np.clip(lam[:, None] * rgb[None, :] + spec[:, None], 0, 1)
    facing = n[:, 2] < 0
    return col.astype(np.float32), facing


def render_frame(args):
    idx, e, az, el, frames_dir = args
    _load()
    # dynamic framing: recompute from the CURRENT explode state so the model
    # stays centered + fitted and the camera smoothly pulls back as it opens
    allv = np.concatenate([t.reshape(-1, 3) + o * e for t, _, o in _PARTS])
    lo, hi = allv.min(0), allv.max(0)
    center = (lo + hi) / 2
    radius = float(np.linalg.norm(hi - lo)) / 2
    Wf, Hf = W * SS, H * SS
    eye, basis = rd._look_at(az, el, radius * 3.0, center)
    scale = min(Wf, Hf) / (2 * radius * MARGIN)
    cc = (center - eye) @ basis.T
    ox = Wf / 2 - cc[0] * scale
    oy = Hf / 2 + cc[1] * scale

    # gradient background
    yy = np.linspace(0, 1, Hf)[:, None, None]
    col = (BG_TOP[None, None, :] * (1 - yy) + BG_BOT[None, None, :] * yy)
    col = np.repeat(col, Wf, axis=1).astype(np.float32)
    zbuf = np.full((Hf, Wf), np.inf)

    for tris0, rgb, off in _PARTS:
        tris = tris0 + off * e                 # animate the explode
        v = tris.reshape(-1, 3)
        p = (v - eye) @ basis.T
        sx = (p[:, 0] * scale + ox).reshape(-1, 3)
        sy = (-p[:, 1] * scale + oy).reshape(-1, 3)
        sz = p[:, 2].reshape(-1, 3)
        shade, facing = _shade(tris, rgb, basis)
        order = np.argsort(-sz.mean(1))
        for ti in order:
            if not facing[ti]:
                continue
            x, y, z = sx[ti], sy[ti], sz[ti]
            x0 = max(int(x.min()), 0); x1 = min(int(x.max()) + 1, Wf)
            y0 = max(int(y.min()), 0); y1 = min(int(y.max()) + 1, Hf)
            if x0 >= x1 or y0 >= y1:
                continue
            area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0])
            if abs(area) < 1e-9:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            w0 = ((x[1] - xs) * (y[2] - ys) - (x[2] - xs) * (y[1] - ys)) / area
            w1 = ((x[2] - xs) * (y[0] - ys) - (x[0] - xs) * (y[2] - ys)) / area
            w2 = 1 - w0 - w1
            ins = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not ins.any():
                continue
            zi = w0 * z[0] + w1 * z[1] + w2 * z[2]
            reg = zbuf[y0:y1, x0:x1]
            upd = ins & (zi < reg)
            if not upd.any():
                continue
            reg[upd] = zi[upd]
            col[y0:y1, x0:x1][upd] = shade[ti]

    img = col.reshape(H, SS, W, SS, 3).mean(axis=(1, 3))
    out = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    rgba = np.dstack([out, np.full((H, W), 255, np.uint8)])
    path = os.path.join(frames_dir, f"f{idx:04d}.png")
    rd.write_png(path, rgba)
    return idx


def main():
    n = int(DUR * FPS)
    frames_dir = tempfile.mkdtemp(prefix="pad-reveal-")
    jobs = []
    for i in range(n):
        e, az, el = timeline(i / FPS)
        jobs.append((i, e, az, el, frames_dir))
    print(f"rendering {n} frames ({W}x{H}, SS{SS}) on {min(8, os.cpu_count())} workers -> {frames_dir}")
    with mp.Pool(min(8, os.cpu_count())) as pool:
        for k, _ in enumerate(pool.imap_unordered(render_frame, jobs)):
            if (k + 1) % 24 == 0 or k + 1 == n:
                print(f"  {k + 1}/{n}")

    out = os.path.join(os.path.dirname(rd.OUT), "orchestrator-pad-reveal.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-framerate", str(FPS), "-i",
        os.path.join(frames_dir, "f%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        "-movflags", "+faststart", out], check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # small looping GIF too (half res)
    gif = os.path.join(os.path.dirname(rd.OUT), "orchestrator-pad-reveal.gif")
    subprocess.run([
        "ffmpeg", "-y", "-framerate", str(FPS), "-i",
        os.path.join(frames_dir, "f%04d.png"),
        "-vf", "scale=500:-1:flags=lanczos", "-loop", "0", gif], check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("wrote", out)
    print("wrote", gif)


if __name__ == "__main__":
    main()
