/**
 * Emits every frame of the 3-minute cut plus the root index.
 *
 * One generator rather than ten hand-written files, so the animation vocabulary
 * — the push, the callout that draws itself onto a real UI region, the snap
 * label — is defined once and every scene moves the same way.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FR = path.join(DIR, "compositions", "frames");
fs.mkdirSync(FR, { recursive: true });

const FPS = 30;
const ORANGE = "#FF6B2B";
const INK = "#FAFAFA";
const DIM = "#A1A1AA";
const GROUND = "#0A0A0B";

// scene id, seconds, voice line
const SID = (id) => "s" + id;   // ids must start with a letter
const SCENES = [
  ["01-pain", 11.0, "01"],
  ["02-claim", 5.6, "02"],
  ["03-prompt", 11.2, "03"],
  ["04-handoff", 14.0, "04"],
  ["05-board", 12.4, "05"],
  ["06-roles", 10.9, "06"],
  ["07-fleet", 11.2, "07"],
  ["08-pad", 35.0, "08"],
  ["09-brain", 16.6, "09"],
  ["10-close", 7.4, "10"],
];

const FONT = "Space_Grotesk_Variable.woff2";

/** Shared chrome: the brand face, the ground, and the motion primitives. */
const head = (id) => `<style>
@font-face{font-family:"SG";src:url("assets/${FONT}") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"LoomMono";src:local("Menlo"),local("SF Mono"),local("Monaco");font-display:block}
#${id}{position:absolute;inset:0;overflow:hidden;font-family:"SG",system-ui,sans-serif;color:${INK}}
#${id} .clip{position:absolute}
#${id} .bg{inset:0;width:100%;height:100%;background:${GROUND}}
#${id} .shot{inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
#${id} .mono{font-family:"LoomMono",monospace}
/* the callout: a hairline orange box that draws itself around a real UI region */
#${id} .call{border:2px solid ${ORANGE};border-radius:8px;box-shadow:0 0 0 9999px rgba(10,10,11,.55)}
#${id} .tag{background:${ORANGE};color:${GROUND};font-weight:700;font-size:20px;letter-spacing:.06em;
  padding:7px 13px;border-radius:6px;white-space:nowrap}
/* the lower band: one line of chrome that never fights the UI above it */
#${id} .band{left:0;right:0;bottom:0;height:104px;background:linear-gradient(0deg,rgba(10,10,11,.97),rgba(10,10,11,.86) 62%,transparent);
  display:flex;align-items:center;justify-content:center;gap:26px}
#${id} .bandttl{font-size:27px;font-weight:700;letter-spacing:.03em}
#${id} .bandsub{font-size:21px;color:${DIM}}
#${id} .rule{background:${ORANGE};height:3px}
</style>`;

/** A paused GSAP timeline registered the way the runtime expects. */
const tl = (id, secs, body) => `<script>
(function(){
  window.__timelines = window.__timelines || {};
  var tl = gsap.timeline({paused:true});
  window.__timelines[${JSON.stringify(id)}] = tl;
  var R = function(s){ return document.querySelector('#${id} ' + s); };
  var RA = function(s){ return Array.prototype.slice.call(document.querySelectorAll('#${id} ' + s)); };
${body}
})();
</script>`;

/** Push a still: fast in, then a slow drift. Energetic, not sleepy. */
const push = (sel, secs, from = 1.0, to = 1.09) =>
  `  gsap.set(${sel}, {scale:${from}});\n` +
  `  tl.to(${sel}, {scale:${to}, duration:${secs}, ease:"none"}, 0);\n`;

/** A callout drawing itself on, holding, then leaving. */
const callout = (sel, at, hold) =>
  `  gsap.set(${sel}, {opacity:0, scale:0.94});\n` +
  `  tl.to(${sel}, {opacity:1, scale:1, duration:0.34, ease:"back.out(2)"}, ${at});\n` +
  `  tl.to(${sel}, {opacity:0, duration:0.28, ease:"power2.in"}, ${at + hold});\n`;

/** Label snapping up from the band. */
const snap = (sel, at) =>
  `  gsap.set(${sel}, {opacity:0, y:26});\n` +
  `  tl.to(${sel}, {opacity:1, y:0, duration:0.42, ease:"back.out(1.7)"}, ${at});\n`;

