/**
 * The 60s pitch, rebuilt as an animated explainer.
 *
 * The previous cut put orange boxes on static screenshots and read as dry,
 * because nothing moved except a slow push. Here the mechanism scenes are drawn
 * and animated — a baton that physically travels between two agent marks
 * carrying context with it, task cards that fly into their columns, memory units
 * that converge from four agents into one store. Screenshots are supporting
 * evidence now, not the main visual.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FR = path.join(DIR, "compositions", "p60");
fs.mkdirSync(FR, { recursive: true });

const O = "#FF6B2B", INK = "#FAFAFA", DIM = "#A1A1AA", G = "#0A0A0B", LINE = "#26262B";
const FONT = "Space_Grotesk_Variable.woff2";
const L = (k) => `assets/logos/logo-${k}.png`;

// id, seconds, vo (null = scene carries its own audio / none)
const SCENES = [
  ["pain", 5.0, "01"],
  ["claim", 1.8, "02"],
  ["baton", 6.5, "03"],
  ["build", 5.5, "04"],   // montage composited over this window
  ["padwork", 8.0, null], // pad footage + its own audio composited
  ["board", 7.0, "05"],
  ["roles", 4.2, "06"],
  ["brain", 12.8, "07"],
  ["close", 4.4, "08"],
];

const head = (id) => `<style>
@font-face{font-family:"SG";src:url("assets/${FONT}") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"LoomMono";src:local("Menlo"),local("SF Mono"),local("Monaco");font-display:block}
#${id}{position:absolute;inset:0;overflow:hidden;background:${G};font-family:"SG",system-ui,sans-serif;color:${INK}}
#${id} .clip{position:absolute}
#${id} .bg{inset:0;width:100%;height:100%;background:${G}}
#${id} .m{font-family:"LoomMono",monospace}
#${id} .lg{width:118px;height:118px;object-fit:contain}
#${id} .card{border:1px solid ${LINE};border-radius:14px;background:#0e0e11}
#${id} .ttl{font-size:52px;font-weight:700;letter-spacing:-.02em}
#${id} .sub{font-size:24px;color:${DIM}}
#${id} .chip{border:1px solid ${LINE};border-radius:99px;padding:9px 20px;font-size:20px;color:${DIM};background:#111116}
#${id} .baton{width:22px;height:22px;border-radius:50%;background:${O};box-shadow:0 0 26px 8px rgba(255,107,43,.55)}
#${id} .wire{height:2px;background:linear-gradient(90deg,${LINE},${O},${LINE})}
#${id} .tcard{border:1px solid ${LINE};border-left:3px solid ${O};border-radius:10px;background:#101014;
  padding:14px 16px;font-size:19px;display:flex;align-items:center;gap:11px}
#${id} .tcard img{width:24px;height:24px;object-fit:contain}
#${id} .col{font-size:16px;letter-spacing:.13em;color:${DIM};text-transform:uppercase}
#${id} .unit{border:1px solid ${LINE};border-radius:10px;background:#101014;padding:12px 15px;font-size:18px;
  display:flex;align-items:center;gap:10px;white-space:nowrap}
#${id} .unit img{width:21px;height:21px;object-fit:contain}
#${id} .kind{font-size:12px;letter-spacing:.1em;padding:3px 8px;border-radius:5px;background:#1c1c22;color:${DIM}}
#${id} .shot{inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
#${id} .band{left:0;right:0;bottom:0;height:96px;background:linear-gradient(0deg,rgba(10,10,11,.97),transparent);
  display:flex;align-items:center;justify-content:center;gap:22px}
#${id} .bt{font-size:26px;font-weight:700;color:${O}} #${id} .bs{font-size:20px;color:${DIM}}
</style>`;

const tlw = (id, js) => `<script>(function(){
window.__timelines=window.__timelines||{};var tl=gsap.timeline({paused:true});
window.__timelines[${JSON.stringify(id)}]=tl;
${js}})();</script>`;

const clip = (n) => `class="clip" data-start="0" data-duration="${n}" data-track-index="`;

const S = {};

// 1 — the pain. Context types into one pane, then the identical wall types into
// the other, and the wall between them lights up.
S.pain = (s) => ({
  body: `<div ${clip(s)}1" style="inset:0">
    <div class="card" style="position:absolute;left:150px;top:250px;width:640px;height:430px"></div>
    <img class="lg" id="p-l1" src="${L("claude-code")}" style="position:absolute;left:410px;top:300px">
    <div class="m" id="p-n1" style="position:absolute;left:150px;top:452px;width:640px;text-align:center;font-size:24px;color:${DIM}">claude-code</div>
    <div class="m" id="p-w1" style="position:absolute;left:196px;top:500px;width:548px;font-size:14px;color:#4d4d55;line-height:1.85;overflow:hidden;height:0">
      &gt; this is a pnpm monorepo on node 20 — four packages, one app.<br>packages/daemon owns every websocket and binds 7420.<br>apps/web is next 15 on the app router.<br>packages/core holds the domain types.<br>tests live beside the file they cover.</div>
    <div class="card" style="position:absolute;left:1130px;top:250px;width:640px;height:430px"></div>
    <img class="lg" id="p-l2" src="${L("codex")}" style="position:absolute;left:1390px;top:300px">
    <div class="m" id="p-n2" style="position:absolute;left:1130px;top:452px;width:640px;text-align:center;font-size:24px;color:${DIM}">codex</div>
    <div class="m" id="p-w2" style="position:absolute;left:1176px;top:500px;width:548px;font-size:14px;color:#4d4d55;line-height:1.85;overflow:hidden;height:0">
      &gt; this is a pnpm monorepo on node 20 — four packages, one app.<br>packages/daemon owns every websocket and binds 7420.<br>apps/web is next 15 on the app router.<br>packages/core holds the domain types.<br>tests live beside the file they cover.</div>
    <div id="p-wall" style="position:absolute;left:958px;top:250px;width:4px;height:430px;background:${O};opacity:0"></div>
    <div class="m" id="p-x" style="position:absolute;left:820px;top:700px;width:280px;text-align:center;font-size:19px;color:${O};letter-spacing:.16em;opacity:0">NO SHARED MEMORY</div>
    <div class="ttl" id="p-t" style="position:absolute;left:0;top:840px;width:1920px;text-align:center;font-size:40px;color:${DIM}">Two agents. Two brains. Neither can read the other.</div>
  </div>`,
  js: `gsap.set(['#p-l1','#p-n1'],{opacity:0,y:18});gsap.set(['#p-l2','#p-n2'],{opacity:0,y:18});
gsap.set('#p-t',{opacity:0,y:20});
tl.to(['#p-l1','#p-n1'],{opacity:1,y:0,duration:.34,ease:"back.out(2)"},.15)
  .to('#p-w1',{height:140,duration:1.1,ease:"none"},.5)
  .to(['#p-l2','#p-n2'],{opacity:1,y:0,duration:.34,ease:"back.out(2)"},1.8)
  .to('#p-w2',{height:140,duration:1.1,ease:"none"},2.1)
  .to('#p-wall',{opacity:1,duration:.22},3.3)
  .to('#p-x',{opacity:1,duration:.26},3.45)
  .to('#p-t',{opacity:1,y:0,duration:.4,ease:"back.out(1.6)"},3.7);`,
});

// 2 — the claim.
S.claim = (s) => ({
  body: `<div ${clip(s)}1" style="inset:0">
    <div id="c-w" class="ttl" style="position:absolute;left:0;top:400px;width:1920px;text-align:center;font-size:190px;letter-spacing:-.05em">LOOM</div>
    <div id="c-r" style="position:absolute;left:860px;top:620px;width:0;height:4px;background:${O}"></div>
    <div id="c-s" class="m" style="position:absolute;left:0;top:660px;width:1920px;text-align:center;font-size:27px;color:${DIM}">the shared-memory layer for AI coding agents</div>
  </div>`,
  js: `gsap.set('#c-w',{opacity:0,scale:.9});gsap.set('#c-s',{opacity:0});
tl.to('#c-w',{opacity:1,scale:1,duration:.42,ease:"back.out(2)"},0)
  .to('#c-r',{width:200,duration:.3,ease:"power2.out"},.4)
  .to('#c-s',{opacity:1,duration:.3},.6);`,
});

// 3 — the baton, explained rather than highlighted. It physically travels, and
// the three things it carries travel with it.
S.baton = (s) => ({
  body: `<div ${clip(s)}1" style="inset:0">
    <div class="col" style="position:absolute;left:0;top:150px;width:1920px;text-align:center">pass the baton</div>
    <img class="lg" src="${L("claude-code")}" style="position:absolute;left:270px;top:400px">
    <div class="m" style="position:absolute;left:180px;top:540px;width:300px;text-align:center;font-size:22px;color:${DIM}">claude-code</div>
    <div class="m" style="position:absolute;left:180px;top:576px;width:300px;text-align:center;font-size:16px;color:#5a5a63">planner</div>
    <img class="lg" src="${L("codex")}" style="position:absolute;left:1530px;top:400px">
    <div class="m" style="position:absolute;left:1440px;top:540px;width:300px;text-align:center;font-size:22px;color:${DIM}">codex</div>
    <div class="m" style="position:absolute;left:1440px;top:576px;width:300px;text-align:center;font-size:16px;color:#5a5a63">builder</div>
    <div class="wire" id="b-wire" style="position:absolute;left:470px;top:458px;width:0"></div>
    <div class="baton" id="b-tok" style="position:absolute;left:462px;top:448px"></div>
    <div class="chip" id="b-c1" style="position:absolute;left:560px;top:640px">decisions</div>
    <div class="chip" id="b-c2" style="position:absolute;left:800px;top:640px">memory</div>
    <div class="chip" id="b-c3" style="position:absolute;left:1030px;top:640px">the whole thread</div>
    <div class="m" id="b-done" style="position:absolute;left:0;top:780px;width:1920px;text-align:center;font-size:30px;color:${O};opacity:0">picks up mid-task &mdash; nothing re-explained</div>
  </div>`,
  js: `gsap.set(['#b-c1','#b-c2','#b-c3'],{opacity:0,y:16});
tl.to('#b-wire',{width:1060,duration:.7,ease:"power2.out"},.2)
  .to(['#b-c1','#b-c2','#b-c3'],{opacity:1,y:0,duration:.3,stagger:.16,ease:"back.out(2)"},.7)
  .to('#b-tok',{x:1062,duration:1.5,ease:"power2.inOut"},1.6)
  .to(['#b-c1','#b-c2','#b-c3'],{x:640,duration:1.5,ease:"power2.inOut"},1.7)
  .to(['#b-c1','#b-c2','#b-c3'],{opacity:0,duration:.3},3.2)
  .to('#b-done',{opacity:1,duration:.35,ease:"back.out(1.6)"},3.5);`,
});

// 4 / 5 — footage windows. Correctly timed holes; the montage and the pad clip
// are composited over them afterwards because a short <video> never finishes
// decoding before the renderer captures it.
S.build = (s) => ({
  body: `<div ${clip(s)}1" class="bg"></div>
    <div ${clip(s)}8" class="band"><div class="bt">WE BUILT THE HARDWARE</div><div class="bs m">printed &middot; wired &middot; assembled</div></div>`,
  js: `gsap.set('.band',{opacity:0,y:22});tl.to('.band',{opacity:1,y:0,duration:.3,ease:"back.out(2)"},.2);`,
});
S.padwork = (s) => ({
  body: `<div ${clip(s)}1" class="bg"></div>
    <div ${clip(s)}8" class="band"><div class="bt">THE LOOMPAD</div><div class="bs m">it speaks the agent's reply back</div></div>`,
  js: `gsap.set('.band',{opacity:0,y:22});tl.to('.band',{opacity:1,y:0,duration:.3,ease:"back.out(2)"},.2);`,
});

// 6 — the board, drawn. Cards fly into their columns carrying their agent.
S.board = (s) => {
  const cols = ["working", "needs you", "in review", "ready"];
  const cards = [
    [0, "Add --json to `loom agents`", "codex"],
    [0, "Port MCP to the phone app", "opencode"],
    [1, "Cap spend per project?", "claude-code"],
    [2, "Review the agy spawn fix", "opencode"],
    [3, "Wire agy models in", "codex"],
  ];
  const x = (c) => 150 + c * 420;
  const rows = {};
  return {
    body: `<div ${clip(s)}1" style="inset:0">
      <div class="col" style="position:absolute;left:0;top:130px;width:1920px;text-align:center">the fleet's work</div>
      ${cols.map((c, i) => `<div class="col" id="bd-h${i}" style="position:absolute;left:${x(i)}px;top:250px;width:380px">${c}</div>
        <div style="position:absolute;left:${x(i)}px;top:284px;width:380px;height:1px;background:${LINE}"></div>`).join("")}
      ${cards.map((cd, i) => { const c = cd[0]; rows[c] = (rows[c] || 0) + 1;
        return `<div class="tcard" id="bd-c${i}" style="position:absolute;left:${x(c)}px;top:${318 + (rows[c] - 1) * 92}px;width:380px">
          <img src="${L(cd[2])}"><span>${cd[1]}</span></div>`; }).join("")}
    </div>`,
    js: `gsap.set('[id^=bd-h]',{opacity:0,y:-14});gsap.set('[id^=bd-c]',{opacity:0,y:34,scale:.94});
tl.to('[id^=bd-h]',{opacity:1,y:0,duration:.28,stagger:.08,ease:"back.out(2)"},.15)
  .to('[id^=bd-c]',{opacity:1,y:0,scale:1,duration:.34,stagger:.26,ease:"back.out(2.2)"},.6);`,
  };
};

// 7 — roles, drawn as an assignment rather than a screenshot of a dropdown.
S.roles = (s) => {
  const r = [["claude-code", "planner"], ["codex", "builder"], ["opencode", "reviewer"]];
  return {
    body: `<div ${clip(s)}1" style="inset:0">
      <div class="col" style="position:absolute;left:0;top:210px;width:1920px;text-align:center">you decide who does what</div>
      ${r.map((a, i) => `<img class="lg" id="rl-l${i}" src="${L(a[0])}" style="position:absolute;left:${400 + i * 400}px;top:360px">
        <div class="m" style="position:absolute;left:${330 + i * 400}px;top:500px;width:260px;text-align:center;font-size:21px;color:${DIM}">${a[0]}</div>
`).join("")}
      ${r.map((a, i) => `<div class="chip" id="rl-c${i}" style="position:absolute;left:${390 + i * 400}px;top:566px;color:${O};border-color:${O}">${a[1]}</div>`).join("")}
    </div>`,
    js: `gsap.set('[id^=rl-l]',{opacity:0,scale:.86});gsap.set('[id^=rl-c]',{opacity:0,y:18});
tl.to('[id^=rl-l]',{opacity:1,scale:1,duration:.3,stagger:.14,ease:"back.out(2.4)"},.15)
  .to('[id^=rl-c]',{opacity:1,y:0,duration:.3,stagger:.22,ease:"back.out(2.4)"},.8);`,
  };
};

// 8 — the brain. Four agents' marks around the edge, their memory units flying
// into one store in the middle. This is the thesis, animated.
S.brain = (s) => {
  const u = [
    ["codex", "FACT", "the baton guarantees one writer at a time", 250],
    ["antigravity", "DECISION", "/healthz returns a JSON status object", 420],
    ["opencode", "DECISION", "config lives in JSON, not env vars", 590],
    ["claude-code", "FAILURE", "daemons go stale — detect via BUILD_REV", 760],
  ];
  return {
    body: `<div ${clip(s)}1" style="inset:0">
      <div class="col" style="position:absolute;left:0;top:110px;width:1920px;text-align:center">one shared brain</div>
      <div class="card" id="br-box" style="position:absolute;left:560px;top:200px;width:800px;height:660px"></div>
      ${u.map((x, i) => `<div class="unit" id="br-u${i}" style="position:absolute;left:600px;top:${x[3]}px;max-width:720px">
        <img src="${L(x[0])}"><span class="kind">${x[1]}</span><span>${x[2]}</span></div>`).join("")}
      <div class="m" id="br-n" style="position:absolute;left:0;top:890px;width:1920px;text-align:center;font-size:30px;color:${O};opacity:0">
        four agents wrote it &middot; all of them can read it</div>
    </div>`,
    js: `gsap.set('#br-box',{opacity:0,scale:.96});gsap.set('[id^=br-u]',{opacity:0,x:-420,scale:.9});
tl.to('#br-box',{opacity:1,scale:1,duration:.4,ease:"back.out(1.8)"},.1)
${u.map((_, i) => `  .to('#br-u${i}',{opacity:1,x:0,scale:1,duration:.5,ease:"back.out(1.9)"},${(0.7 + i * 1.5).toFixed(2)})`).join("\n")}
  .to('#br-n',{opacity:1,duration:.4,ease:"back.out(1.6)"},${(0.7 + u.length * 1.5 + 0.4).toFixed(2)});`,
  };
};

S.close = (s) => ({
  body: `<div ${clip(s)}1" style="inset:0">
    <div class="ttl" id="z-w" style="position:absolute;left:0;top:330px;width:1920px;text-align:center;font-size:165px;letter-spacing:-.05em">LOOM</div>
    <div id="z-s" style="position:absolute;left:0;top:520px;width:1920px;text-align:center;font-size:35px;color:${DIM}">one brain, every agent</div>
    <div id="z-r" style="position:absolute;left:865px;top:600px;width:0;height:2px;background:${LINE}"></div>
    <div class="m" id="z-i" style="position:absolute;left:0;top:650px;width:1920px;text-align:center;font-size:30px;color:${O}">npm i -g @loompad/cli</div>
    <div class="m" id="z-g" style="position:absolute;left:0;top:706px;width:1920px;text-align:center;font-size:20px;color:#5a5a63">github.com/nickthelegend/loom</div>
  </div>`,
  js: `gsap.set('#z-w',{opacity:0,scale:.93});gsap.set(['#z-s','#z-i','#z-g'],{opacity:0,y:14});
tl.to('#z-w',{opacity:1,scale:1,duration:.42,ease:"back.out(2)"},0)
  .to('#z-s',{opacity:1,y:0,duration:.3},.35)
  .to('#z-r',{width:190,duration:.3},.5)
  .to(['#z-i','#z-g'],{opacity:1,y:0,duration:.32,stagger:.12},.65);`,
});

let total = 0; const M = [];
for (const [id, secs, vo] of SCENES) {
  const cid = "x-" + id;
  const { body, js } = S[id](secs);
  fs.writeFileSync(path.join(FR, `${id}.html`), `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
${head(cid)}</head><body>
<div id="${cid}" data-composition-id="${cid}" data-width="1920" data-height="1080" data-start="0" data-duration="${secs}">
<div class="clip bg" id="${cid}-bg" data-start="0" data-duration="${secs}" data-track-index="0"></div>
${body}
</div>
${tlw(cid, js)}</body></html>`);
  M.push({ id, secs, vo, at: total }); total += secs;
}

fs.writeFileSync(path.join(DIR, "index-60.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Loom 60</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<style>html,body{margin:0;background:#0A0A0B}#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#0A0A0B}
#root .clip{position:absolute}</style></head><body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${total.toFixed(2)}">
${M.map((m) => `  <div class="clip" id="mt-${m.id}" data-composition-id="x-${m.id}" data-composition-src="compositions/p60/${m.id}.html"
   data-start="${m.at.toFixed(2)}" data-duration="${m.secs}" data-track-index="1" style="inset:0;width:100%;height:100%"></div>`).join("\n")}
${M.filter((m) => m.vo).map((m) => `  <audio class="clip" id="vo-${m.vo}" src="assets/vo60/${m.vo}.wav"
   data-start="${(m.at + 0.2).toFixed(2)}" data-duration="${(m.secs - 0.2).toFixed(2)}" data-track-index="20"></audio>`).join("\n")}
</div>
<script>window.__timelines=window.__timelines||{};window.__timelines["root"]=gsap.timeline({paused:true});<\/script>
</body></html>`);

const b = M.find((m) => m.id === "build"), p = M.find((m) => m.id === "padwork");
console.log(`${M.length} scenes · ${total.toFixed(2)}s`);
console.log(`build window ${b.at.toFixed(2)}-${(b.at + b.secs).toFixed(2)}  pad window ${p.at.toFixed(2)}-${(p.at + p.secs).toFixed(2)}`);
