/**
 * Lays the real footage over the rendered base, then puts the captions back on
 * top of it.
 *
 * Order matters and is the whole trick. The base render already carries its own
 * captions, but any scene that gets a screen recording laid over it loses them —
 * the overlay is opaque and buries them. So a second render (index-subs.html)
 * draws nothing but the captions on flat green, and that goes on last with a
 * colour key, so every caption survives regardless of what is underneath it.
 *
 * Audio: the voice track comes from the base render, the pad section keeps the
 * real device audio from its own clip, and a synthesised bed sits under both at
 * 5%. The bed is generated here rather than licensed.
 *
 * Usage: node stitch.mjs [out.mp4]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const D = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(D, "renders", "loom-yc-demo.mp4");
const V = (n) => path.join(D, "assets", "video", n);
const TOTAL = 167.5;

// file, when it lands, how long it shows. Each window matches the scene it
// replaces exactly — see build180.mjs's scene table.
const OVER = [
  { f: "ui-chat.mp4", at: 11.0, dur: 18.4 },
  { f: "ui-board.mp4", at: 29.4, dur: 10.4 },
  { f: "ui-brain.mp4", at: 39.8, dur: 12.3 },
  { f: "build-pad.mp4", at: 67.1, dur: 18.1 },
  { f: "loompad-usage.mp4", at: 85.2, dur: 52.0, audio: true },
  { f: "circuits.mp4", at: 137.2, dur: 15.1 },
];

const inputs = ["-i", path.join(D, "renders", "base-sync.mp4")];
for (const o of OVER) inputs.push("-i", V(o.f));
inputs.push("-i", path.join(D, "renders", "subs-sync.mp4"));
const SUBS_IDX = OVER.length + 1;

const fc = [];
let cur = "[0:v]";
OVER.forEach((o, i) => {
  // scale to frame and shift the clip's own clock to where it lands
  fc.push(`[${i + 1}:v]scale=1920:1080:force_original_aspect_ratio=increase,` +
    `crop=1920:1080,setpts=PTS-STARTPTS+${o.at}/TB[v${i}]`);
  const out = `o${i}`;
  fc.push(`${cur}[v${i}]overlay=0:0:enable='between(t,${o.at},${o.at + o.dur})'[${out}]`);
  cur = `[${out}]`;
});
// Captions last, keyed off the green so only the text and its plate remain.
// Key THEN despill, never the other way round: despill neutralises the green,
// so running it first leaves colorkey nothing to match and the whole opaque
// caption frame lands on top of the video. The despill pass afterwards cleans
// the black/green blend on the plate's anti-aliased corners.
fc.push(`[${SUBS_IDX}:v]scale=1920:1080,setpts=PTS-STARTPTS,` +
  `colorkey=0x00FF00:0.45:0.02,despill=type=green:mix=1:expand=0[subk]`);
fc.push(`${cur}[subk]overlay=0:0[vout]`);

// --- audio -----------------------------------------------------------------
const padClip = OVER.findIndex((o) => o.audio) + 1;
fc.push(`[0:a]volume=1.0[vo]`);
fc.push(`[${padClip}:a]atrim=0:${OVER[padClip - 1].dur},asetpts=PTS-STARTPTS,` +
  `adelay=${Math.round(OVER[padClip - 1].at * 1000)}|${Math.round(OVER[padClip - 1].at * 1000)},` +
  `volume=1.0[padA]`);
// a bed, not a track: two detuned pads an octave apart, breathing slowly
fc.push(`sine=frequency=110:duration=${TOTAL}:sample_rate=48000[b1]`);
fc.push(`sine=frequency=164.81:duration=${TOTAL}:sample_rate=48000[b2]`);
fc.push(`sine=frequency=220:duration=${TOTAL}:sample_rate=48000[b3]`);
fc.push(`[b1][b2][b3]amix=inputs=3:duration=longest,` +
  `tremolo=f=0.18:d=0.55,lowpass=f=1200,` +
  `afade=t=in:st=0:d=2,afade=t=out:st=${TOTAL - 4}:d=4,` +
  `volume=0.05,aformat=channel_layouts=stereo[bed]`);
fc.push(`[vo][padA][bed]amix=inputs=3:duration=first:normalize=0,` +
  `loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);

const args = [...inputs,
  "-filter_complex", fc.join(";"),
  "-map", "[vout]", "-map", "[aout]",
  "-t", String(TOTAL),
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
  "-y", OUT];

console.log("stitching", OVER.length, "clips + captions →", path.basename(OUT));
const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
process.exit(r.status ?? 1);