const band = (title, sub) =>
  `<div class="clip band" id="band" data-start="0" data-duration="99" data-track-index="8">
     <div class="bandttl" style="color:${ORANGE}">${title}</div>
     ${sub ? `<div class="bandsub mono">${sub}</div>` : ""}
   </div>`;

// ---------------------------------------------------------------- scenes ----
const F = {};

// 1 — the pain. The card is already designed; the motion is a hard push plus a
// beat where the orange divider snaps in.
F["01-pain"] = (id, s) => ({
  body: `<img class="clip shot" id="p-img" src="assets/cards/scene01-pain.png" data-start="0" data-duration="${s}" data-track-index="1">`,
  js: push("'#p-img'", s, 1.02, 1.1),
});

// 2 — the claim.
F["02-claim"] = (id, s) => ({
  body: `<img class="clip shot" id="c-img" src="assets/cards/scene02-claim.png" data-start="0" data-duration="${s}" data-track-index="1">`,
  js: push("'#c-img'", s, 1.0, 1.06),
});

// 3 — the real prompt. Callout lands on the composer where the text was typed.
F["03-prompt"] = (id, s) => ({
  body: `<img class="clip shot" id="q-img" src="assets/shots/001-prompt-typed.png" data-start="0" data-duration="${s}" data-track-index="1">
    <div class="clip call" id="q-call" style="left:14.5%;top:80.5%;width:63%;height:9%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="q-tag" style="left:14.5%;top:75.5%" data-start="0" data-duration="${s}" data-track-index="5">A REAL PROMPT</div>
    ${band("ONE THREAD", "you type once — Loom decides who runs it")}`,
  js: push("'#q-img'", s, 1.0, 1.05) + callout("'#q-call'", 1.5, 6.2) + callout("'#q-tag'", 1.6, 6.1) + snap("'.band'", 0.5),
});

// 4 — the handoff. Two callouts in sequence: the route step, then the baton line.
F["04-handoff"] = (id, s) => ({
  body: `<img class="clip shot" id="h-img" src="assets/shots/000-thread-real-route.png" data-start="0" data-duration="${s}" data-track-index="1">
    <div class="clip call" id="h-c1" style="left:31%;top:20%;width:44%;height:7%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="h-t1" style="left:31%;top:14.5%" data-start="0" data-duration="${s}" data-track-index="5">STEP 1 · PLANNER</div>
    <div class="clip call" id="h-c2" style="left:31%;top:46%;width:44%;height:6%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="h-t2" style="left:31%;top:40.5%" data-start="0" data-duration="${s}" data-track-index="5">BATON → CODEX</div>
    ${band("PLAN → EXECUTE", "the context goes with the baton")}`,
  js: push("'#h-img'", s, 1.0, 1.07) +
      callout("'#h-c1'", 1.2, 3.6) + callout("'#h-t1'", 1.3, 3.5) +
      callout("'#h-c2'", 6.4, 4.4) + callout("'#h-t2'", 6.5, 4.3) + snap("'.band'", 0.4),
});

// 5 — the board. Callouts walk the columns so the eye is led across them.
F["05-board"] = (id, s) => ({
  body: `<img class="clip shot" id="b-img" src="assets/shots/017-board-kanban.png" data-start="0" data-duration="${s}" data-track-index="1">
    <div class="clip call" id="b-c1" style="left:14.6%;top:15%;width:17%;height:23%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="b-t1" style="left:14.6%;top:10%" data-start="0" data-duration="${s}" data-track-index="5">CODEX IS BUILDING</div>
    <div class="clip call" id="b-c2" style="left:32.3%;top:15%;width:17%;height:19%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="b-t2" style="left:32.3%;top:10%" data-start="0" data-duration="${s}" data-track-index="5">NEEDS A HUMAN</div>
    <div class="clip call" id="b-c3" style="left:49.8%;top:15%;width:17%;height:17%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="b-t3" style="left:49.8%;top:10%" data-start="0" data-duration="${s}" data-track-index="5">OPENCODE REVIEWING</div>
    ${band("THE FLEET'S WORK", "every task carries the agent that owns it")}`,
  js: push("'#b-img'", s, 1.0, 1.06) +
      callout("'#b-c1'", 1.6, 2.6) + callout("'#b-t1'", 1.7, 2.5) +
      callout("'#b-c2'", 5.0, 2.4) + callout("'#b-t2'", 5.1, 2.3) +
      callout("'#b-c3'", 8.0, 2.8) + callout("'#b-t3'", 8.1, 2.7) + snap("'.band'", 0.4),
});

