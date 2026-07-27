/**
 * The 30-second cut. Same real footage and same animation vocabulary as the long
 * version, but the callout timings are expressed as fractions of each scene's
 * length rather than absolute seconds — at 5s a beat written for 14s never fires.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FR = path.join(DIR, "compositions", "short");
fs.mkdirSync(FR, { recursive: true });

const ORANGE = "#FF6B2B", INK = "#FAFAFA", DIM = "#A1A1AA", GROUND = "#0A0A0B";
const FONT = "Space_Grotesk_Variable.woff2";

// id, seconds, voice line
const SCENES = [
  ["pain", 4.7, "01"],
  ["claim", 2.4, "02"],
  ["handoff", 5.2, "03"],
  ["board", 4.0, "04"],
  ["pad", 3.4, "05"],
  ["brain", 6.6, "06"],
  ["close", 3.9, "07"],
];

const head = (id) => `<style>
@font-face{font-family:"SG";src:url("assets/${FONT}") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"LoomMono";src:local("Menlo"),local("SF Mono"),local("Monaco");font-display:block}
#${id}{position:absolute;inset:0;overflow:hidden;font-family:"SG",system-ui,sans-serif;color:${INK}}
#${id} .clip{position:absolute}
#${id} .bg{inset:0;width:100%;height:100%;background:${GROUND}}
#${id} .shot{inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
#${id} .mono{font-family:"LoomMono",monospace}
#${id} .call{border:2px solid ${ORANGE};border-radius:8px;box-shadow:0 0 0 9999px rgba(10,10,11,.55)}
#${id} .tag{background:${ORANGE};color:${GROUND};font-weight:700;font-size:20px;letter-spacing:.06em;
  padding:7px 13px;border-radius:6px;white-space:nowrap}
#${id} .band{left:0;right:0;bottom:0;height:104px;background:linear-gradient(0deg,rgba(10,10,11,.97),rgba(10,10,11,.86) 62%,transparent);
  display:flex;align-items:center;justify-content:center;gap:26px}
#${id} .bandttl{font-size:27px;font-weight:700;letter-spacing:.03em;color:${ORANGE}}
#${id} .bandsub{font-size:21px;color:${DIM}}
</style>`;

const tl = (id, body) => `<script>
(function(){
  window.__timelines = window.__timelines || {};
  var tl = gsap.timeline({paused:true});
  window.__timelines[${JSON.stringify(id)}] = tl;
${body}
})();
</script>`;

const push = (sel, s, from, to) =>
  `  gsap.set(${sel},{scale:${from}});\n  tl.to(${sel},{scale:${to},duration:${s},ease:"none"},0);\n`;

/** at/hold given as FRACTIONS of the scene, so a beat always fires. */
const call = (sel, s, atF, holdF) => {
  const at = +(s * atF).toFixed(2), hold = +(s * holdF).toFixed(2);
  return `  gsap.set(${sel},{opacity:0,scale:0.94});\n` +
    `  tl.to(${sel},{opacity:1,scale:1,duration:0.26,ease:"back.out(2)"},${at});\n` +
    `  tl.to(${sel},{opacity:0,duration:0.22,ease:"power2.in"},${(at + hold).toFixed(2)});\n`;
};
const snap = (sel, s) =>
  `  gsap.set(${sel},{opacity:0,y:26});\n  tl.to(${sel},{opacity:1,y:0,duration:0.34,ease:"back.out(1.7)"},${(s * 0.06).toFixed(2)});\n`;

const band = (t, sub) => `<div class="clip band" id="band" data-start="0" data-duration="99" data-track-index="8">
   <div class="bandttl">${t}</div>${sub ? `<div class="bandsub mono">${sub}</div>` : ""}</div>`;

