/**
 * Footage-first cut. Nothing here is drawn or recreated — every visual is either
 * a real capture of the running app, the real build footage, or the real pad
 * footage. The previous attempt replaced the interface with diagrams of the
 * interface, which is exactly backwards.
 *
 * Motion comes from moving through the real frames: the streaming turn plays as
 * the 14 sequential captures it actually was, and the long stills travel across
 * the region that matters instead of sitting still under a box.
 *
 * Subtitles are burned in as timed text, one line at a time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FR = path.join(DIR, "compositions", "real");
fs.mkdirSync(FR, { recursive: true });

const O = "#FF6B2B", DIM = "#A1A1AA", G = "#0A0A0B";
const FONT = "Space_Grotesk_Variable.woff2";
const SH = (n) => `assets/shots/${n}.png`;

// scene, seconds, vo, [subtitle lines]
const SC = [
  ["thread", 6.2, "01", ["Every coding agent keeps its own memory.", "Switch tools, and you start over."]],
  ["claim", 2.4, "02", ["Loom makes them one brain."]],
  ["prompt", 4.0, null, ["One prompt. One shared thread."]],
  ["stream", 6.5, "03", ["Pass the baton, and the whole context goes with it.", "Decisions, memory, the thread.", "The next agent picks up mid-task."]],
  ["build", 6.0, "04", ["We built the hardware too.", "Printed, wired, assembled.", "A macropad with one key per agent."]],
  ["pad", 11.0, null, []],
  ["board", 7.2, "05", ["Every task carries the agent that owns it.", "Codex builds. OpenCode reviews.", "This one needs you."]],
  ["roles", 4.4, "06", ["You decide who does what.", "Planner, builder, reviewer."]],
  ["brain", 8.4, "07", ["Four different agents wrote this memory.", "Every one of them can read all of it."]],
  ["close", 4.6, "08", ["Loom. One brain, every agent."]],
];

const head = (id) => `<style>
@font-face{font-family:"SG";src:url("assets/${FONT}") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"LoomMono";src:local("Menlo"),local("SF Mono"),local("Monaco");font-display:block}
#${id}{position:absolute;inset:0;overflow:hidden;background:${G};font-family:"SG",system-ui,sans-serif;color:#FAFAFA}
#${id} .clip{position:absolute}
#${id} .bg{inset:0;width:100%;height:100%;background:${G}}
#${id} .sh{inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
#${id} .m{font-family:"LoomMono",monospace}
/* subtitle: one line, centred low, on a plate so it survives any footage */
#${id} .sub{left:0;right:0;bottom:66px;text-align:center;font-size:37px;font-weight:600;letter-spacing:-.01em}
#${id} .sub span{background:rgba(10,10,11,.9);padding:11px 26px;border-radius:9px;
  box-decoration-break:clone;-webkit-box-decoration-break:clone;line-height:1.75}
#${id} .tag{background:${O};color:${G};font-weight:700;font-size:22px;letter-spacing:.05em;
  padding:8px 15px;border-radius:6px}
