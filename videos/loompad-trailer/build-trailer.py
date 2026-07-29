"""
Assembles the trailer. You never stitch anything by hand.

Every shot has two possible sources and the script picks automatically:

  shots/NN-*.mp4 exists  →  use that clip (an AI-generated shot you downloaded)
  it doesn't             →  synthesise the move from the still plate with ffmpeg

So this produces a finished, watchable trailer today with zero credits spent,
and each time you drop a real clip into shots/ that shot upgrades in place. Same
command either way.

Text is rendered to PNG with PIL rather than drawtext, because this ffmpeg has
no freetype and drawtext does not exist in it.

Usage:  python3 build-trailer.py [out.mp4]
"""
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
SHOTS = os.path.join(HERE, "shots")
WORK = os.path.join(HERE, ".work")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "loompad-trailer.mp4")

W, H, FPS = 1920, 1080, 30
BG = (10, 10, 11)
ORANGE = (255, 107, 43)
INK = (250, 250, 250)
DIM = (150, 150, 158)

SANS = "/System/Library/Fonts/HelveticaNeue.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG FAILED:", " ".join(args[:12]), "...")
        print(r.stderr[-1500:])
        raise SystemExit(1)


def centre(d, text, f, y, fill):
    w = d.textbbox((0, 0), text, font=f)[2]
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


# --------------------------------------------------------------------------
# title cards
# --------------------------------------------------------------------------
def card_open(path):
    """The problem, stated as three lines that collapse into one."""
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    fm = font(MONO, 40)
    rows = [("claude code", "memory: its own"),
            ("codex", "memory: its own"),
            ("opencode", "memory: its own")]
    y = 366
    for name, mem in rows:
        d.text((560, y), name, font=fm, fill=INK)
        d.text((1030, y), mem, font=fm, fill=DIM)
        y += 74
    d.rectangle([560, y + 34, 1360, y + 36], fill=(38, 38, 44))
    centre(d, "none of them can hand it over.", font(MONO, 40), y + 76, ORANGE)
    im.save(path)


def card_close(path):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    centre(d, "LOOM", font(SANS, 168, 4), 330, INK)
    d.rectangle([W / 2 - 96, 540, W / 2 + 96, 545], fill=ORANGE)
    centre(d, "one brain, every agent", font(SANS, 44), 596, DIM)
    centre(d, "npm i -g @loompad/cli", font(MONO, 40), 720, ORANGE)
    centre(d, "loompad.tech", font(SANS, 34), 800, DIM)
    im.save(path)


def label(path, text):
    """Lower-left caption plate, transparent so it can sit over a shot."""
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = font(SANS, 46, 4)
    tw, th = d.textbbox((0, 0), text, font=f)[2:]
    x, y = 120, H - 190
    d.rounded_rectangle([x - 34, y - 26, x + tw + 34, y + th + 30], 12, fill=(10, 10, 11, 232))
    d.rectangle([x - 34, y - 26, x - 28, y + th + 30], fill=ORANGE)
    d.text((x, y), text, font=f, fill=INK)
    im.save(path)


# --------------------------------------------------------------------------
# shots
# --------------------------------------------------------------------------
# id, plate, seconds, ffmpeg move, caption
PLAN = [
    ("01-open",     None,              3.5, None,        None),
    ("02-hero",     "01-hero.png",     3.5, "out",       None),
    ("03-exploded", "03-exploded.png", 3.5, "left",      None),
    ("04-top",      "02-top.png",      3.0, "in",        "one key per agent"),
    ("05-real",     "real-t42.png",    3.5, "in-slow",   "built, not rendered"),
    ("06-circuit",  "05-circuit.png",  2.5, "in-slow",   "schematic, CAD and firmware — all public"),
    ("07-ui",       "06-ui-brain.png", 3.0, "in-slow",   "one shared memory, every agent"),
    ("08-parts",    "04-parts.png",    2.5, "right",     "six printed parts. one evening."),
    ("09-close",    None,              5.0, None,        None),
]

# zoompan expressions. z is the zoom ramp, x/y keep the move centred on it.
MOVES = {
    "in":      ("min(1.02+0.0016*on,1.14)", "iw/2-(iw/zoom/2)",              "ih/2-(ih/zoom/2)"),
    "in-slow": ("min(1.01+0.0009*on,1.08)", "iw/2-(iw/zoom/2)",              "ih/2-(ih/zoom/2)"),
    "out":     ("max(1.18-0.0018*on,1.02)", "iw/2-(iw/zoom/2)",              "ih/2-(ih/zoom/2)"),
    "left":    ("1.10",                     "iw/2-(iw/zoom/2)+0.9*on",       "ih/2-(ih/zoom/2)"),
    "right":   ("1.10",                     "iw/2-(iw/zoom/2)-0.9*on",       "ih/2-(ih/zoom/2)"),
}

# the grade: crush the blacks a touch, hold the whites, lift only the orange
GRADE = "eq=contrast=1.07:saturation=1.12:gamma=0.97"