const S = {
  pain: (s) => ({
    body: `<img class="clip shot" id="a" src="assets/cards/scene01-pain.png" data-start="0" data-duration="${s}" data-track-index="1">`,
    js: push("'#a'", s, 1.02, 1.09),
  }),
  claim: (s) => ({
    body: `<img class="clip shot" id="a" src="assets/cards/scene02-claim.png" data-start="0" data-duration="${s}" data-track-index="1">`,
    js: push("'#a'", s, 1.0, 1.05),
  }),
  handoff: (s) => ({
    body: `<img class="clip shot" id="a" src="assets/shots/000-thread-real-route.png" data-start="0" data-duration="${s}" data-track-index="1">
      <div class="clip call" id="c1" style="left:31%;top:20%;width:44%;height:7%" data-start="0" data-duration="${s}" data-track-index="4"></div>
      <div class="clip tag" id="t1" style="left:31%;top:14.5%" data-start="0" data-duration="${s}" data-track-index="5">STEP 1 · PLANNER</div>
      <div class="clip call" id="c2" style="left:31%;top:46%;width:44%;height:6%" data-start="0" data-duration="${s}" data-track-index="6"></div>
      <div class="clip tag" id="t2" style="left:31%;top:40.5%" data-start="0" data-duration="${s}" data-track-index="7">BATON → CODEX</div>
      ${band("PLAN → EXECUTE", "the context goes with the baton")}`,
    js: push("'#a'", s, 1.0, 1.06) + call("'#c1'", s, 0.08, 0.36) + call("'#t1'", s, 0.10, 0.34) +
        call("'#c2'", s, 0.50, 0.42) + call("'#t2'", s, 0.52, 0.40) + snap("'.band'", s),
  }),
  board: (s) => ({
    body: `<img class="clip shot" id="a" src="assets/shots/017-board-kanban.png" data-start="0" data-duration="${s}" data-track-index="1">
      <div class="clip call" id="c1" style="left:14.6%;top:15%;width:17%;height:23%" data-start="0" data-duration="${s}" data-track-index="4"></div>
      <div class="clip tag" id="t1" style="left:14.6%;top:10%" data-start="0" data-duration="${s}" data-track-index="5">CODEX IS BUILDING</div>
      <div class="clip call" id="c2" style="left:49.8%;top:15%;width:17%;height:17%" data-start="0" data-duration="${s}" data-track-index="6"></div>
      <div class="clip tag" id="t2" style="left:49.8%;top:10%" data-start="0" data-duration="${s}" data-track-index="7">OPENCODE REVIEWING</div>
      ${band("THE FLEET'S WORK", "every task carries its agent")}`,
    js: push("'#a'", s, 1.0, 1.05) + call("'#c1'", s, 0.08, 0.34) + call("'#t1'", s, 0.10, 0.32) +
        call("'#c2'", s, 0.50, 0.40) + call("'#t2'", s, 0.52, 0.38) + snap("'.band'", s),
  }),
  pad: (s) => ({
    body: `<video class="clip shot" id="a" src="assets/video/loompad-short.mp4" muted playsinline preload="auto"
        data-start="0" data-duration="${s}" data-media-start="0" data-track-index="1"></video>
      ${band("THE LOOMPAD", "one key per agent · open hardware")}`,
    js: snap("'.band'", s),
  }),
  brain: (s) => ({
    body: `<img class="clip shot" id="a" src="assets/shots/019-brain.png" data-start="0" data-duration="${s}" data-track-index="1">
      <div class="clip call" id="c1" style="left:28.5%;top:12.6%;width:41%;height:5%" data-start="0" data-duration="${s}" data-track-index="4"></div>
      <div class="clip tag" id="t1" style="left:70.5%;top:12.8%" data-start="0" data-duration="${s}" data-track-index="5">CODEX</div>
      <div class="clip call" id="c2" style="left:28.5%;top:30.5%;width:41%;height:4.6%" data-start="0" data-duration="${s}" data-track-index="6"></div>
      <div class="clip tag" id="t2" style="left:70.5%;top:30.7%" data-start="0" data-duration="${s}" data-track-index="7">ANTIGRAVITY</div>
      <div class="clip call" id="c3" style="left:28.5%;top:50.5%;width:41%;height:4.6%" data-start="0" data-duration="${s}" data-track-index="9"></div>
      <div class="clip tag" id="t3" style="left:70.5%;top:50.7%" data-start="0" data-duration="${s}" data-track-index="10">OPENCODE</div>
      <div class="clip call" id="c4" style="left:28.5%;top:63.5%;width:41%;height:4.6%" data-start="0" data-duration="${s}" data-track-index="11"></div>
      <div class="clip tag" id="t4" style="left:70.5%;top:63.7%" data-start="0" data-duration="${s}" data-track-index="12">CLAUDE CODE</div>
      ${band("ONE SHARED BRAIN", "four agents wrote it · all can read it")}`,
    js: push("'#a'", s, 1.0, 1.05) +
        call("'#c1'", s, 0.10, 0.17) + call("'#t1'", s, 0.11, 0.16) +
        call("'#c2'", s, 0.31, 0.17) + call("'#t2'", s, 0.32, 0.16) +
        call("'#c3'", s, 0.52, 0.17) + call("'#t3'", s, 0.53, 0.16) +
        call("'#c4'", s, 0.73, 0.22) + call("'#t4'", s, 0.74, 0.21) + snap("'.band'", s),
  }),
  close: (s) => ({
    body: `<img class="clip shot" id="a" src="assets/cards/scene10-close.png" data-start="0" data-duration="${s}" data-track-index="1">`,
    js: `  gsap.set('#a',{scale:1.04});\n  tl.to('#a',{scale:1.0,duration:1.2,ease:"power2.out"},0);\n`,
  }),
};

let total = 0; const mounts = [];
for (const [id, secs, vo] of SCENES) {
  const cid = "sh-" + id;
  const { body, js } = S[id](secs);
  fs.writeFileSync(path.join(FR, `${id}.html`), `<!doctype html>
<html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
${head(cid)}
</head><body>
<div id="${cid}" data-composition-id="${cid}" data-width="1920" data-height="1080" data-start="0" data-duration="${secs}">
<div class="clip bg" id="${cid}-bg" data-start="0" data-duration="${secs}" data-track-index="0"></div>
${body}
</div>
${tl(cid, js)}
</body></html>`);
  mounts.push({ id, secs, vo, at: total }); total += secs;
}

fs.writeFileSync(path.join(DIR, "index-30.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Loom — 30s</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<style>html,body{margin:0;background:#0A0A0B}
#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#0A0A0B}
#root .clip{position:absolute}</style></head><body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${total.toFixed(2)}">
${mounts.map((m) => `  <div class="clip" id="mt-${m.vo}" data-composition-id="sh-${m.id}" data-composition-src="compositions/short/${m.id}.html"
       data-start="${m.at.toFixed(2)}" data-duration="${m.secs}" data-track-index="1" style="inset:0;width:100%;height:100%"></div>`).join("\n")}
${mounts.map((m) => `  <audio class="clip" id="vo-${m.vo}" src="assets/vo30/${m.vo}.wav"
       data-start="${(m.at + 0.2).toFixed(2)}" data-duration="${(m.secs - 0.2).toFixed(2)}" data-track-index="20"></audio>`).join("\n")}
</div>
<script>window.__timelines=window.__timelines||{};window.__timelines["root"]=gsap.timeline({paused:true});<\/script>
</body></html>`);

console.log(`${mounts.length} short frames · total ${total.toFixed(2)}s`);