// 6 — roles. One callout on the role column, one on the disabled baton toggle,
// which is the detail that shows the model is real.
F["06-roles"] = (id, s) => ({
  body: `<img class="clip shot" id="r-img" src="assets/shots/018-roles-per-ade.png" data-start="0" data-duration="${s}" data-track-index="1">
    <div class="clip call" id="r-c1" style="left:59.5%;top:30%;width:12%;height:44%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="r-t1" style="left:56%;top:24.5%" data-start="0" data-duration="${s}" data-track-index="5">A ROLE EACH</div>
    <div class="clip call" id="r-c2" style="left:37.5%;top:38.5%;width:9%;height:7%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="r-t2" style="left:31%;top:33%" data-start="0" data-duration="${s}" data-track-index="5">HOLDS THE BATON — CAN'T BE SWITCHED OFF</div>
    ${band("YOU DECIDE WHO DOES WHAT", "")}`,
  js: push("'#r-img'", s, 1.0, 1.05) +
      callout("'#r-c1'", 1.3, 3.8) + callout("'#r-t1'", 1.4, 3.7) +
      callout("'#r-c2'", 6.0, 3.6) + callout("'#r-t2'", 6.1, 3.5) + snap("'.band'", 0.4),
});

// 7 — the fleet.
F["07-fleet"] = (id, s) => ({
  body: `<img class="clip shot" id="f-img" src="assets/cards/scene07-fleet.png" data-start="0" data-duration="${s}" data-track-index="1">`,
  js: push("'#f-img'", s, 1.0, 1.05),
});

// 8 — the pad. Real hardware, real hands. The video carries it; the chrome
// stays out of the way and only names what you're looking at.
F["08-pad"] = (id, s) => ({
  body: `<video class="clip shot" id="pad-v" src="assets/video/loompad-usage.mp4" muted playsinline preload="auto"
      data-start="0" data-duration="${s}" data-media-start="0" data-track-index="1"></video>
    <div class="clip tag" id="pad-t1" style="left:6%;top:8%" data-start="0" data-duration="${s}" data-track-index="5">ITS OWN WI-FI · LoomPad-Setup</div>
    <div class="clip tag" id="pad-t2" style="left:6%;top:8%" data-start="0" data-duration="${s}" data-track-index="5">ONE KEY PER AGENT</div>
    <div class="clip tag" id="pad-t3" style="left:6%;top:8%" data-start="0" data-duration="${s}" data-track-index="5">PRESS · THE FLEET ANSWERS</div>
    ${band("THE LOOMPAD", "open hardware · printable · ESP32-S3")}`,
  js: `  gsap.set('#pad-t1',{opacity:0}); gsap.set('#pad-t2',{opacity:0}); gsap.set('#pad-t3',{opacity:0});\n` +
      snap("'.band'", 0.6) +
      callout("'#pad-t1'", 1.2, 5.0) +
      callout("'#pad-t2'", 12.0, 6.0) +
      callout("'#pad-t3'", 24.0, 7.0),
});