#${id} .ttl{font-size:180px;font-weight:700;letter-spacing:-.05em;text-align:center;left:0;right:0}
</style>`;

const wrap = (id, js) => `<script>(function(){window.__timelines=window.__timelines||{};
var tl=gsap.timeline({paused:true});window.__timelines[${JSON.stringify(id)}]=tl;
${js}})();</script>`;

/** Subtitles: each line owns a slice of the scene, one visible at a time. */
function subs(lines, s, startTrack) {
  if (!lines.length) return { html: "", js: "" };
  const span = s / lines.length;
  const html = lines.map((t, i) =>
    `<div class="clip sub" id="sb${i}" data-start="0" data-duration="${s}" data-track-index="${startTrack + i}"><span>${t}</span></div>`).join("\n");
  const js = lines.map((t, i) => {
    const a = +(i * span + 0.12).toFixed(2), b = +((i + 1) * span - 0.04).toFixed(2);
    return `gsap.set('#sb${i}',{opacity:0,y:14});\n` +
      `tl.to('#sb${i}',{opacity:1,y:0,duration:.2,ease:"power2.out"},${a});\n` +
      `tl.to('#sb${i}',{opacity:0,duration:.14},${b});`;
  }).join("\n");
  return { html, js };
}

/** Travel across a real capture — start framed on one region, end on another. */
const travel = (sel, s, a, b) =>
  `gsap.set(${sel},{scale:${a.k},xPercent:${a.x},yPercent:${a.y}});\n` +
  `tl.to(${sel},{scale:${b.k},xPercent:${b.x},yPercent:${b.y},duration:${s},ease:"power1.inOut"},0);\n`;

const S = {};
const still = (file, s, a, b, tag) => ({
  body: `<img class="clip sh" id="im" src="${SH(file)}" data-start="0" data-duration="${s}" data-track-index="1">` +
    (tag ? `<div class="clip tag" id="tg" style="left:5.5%;top:7%" data-start="0" data-duration="${s}" data-track-index="3">${tag}</div>` : ""),
  js: travel("'#im'", s, a, b) +
    (tag ? `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.24,ease:"back.out(3)"},.25);\n` : ""),
});

// the real thread, travelling from the route header down to the reply
S.thread = (s) => still("000-thread-real-route", s, { k: 1.5, x: 4, y: -14 }, { k: 1.22, x: 2, y: 8 }, "THE REAL APP");
S.prompt = (s) => still("001-prompt-typed", s, { k: 1.9, x: 3, y: 22 }, { k: 1.62, x: 2, y: 20 }, "A REAL PROMPT");
S.board = (s) => still("017-board-kanban", s, { k: 1.42, x: 9, y: 2 }, { k: 1.3, x: -7, y: 2 }, "THE BOARD");
S.roles = (s) => still("018-roles-per-ade", s, { k: 1.55, x: 0, y: -3 }, { k: 1.42, x: -2, y: 5 }, "ROLES");
S.brain = (s) => still("019-brain", s, { k: 1.4, x: 1, y: -13 }, { k: 1.26, x: 0, y: 10 }, "THE BRAIN");

// the streaming turn, played as the sequence of captures it actually was
S.stream = (s) => {
  const f = Array.from({ length: 14 }, (_, i) => `00${i + 3}`.slice(-3) + "-generating-" + `0${i}`.slice(-2));
  const per = s / f.length;
  return {
    body: f.map((n, i) => `<img class="clip sh" id="fr${i}" src="${SH(n)}" data-start="0" data-duration="${s}" data-track-index="${1 + i}">`).join("\n") +
      `<div class="clip tag" id="tg" style="left:5.5%;top:7%" data-start="0" data-duration="${s}" data-track-index="30">CODEX, WORKING &mdash; LIVE</div>`,
    js: f.map((_, i) => `gsap.set('#fr${i}',{opacity:${i === 0 ? 1 : 0},scale:1.34,xPercent:2,yPercent:4});\n` +
      (i ? `tl.set('#fr${i}',{opacity:1},${(i * per).toFixed(2)});\n` : "")).join("") +
      f.map((_, i) => `tl.to('#fr${i}',{scale:1.2,duration:${s},ease:"none"},0);\n`).join("") +
      `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.24,ease:"back.out(3)"},.2);\n`,
  };
};

S.claim = (s) => ({
  body: `<div class="clip ttl" id="w" style="top:400px" data-start="0" data-duration="${s}" data-track-index="1">LOOM</div>
    <div class="clip m" id="r" style="left:860px;top:625px;width:0;height:4px;background:${O}" data-start="0" data-duration="${s}" data-track-index="2"></div>
    <div class="clip m" id="t" style="left:0;right:0;top:665px;text-align:center;font-size:28px;color:${DIM}" data-start="0" data-duration="${s}" data-track-index="3">the shared-memory layer for AI coding agents</div>`,
  js: `gsap.set('#w',{opacity:0,scale:.9});gsap.set('#t',{opacity:0});
