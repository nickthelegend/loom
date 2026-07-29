"""
Turns the CAD renders into trailer plates.

The renders sit on pure white and the brand is graphite, so they need the
background gone. A global white key is wrong here — half the keycaps are white
too and a colour key punches holes straight through them. This flood-fills from
the four corners instead, so only background white that is actually connected to
the edge is removed and the caps stay solid.

Output: 1920x1080 PNGs on the brand background with a soft orange floor glow,
ready to upload to an image-to-video model as start frames.

Usage: python3 make-assets.mjs.py
"""
import os
from collections import deque

import numpy as np
from PIL import Image, ImageFilter, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "hardware", "orchestrator-pad", "docs", "images"))
OUT = os.path.join(HERE, "assets")
os.makedirs(OUT, exist_ok=True)

W, H = 1920, 1080
BG = (10, 10, 11)
ORANGE = (255, 107, 43)
TOL = 26           # how far from pure white still counts as background
FEATHER = 1.1      # px of edge softening, so the cutout does not look stamped on


def cut_background(img: Image.Image) -> Image.Image:
    """
    Isolate the product.

    Some of these renders already ship with a real alpha channel. Those need
    nothing done to them — and must not be run through the flood fill, because
    converting them to RGB paints the transparent background black, the fill
    then finds no white to remove, and the result is the product stamped inside
    a hard black rectangle.
    """
    if img.mode in ("RGBA", "LA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        if np.asarray(rgba)[:, :, 3].min() < 250:
            return rgba

    rgb = img.convert("RGB")
    a = np.asarray(rgb).astype(np.int16)
    h, w, _ = a.shape

    # a pixel is "whiteish" if all channels are within TOL of 255
    whiteish = (a > (255 - TOL)).all(axis=2)

    bg = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if whiteish[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if whiteish[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))

    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and whiteish[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))

    alpha = Image.fromarray(np.where(bg, 0, 255).astype(np.uint8), mode="L")
    alpha = alpha.filter(ImageFilter.GaussianBlur(FEATHER))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def plate(cut: Image.Image, scale: float, cx: float, cy: float) -> Image.Image:
    """Compose one 1920x1080 frame: brand background, floor glow, product."""
    canvas = Image.new("RGB", (W, H), BG)

    # a wide, very soft orange pool under the product — reads as a lit surface
    glow = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(glow)
    d.ellipse([W * 0.16, H * 0.60, W * 0.84, H * 1.06], fill=ORANGE)
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    canvas = Image.blend(canvas, glow, 0.14)

    target_h = int(H * scale)
    ratio = target_h / cut.height
    p = cut.resize((int(cut.width * ratio), target_h), Image.LANCZOS)

    # contact shadow, so the product does not float
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse(
        [W * cx - p.width * 0.44, H * cy + p.height * 0.30,
         W * cx + p.width * 0.44, H * cy + p.height * 0.50],
        fill=(0, 0, 0, 190))
    canvas.paste(Image.alpha_composite(
        canvas.convert("RGBA"), sh.filter(ImageFilter.GaussianBlur(45))).convert("RGB"), (0, 0))

    canvas.paste(p, (int(W * cx - p.width / 2), int(H * cy - p.height / 2)), p)
    return canvas


JOBS = [
    ("hero.png",     "01-hero",     0.74, 0.50, 0.46),
    ("top.png",      "02-top",      0.80, 0.50, 0.47),
    ("exploded.png", "03-exploded", 0.86, 0.50, 0.48),
    ("parts.png",    "04-parts",    0.52, 0.50, 0.50),
]

for src, name, scale, cx, cy in JOBS:
    p = os.path.join(SRC, src)
    if not os.path.exists(p):
        print("  missing, skipped:", src)
        continue
    cut = cut_background(Image.open(p))
    cut.save(os.path.join(OUT, f"{name}-cutout.png"))
    plate(cut, scale, cx, cy).save(os.path.join(OUT, f"{name}.png"))
    print(f"  {name}.png  (+ cutout)")

# the circuit diagram is a document, not a product — keep it flat and legible
circ = os.path.join(SRC, "circuit.png")
if os.path.exists(circ):
    c = Image.open(circ).convert("RGB")
    r = min(W * 0.92 / c.width, H * 0.92 / c.height)
    c = c.resize((int(c.width * r), int(c.height * r)), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), BG)
    canvas.paste(c, ((W - c.width) // 2, (H - c.height) // 2))
    canvas.save(os.path.join(OUT, "05-circuit.png"))
    print("  05-circuit.png")

print("→", OUT)