// 9 — the brain. The payoff: four different agents, one store. The callouts
// name the authors, because the attribution IS the argument.
F["09-brain"] = (id, s) => ({
  body: `<img class="clip shot" id="n-img" src="assets/shots/019-brain.png" data-start="0" data-duration="${s}" data-track-index="1">
    <div class="clip call" id="n-c0" style="left:29%;top:2.6%;width:26%;height:5.2%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="n-t0" style="left:56.5%;top:2.8%" data-start="0" data-duration="${s}" data-track-index="5">21 THINGS THIS PROJECT LEARNED</div>
    <div class="clip call" id="n-c1" style="left:28.5%;top:12.6%;width:41%;height:5%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="n-t1" style="left:70.5%;top:12.8%" data-start="0" data-duration="${s}" data-track-index="5">CODEX WROTE THIS</div>
    <div class="clip call" id="n-c2" style="left:28.5%;top:30.5%;width:41%;height:4.6%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="n-t2" style="left:70.5%;top:30.7%" data-start="0" data-duration="${s}" data-track-index="5">ANTIGRAVITY WROTE THIS</div>
    <div class="clip call" id="n-c3" style="left:28.5%;top:50.5%;width:41%;height:4.6%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="n-t3" style="left:70.5%;top:50.7%" data-start="0" data-duration="${s}" data-track-index="5">OPENCODE WROTE THIS</div>
    <div class="clip call" id="n-c4" style="left:28.5%;top:63.5%;width:41%;height:4.6%" data-start="0" data-duration="${s}" data-track-index="4"></div>
    <div class="clip tag" id="n-t4" style="left:70.5%;top:63.7%" data-start="0" data-duration="${s}" data-track-index="5">CLAUDE CODE WROTE THIS</div>
    ${band("ONE SHARED BRAIN", "four agents wrote it · all of them can read it")}`,
  js: push("'#n-img'", s, 1.0, 1.05) +
      callout("'#n-c0'", 0.8, 2.2) + callout("'#n-t0'", 0.9, 2.1) +
      callout("'#n-c1'", 3.9, 2.3) + callout("'#n-t1'", 4.0, 2.2) +
      callout("'#n-c2'", 6.7, 2.3) + callout("'#n-t2'", 6.8, 2.2) +
      callout("'#n-c3'", 9.5, 2.3) + callout("'#n-t3'", 9.6, 2.2) +
      callout("'#n-c4'", 12.3, 2.8) + callout("'#n-t4'", 12.4, 2.7) + snap("'.band'", 0.3),
});

// 10 — close.
F["10-close"] = (id, s) => ({
  body: `<img class="clip shot" id="z-img" src="assets/cards/scene10-close.png" data-start="0" data-duration="${s}" data-track-index="1">`,
  js: `  gsap.set('#z-img',{scale:1.04});\n  tl.to('#z-img',{scale:1.0,duration:1.4,ease:"power2.out"},0);\n`,
});

// ---------------------------------------------------------------- emit ------
let total = 0;
const mounts = [];
for (const [id, secs, vo] of SCENES) {
  const cid = SID(id);
  let { body, js } = F[id](cid, secs);
  // Every callout/tag/band is full-length, so they cannot share a track — the
  // runtime treats same-track clips as sequential and flags the overlap. Hand
  // each timed overlay its own track instead of hand-numbering them per scene.
  let nextTrack = 4;
  body = body.replace(/data-track-index="(?:4|5|8)"/g, () => `data-track-index="${nextTrack++}"`);
  // A sub-composition must be a real document — the loader looks for <body>
  // (or a <template>) and renders nothing from a bare fragment.
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
${head(cid)}
</head>
<body>
<div id="${cid}" data-composition-id="${cid}" data-width="1920" data-height="1080"
  data-start="0" data-duration="${secs}">
<div class="clip bg" id="${cid}-bg" data-start="0" data-duration="${secs}" data-track-index="0"></div>
${body}
</div>
${tl(cid, secs, js)}
</body></html>`;
  fs.writeFileSync(path.join(FR, `${id}.html`), html);
  mounts.push({ id, secs, vo, at: total });
  total += secs;
}

// root index — scenes back to back, voice on its own track under them
const root = `<!doctype html>
<html><head><meta charset="utf-8"><title>Loom — YC</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<style>html,body{margin:0;background:#0A0A0B}
#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#0A0A0B}
#root .clip{position:absolute}</style></head>
<body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080"
     data-start="0" data-duration="${total.toFixed(2)}">
${mounts.map((m) => `  <div class="clip" id="mount-${m.vo}" data-composition-id="s${m.id}" data-composition-src="compositions/frames/${m.id}.html"
       data-start="${m.at.toFixed(2)}" data-duration="${m.secs}" data-track-index="1"
       style="inset:0;width:100%;height:100%"></div>`).join("\n")}
${mounts.map((m) => `  <audio class="clip" id="vo-${m.vo}" src="assets/vo/${m.vo}.wav"
       data-start="${(m.at + 0.25).toFixed(2)}" data-duration="${(m.secs - 0.25).toFixed(2)}" data-track-index="20"></audio>`).join("\n")}
</div>
<script>
window.__timelines = window.__timelines || {};
window.__timelines["root"] = gsap.timeline({paused:true});
</script>
</body></html>`;
fs.writeFileSync(path.join(DIR, "index.html"), root);

console.log(`${mounts.length} frames -> compositions/frames/`);
console.log(`total ${total.toFixed(2)}s (${Math.floor(total / 60)}m ${Math.round(total % 60)}s)`);