tl.to('#w',{opacity:1,scale:1,duration:.4,ease:"back.out(2)"},0).to('#r',{width:200,duration:.3},.38).to('#t',{opacity:1,duration:.28},.55);`,
});
S.close = (s) => ({
  body: `<div class="clip ttl" id="w" style="top:330px;font-size:160px" data-start="0" data-duration="${s}" data-track-index="1">LOOM</div>
    <div class="clip" id="s2" style="left:0;right:0;top:520px;text-align:center;font-size:35px;color:${DIM}" data-start="0" data-duration="${s}" data-track-index="2">one brain, every agent</div>
    <div class="clip m" id="i" style="left:0;right:0;top:620px;text-align:center;font-size:30px;color:${O}" data-start="0" data-duration="${s}" data-track-index="3">npm i -g @loompad/cli</div>
    <div class="clip m" id="g" style="left:0;right:0;top:676px;text-align:center;font-size:20px;color:#5a5a63" data-start="0" data-duration="${s}" data-track-index="4">github.com/nickthelegend/loom</div>`,
  js: `gsap.set('#w',{opacity:0,scale:.93});gsap.set(['#s2','#i','#g'],{opacity:0,y:14});
tl.to('#w',{opacity:1,scale:1,duration:.4,ease:"back.out(2)"},0).to(['#s2','#i','#g'],{opacity:1,y:0,duration:.3,stagger:.11},.34);`,
});

// footage windows — composited afterwards; only the tag lives here
const hole = (tag) => (s) => ({
  body: `<div class="clip bg" id="bgx" data-start="0" data-duration="${s}" data-track-index="1"></div>` +
    `<div class="clip tag" id="tg" style="left:5.5%;top:7%" data-start="0" data-duration="${s}" data-track-index="3">${tag}</div>`,
  js: `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.24,ease:"back.out(3)"},.2);\n`,
});
S.build = hole("MAKING THE LOOMPAD");
S.pad = hole("THE LOOMPAD, WORKING");

let total = 0; const M = [];
for (const [id, secs, vo, lines] of SC) {
  const cid = "r-" + id;
  const { body, js } = S[id](secs);
  const sb = subs(lines, secs, 40);
  fs.writeFileSync(path.join(FR, `${id}.html`), `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
${head(cid)}</head><body>
<div id="${cid}" data-composition-id="${cid}" data-width="1920" data-height="1080" data-start="0" data-duration="${secs}">
<div class="clip bg" id="${cid}-bg" data-start="0" data-duration="${secs}" data-track-index="0"></div>
${body}
${sb.html}
</div>
${wrap(cid, js + "\n" + sb.js)}</body></html>`);
  M.push({ id, secs, vo, at: total }); total += secs;
}

fs.writeFileSync(path.join(DIR, "index-real.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Loom</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<style>html,body{margin:0;background:#0A0A0B}#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#0A0A0B}
#root .clip{position:absolute}</style></head><body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${total.toFixed(2)}">
${M.map((m) => `  <div class="clip" id="mt-${m.id}" data-composition-id="r-${m.id}" data-composition-src="compositions/real/${m.id}.html"
   data-start="${m.at.toFixed(2)}" data-duration="${m.secs}" data-track-index="1" style="inset:0;width:100%;height:100%"></div>`).join("\n")}
${M.filter((m) => m.vo).map((m) => `  <audio class="clip" id="vo-${m.vo}" src="assets/vo60/${m.vo}.wav"
   data-start="${(m.at + 0.15).toFixed(2)}" data-duration="${(m.secs - 0.15).toFixed(2)}" data-track-index="20"></audio>`).join("\n")}
</div>
<script>window.__timelines=window.__timelines||{};window.__timelines["root"]=gsap.timeline({paused:true});<\/script>
</body></html>`);

const b = M.find((m) => m.id === "build"), p = M.find((m) => m.id === "pad");
console.log(`${M.length} scenes · ${total.toFixed(2)}s`);
console.log(`BUILD ${b.at.toFixed(2)} ${(b.at + b.secs).toFixed(2)}`);
console.log(`PAD ${p.at.toFixed(2)} ${(p.at + p.secs).toFixed(2)}`);