def still_segment(plate, secs, move, dst):
    """A camera move on a still — the free version of an AI shot."""
    z, x, y = MOVES[move]
    frames = int(secs * FPS)
    vf = (f"scale=3840:-2:flags=lanczos,"
          f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={FPS},"
          f"{GRADE},format=yuv420p")
    run(["ffmpeg", "-v", "error", "-loop", "1", "-i", plate, "-t", f"{secs}",
         "-vf", vf, "-r", str(FPS), "-c:v", "libx264", "-preset", "medium",
         "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-y", dst])


def clip_segment(src, secs, dst):
    """A real generated clip: trim to length, normalise, drop its audio."""
    run(["ffmpeg", "-v", "error", "-i", src, "-t", f"{secs}",
         "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,"
                f"crop={W}:{H},{GRADE},format=yuv420p",
         "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-an", "-y", dst])


def card_segment(png, secs, dst):
    run(["ffmpeg", "-v", "error", "-loop", "1", "-i", png, "-t", f"{secs}",
         "-vf", f"scale={W}:{H},format=yuv420p", "-r", str(FPS),
         "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-an", "-y", dst])


def burn_label(base, png, dst, secs):
    """
    Caption fades up half a second in and holds to the end of the shot.

    The `-loop 1` on the caption matters. Without it the PNG is a single frame
    sitting at t=0, so the alpha fade is evaluated before its start time, the
    frame comes out fully transparent, and overlay then repeats that invisible
    frame for the whole shot — captions silently never appear.
    """
    run(["ffmpeg", "-v", "error", "-i", base, "-loop", "1", "-t", f"{secs}", "-i", png,
         "-filter_complex",
         f"[1:v]format=rgba,fade=t=in:st=0.45:d=0.3:alpha=1[l];[0:v][l]overlay=0:0",
         "-t", f"{secs}", "-r", str(FPS), "-c:v", "libx264", "-preset", "medium",
         "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-y", dst])


def find_clip(shot_id):
    if not os.path.isdir(SHOTS):
        return None
    n = shot_id.split("-")[0]
    for f in sorted(os.listdir(SHOTS)):
        if f.startswith(n) and f.endswith((".mp4", ".mov", ".webm")):
            return os.path.join(SHOTS, f)
    return None


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)

    card_open(os.path.join(WORK, "card-open.png"))
    card_close(os.path.join(WORK, "card-close.png"))

    segments, total, generated, synthesised = [], 0.0, 0, 0

    for shot_id, plate, secs, move, cap in PLAN:
        seg = os.path.join(WORK, f"{shot_id}.mp4")

        if shot_id == "01-open":
            card_segment(os.path.join(WORK, "card-open.png"), secs, seg)
        elif shot_id == "09-close":
            card_segment(os.path.join(WORK, "card-close.png"), secs, seg)
        else:
            clip = find_clip(shot_id)
            if clip:
                clip_segment(clip, secs, seg); generated += 1
                src = "clip"
            else:
                still_segment(os.path.join(ASSETS, plate), secs, move, seg)
                synthesised += 1
                src = "move"
            if cap:
                lp = os.path.join(WORK, f"{shot_id}-label.png")
                label(lp, cap)
                out = os.path.join(WORK, f"{shot_id}-cap.mp4")
                burn_label(seg, lp, out, secs)
                seg = out
            print(f"  {shot_id:12} {secs:>4}s  {src}")

        segments.append(seg)
        total += secs

    listing = os.path.join(WORK, "concat.txt")
    with open(listing, "w") as fh:
        for s in segments:
            fh.write(f"file '{s}'\n")

    silent = os.path.join(WORK, "silent.mp4")
    run(["ffmpeg", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing,
         "-c", "copy", "-y", silent])

    # music: a supplied track if there is one, otherwise a synthesised bed
    music = next((os.path.join(HERE, f) for f in ("music.mp3", "music.wav")
                  if os.path.exists(os.path.join(HERE, f))), None)
    if music:
        aud = ["-i", music]
        amix = (f"[1:a]atrim=0:{total},asetpts=PTS-STARTPTS,"
                f"afade=t=in:st=0:d=1.5,afade=t=out:st={total-3:.2f}:d=3,"
                f"volume=0.85,loudnorm=I=-16:TP=-1.5[aout]")
    else:
        aud = []
        amix = (f"sine=frequency=55:duration={total}:sample_rate=48000[b1];"
                f"sine=frequency=110:duration={total}:sample_rate=48000[b2];"
                f"sine=frequency=164.81:duration={total}:sample_rate=48000[b3];"
                f"[b1][b2][b3]amix=inputs=3:duration=longest,"
                f"tremolo=f=2.0:d=0.30,lowpass=f=900,"
                f"afade=t=in:st=0:d=1.5,afade=t=out:st={total-3:.2f}:d=3,"
                f"volume=0.30,loudnorm=I=-18:TP=-2,"
                f"aformat=channel_layouts=stereo[aout]")

    run(["ffmpeg", "-v", "error", "-i", silent] + aud +
        ["-filter_complex", amix, "-map", "0:v", "-map", "[aout]",
         "-t", f"{total}", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", "-y", OUT])

    print(f"\n{total:.1f}s  ·  {generated} generated clip(s), {synthesised} camera move(s)")
    print("→", OUT)
    if synthesised:
        print(f"\nDrop clips into {SHOTS}/ named 02-*.mp4 … 08-*.mp4 and re-run;")
        print("each one replaces its camera move automatically.")


if __name__ == "__main__":
    main()
