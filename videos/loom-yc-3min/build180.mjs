/**
 * The cut that keeps what worked from each attempt.
 *
 *  - the animated open from the first video.mp4: context typing into two walled
 *    panes, the wall lighting up, the wordmark landing. Built, not photographed.
 *  - the 2:05 cut's body: the REAL app, travelled across and called out, because
 *    a capture of the board beats a drawing of the board.
 *  - the pad section left long instead of trimmed to a token five seconds.
 *
 * Camera motion is the through-line — every real frame is entered on a move, so
 * nothing sits still long enough to feel like a slideshow.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const D = path.dirname(fileURLToPath(import.meta.url));
const FR = path.join(D, "compositions", "d3");
fs.mkdirSync(FR, { recursive: true });

// ---------------------------------------------------------------------------
// Caption timing is derived from the audio, never from the scene length.
//
// The old build split each scene's captions evenly across the *visual*
// duration. uichat ran 18.4s of picture over 8.1s of voice, so the third
// caption appeared ten seconds after it was spoken. Two sources of truth now:
// scenes listed in lines/durations.json have one wav per caption and each
// caption is pinned to its own wav; the rest keep their single wav and get
// split across its measured length, weighted by how much text each line is.
// ---------------------------------------------------------------------------
const LINEDUR = (() => {
  const f = path.join(D, "assets", "vo180", "lines", "durations.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
})();
const secsOf = (p) => {
  try {
    return Number(execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
      { encoding: "utf8" }).trim());
  } catch { return 0; }
};

const LEAD = 0.35, TAIL = 0.5, VO_OFFSET = 0.15;

/** [start, end] on the scene's own clock for every caption. */
function windows(id, secs, lines, vo) {
  if (!lines.length) return [];
  const per = LINEDUR[id];
  if (per) {
    const speech = per.reduce((a, b) => a + b, 0);
    const gap = lines.length > 1
      ? Math.max(0.12, (secs - LEAD - TAIL - speech) / (lines.length - 1)) : 0;
    let t = LEAD;
    return per.map((d) => { const w = [t, t + d]; t += d + gap; return w; });
  }
  // one wav for the whole scene — split it by character count, which tracks
  // speaking time far better than an equal split does
  const wav = vo ? secsOf(path.join(D, "assets", "vo180", `${vo}.wav`)) : 0;
  const span = wav > 0.2 ? wav : secs - VO_OFFSET;
  const chars = lines.map((l) => l.length);
  const total = chars.reduce((a, b) => a + b, 0);
  let t = VO_OFFSET;
  return chars.map((c) => { const d = span * c / total; const w = [t, t + d]; t += d; return w; });
}

const O = "#FF6B2B", DIM = "#A1A1AA", G = "#0A0A0B", LINE = "#26262B";
const FONT = "Space_Grotesk_Variable.woff2";
const SH = (n) => `assets/shots/${n}.png`;
const LG = (k) => `assets/logos/logo-${k}.png`;

// id, secs, vo(vo12x), subtitle lines
const SC = [
  ["pain", 7.8, "01", ["Every coding agent keeps its own memory.", "Claude Code can't read what Codex knows.", "Switch tools, and you start over."]],
  ["claim", 3.2, "02", ["Loom makes them one brain."]],
  // these four are voiced line-by-line — the captions below must stay word for
  // word identical to tts-lines.mjs, or the text drifts from the audio again
  ["uichat", 18.4, null, ["One thread, and every agent you own is in it.",
    "The switcher lists all of them. Claude Code, Codex, OpenCode, Grok, Antigravity.",
    "Loom asks each CLI what models it can actually run, so the list is never stale.",
    "Skills and MCP servers sit right there in the composer.",
    "Pick an agent, send the task, and it goes."]],
  ["uiboard", 10.4, null, ["Work lives on a board.",
    "Every card carries the agent that owns it.",
    "Create a task, hand it to an agent, and watch it move across."]],
  ["uibrain", 12.3, null, ["This is the brain. Everything the project has learned.",
    "Decisions, conventions, constraints, failures.",
    "Codex wrote that one. Antigravity wrote that one.",
    "Four agents, one memory, all of them reading it."]],
  ["mobile", 15.0, null, ["The same brain is on your phone.",
    "The full thread, live, wherever you are.",
    "The board and the brain, in your pocket.",
    "Approve a plan, or start a route, from anywhere.",
    "Your fleet does not stop when you leave the desk."]],
  ["buildpad", 18.1, "09", ["And we built it a body.", "Printed, wired, assembled.", "One key per agent."]],
  ["pad", 52.0, null, []],
  ["circuits", 15.1, "13", ["The whole project is open source.", "Enclosure, wiring, the full schematic.", "Print one, wire it, and it is yours."]],
  ["landing", 9.0, "14", ["One device that speaks to every agent you use.", "Buy one soon, or build one yourself."]],
  ["close", 6.2, null, ["Loom. One brain, every agent.", "Open source, MIT. Build one yourself."]],
];

const head = (id) => `<style>
@font-face{font-family:"SG";src:url("assets/${FONT}") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"LoomMono";src:local("Menlo"),local("SF Mono"),local("Monaco");font-display:block}
#${id}{position:absolute;inset:0;overflow:hidden;background:${G};font-family:"SG",system-ui,sans-serif;color:#FAFAFA}
#${id} .clip{position:absolute}
#${id} .bg{inset:0;width:100%;height:100%;background:${G}}
#${id} .sh{inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
#${id} .m{font-family:"LoomMono",monospace}
#${id} .lg{width:120px;height:120px;object-fit:contain}
#${id} .card{border:1px solid ${LINE};border-radius:14px;background:#0e0e11}
#${id} .call{border:2.5px solid ${O};border-radius:9px;box-shadow:0 0 0 9999px rgba(10,10,11,.5)}
#${id} .tag{background:${O};color:${G};font-weight:700;font-size:21px;letter-spacing:.05em;padding:8px 14px;border-radius:6px;white-space:nowrap}
#${id} .sub{left:0;right:0;bottom:58px;text-align:center;font-size:36px;font-weight:600}
#${id} .sub span{background:rgba(10,10,11,.9);padding:10px 25px;border-radius:9px;
  box-decoration-break:clone;-webkit-box-decoration-break:clone;line-height:1.8}
#${id} .ttl{font-size:185px;font-weight:700;letter-spacing:-.05em;text-align:center;left:0;right:0}
</style>`;

const W = (id, js) => `<script>(function(){window.__timelines=window.__timelines||{};
var tl=gsap.timeline({paused:true});window.__timelines[${JSON.stringify(id)}]=tl;
${js}})();</script>`;

function subs(lines, s, t0, wins) {
  if (!lines.length) return { h: "", j: "" };
  return {
    h: lines.map((t, i) => `<div class="clip sub" id="sb${i}" data-start="0" data-duration="${s}" data-track-index="${t0 + i}"><span>${t}</span></div>`).join("\n"),
    j: lines.map((t, i) => {
      // Up a hair early, and held until the next line rather than dropped the
      // instant the words stop — a caption blinking off during a pause reads as
      // a glitch. Capped at three seconds so a long silent tail (the build
      // montage, the schematic) doesn't leave one line parked on screen.
      const a = +Math.max(0, wins[i][0] - .12).toFixed(2);
      const next = i + 1 < wins.length ? wins[i + 1][0] - .1 : s - .15;
      const b = +Math.min(next, wins[i][1] + 3.0, s - .1).toFixed(2);
      return `gsap.set('#sb${i}',{opacity:0,y:14});tl.to('#sb${i}',{opacity:1,y:0,duration:.18,ease:"power2.out"},${a});tl.to('#sb${i}',{opacity:0,duration:.14},${b});`;
    }).join("\n"),
  };
}

/** Enter every real frame on a move — the anti-slideshow rule. */
const cam = (sel, s, a, b) =>
  // held, not travelled — the zooming-around-a-screenshot look is gone
  `gsap.set(${sel},{scale:${a.k},xPercent:${a.x},yPercent:${a.y}});`;
const pop = (sel, at, hold) =>
  `gsap.set(${sel},{opacity:0,scale:.93});tl.to(${sel},{opacity:1,scale:1,duration:.3,ease:"back.out(2.6)"},${at});` +
  `tl.to(${sel},{opacity:0,duration:.24},${at + hold});`;

const S = {};

// the animated open, kept from the first cut
S.pain = (s) => ({
  b: `<div class="clip" id="pw" data-start="0" data-duration="${s}" data-track-index="1" style="inset:0">
    <div class="card" style="position:absolute;left:150px;top:230px;width:640px;height:420px"></div>
    <img class="lg" id="l1" src="${LG("claude-code")}" style="position:absolute;left:410px;top:282px">
    <div class="m" id="n1" style="position:absolute;left:150px;top:432px;width:640px;text-align:center;font-size:23px;color:${DIM}">claude-code</div>
    <div class="m" id="w1" style="position:absolute;left:194px;top:478px;width:552px;font-size:13.5px;color:#4d4d55;line-height:1.85;overflow:hidden;height:0">&gt; pnpm monorepo, node 20 — four packages, one app.<br>packages/daemon owns every websocket, binds 7420.<br>apps/web is next 15 on the app router.<br>packages/core holds the domain types.<br>tests live beside the file they cover.</div>
    <div class="card" style="position:absolute;left:1130px;top:230px;width:640px;height:420px"></div>
    <img class="lg" id="l2" src="${LG("codex")}" style="position:absolute;left:1390px;top:282px">
    <div class="m" id="n2" style="position:absolute;left:1130px;top:432px;width:640px;text-align:center;font-size:23px;color:${DIM}">codex</div>
    <div class="m" id="w2" style="position:absolute;left:1174px;top:478px;width:552px;font-size:13.5px;color:#4d4d55;line-height:1.85;overflow:hidden;height:0">&gt; pnpm monorepo, node 20 — four packages, one app.<br>packages/daemon owns every websocket, binds 7420.<br>apps/web is next 15 on the app router.<br>packages/core holds the domain types.<br>tests live beside the file they cover.</div>
    <div id="wl" style="position:absolute;left:958px;top:230px;width:4px;height:420px;background:${O};opacity:0"></div>
    <div class="m" id="xx" style="position:absolute;left:810px;top:672px;width:300px;text-align:center;font-size:18px;color:${O};letter-spacing:.16em;opacity:0">NO SHARED MEMORY</div>
  </div>`,
  j: `gsap.set(['#l1','#n1'],{opacity:0,y:18});gsap.set(['#l2','#n2'],{opacity:0,y:18});gsap.set('#pw',{scale:1.06});
tl.to('#pw',{scale:1,duration:${s},ease:"power1.out"},0)
 .to(['#l1','#n1'],{opacity:1,y:0,duration:.32,ease:"back.out(2.4)"},.2)
 .to('#w1',{height:132,duration:1.5,ease:"none"},.55)
 .to(['#l2','#n2'],{opacity:1,y:0,duration:.32,ease:"back.out(2.4)"},3.2)
 .to('#w2',{height:132,duration:1.5,ease:"none"},3.5)
 .to('#wl',{opacity:1,duration:.2},6.1).to('#xx',{opacity:1,duration:.24},6.25);`,
});
S.claim = (s) => ({
  b: `<div class="clip ttl" id="cw" data-start="0" data-duration="${s}" data-track-index="1" style="top:392px">LOOM</div>
  <div class="clip" id="cr" data-start="0" data-duration="${s}" data-track-index="2" style="left:860px;top:618px;width:0;height:4px;background:${O}"></div>
  <div class="clip m" id="ct" data-start="0" data-duration="${s}" data-track-index="3" style="left:0;right:0;top:656px;text-align:center;font-size:27px;color:${DIM}">the shared-memory layer for AI coding agents</div>`,
  j: `gsap.set('#cw',{opacity:0,scale:.88});gsap.set('#ct',{opacity:0});
tl.to('#cw',{opacity:1,scale:1,duration:.45,ease:"back.out(2.2)"},0).to('#cr',{width:200,duration:.3},.42).to('#ct',{opacity:1,duration:.3},.6);`,
});

// real captures, entered on a move, called out where it matters
const real = (file, s, a, b, tag, calls = []) => (sec) => ({
  b: `<img class="clip sh" id="im" src="${SH(file)}" data-start="0" data-duration="${sec}" data-track-index="1">
   <div class="clip tag" id="tg" style="left:5%;top:6.5%" data-start="0" data-duration="${sec}" data-track-index="3">${tag}</div>
   ${calls.map((c, i) => `<div class="clip call" id="cl${i}" style="left:${c.l};top:${c.t};width:${c.w};height:${c.h}" data-start="0" data-duration="${sec}" data-track-index="${10 + i}"></div>`).join("\n")}`,
  j: cam("'#im'", sec, a, b) +
    `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.26,ease:"back.out(3)"},.2);` +
    calls.map((c, i) => pop(`'#cl${i}'`, c.at, c.hold)).join(""),
});

S.models = real("00-model-picker", 0, { k: 1.5, x: -8, y: 6 }, { k: 1.36, x: -6, y: 8 }, "REAL MODELS, ASKED OF THE CLI");
S.taskmove = real("03-board-after", 0, { k: 1.34, x: 4, y: 2 }, { k: 1.24, x: -4, y: 2 }, "THE TASK MOVED ITSELF");
;
S.landing = real("08-landing-top", 0, { k: 1.16, x: 0, y: -4 }, { k: 1.06, x: 0, y: 2 }, "loompad.tech");
S.micro = (s) => ({
  b: `<div class="clip" id="mw" data-start="0" data-duration="${s}" data-track-index="1" style="left:0;right:0;top:400px;text-align:center;font-size:86px;font-weight:700;letter-spacing:-.03em">a Codex Micro<br><span style="color:${O}">for every agent</span></div>`,
  j: `gsap.set('#mw',{opacity:0,scale:.9});tl.to('#mw',{opacity:1,scale:1,duration:.45,ease:"back.out(2.2)"},0);`,
});
S.mobile = (s) => {
  const f = ["mob-thread", "mob-brain", "mob-routes"];
  const lb = ["the thread", "the brain", "routes"];
  const per = s / f.length;
  return {
    b: f.map((n, i) => '<img class="clip" id="mo' + i + '" src="' + SH(n) + '" style="left:50%;top:50%;width:432px;height:936px;margin:-468px 0 0 -216px;object-fit:contain;border-radius:22px;transform-origin:50% 50%" data-start="0" data-duration="' + s + '" data-track-index="' + (1 + i) + '">').join("\n") +
       f.map((_, i) => '<div class="clip tag" id="mt' + i + '" style="left:5%;top:6.5%" data-start="0" data-duration="' + s + '" data-track-index="' + (8 + i) + '">ON YOUR PHONE &middot; ' + lb[i] + '</div>').join("\n"),
    j: f.map((_, i) => {
      const a = (i * per).toFixed(2), bb = ((i + 1) * per - 0.3).toFixed(2);
      return "gsap.set('#mo" + i + "',{opacity:" + (i ? 0 : 1) + ",scale:1.05});" +
        (i ? "tl.to('#mo" + i + "',{opacity:1,duration:.3}," + a + ");" : "") +
        "tl.to('#mo" + i + "',{scale:1.12,duration:" + per.toFixed(2) + ",ease:'power1.inOut'}," + a + ");" +
        "gsap.set('#mt" + i + "',{opacity:0,scale:.94});" +
        "tl.to('#mt" + i + "',{opacity:1,scale:1,duration:.26,ease:'back.out(3)'}," + (+a + 0.25).toFixed(2) + ");" +
        "tl.to('#mt" + i + "',{opacity:0,duration:.22}," + bb + ");";
    }).join("\n"),
  };
};
S.uichat = (s) => ({
  b: '<div class="clip bg" id="ucb" data-start="0" data-duration="' + s + '" data-track-index="1"></div>' +
     '<div class="clip tag" id="uct" style="left:5%;top:6.5%" data-start="0" data-duration="' + s + '" data-track-index="3">THE CHAT &mdash; ONE THREAD, EVERY AGENT</div>',
  j: "gsap.set('#uct',{opacity:0,scale:.94});tl.to('#uct',{opacity:1,scale:1,duration:.26,ease:'back.out(3)'},.3);" +
     "tl.to('#uct',{opacity:0,duration:.3}," + (s - 1.0).toFixed(2) + ");",
});
S.uiboard = (s) => ({
  b: '<div class="clip bg" id="ubb" data-start="0" data-duration="' + s + '" data-track-index="1"></div>' +
     '<div class="clip tag" id="ubt" style="left:5%;top:6.5%" data-start="0" data-duration="' + s + '" data-track-index="3">THE BOARD &mdash; CREATING A TASK</div>',
  j: "gsap.set('#ubt',{opacity:0,scale:.94});tl.to('#ubt',{opacity:1,scale:1,duration:.26,ease:'back.out(3)'},.3);" +
     "tl.to('#ubt',{opacity:0,duration:.3}," + (s - 1.0).toFixed(2) + ");",
});
S.uibrain = (s) => ({
  b: '<div class="clip bg" id="unb" data-start="0" data-duration="' + s + '" data-track-index="1"></div>' +
     '<div class="clip tag" id="unt" style="left:5%;top:6.5%" data-start="0" data-duration="' + s + '" data-track-index="3">THE BRAIN &mdash; SHARED MEMORY</div>',
  j: "gsap.set('#unt',{opacity:0,scale:.94});tl.to('#unt',{opacity:1,scale:1,duration:.26,ease:'back.out(3)'},.3);" +
     "tl.to('#unt',{opacity:0,duration:.3}," + (s - 1.0).toFixed(2) + ");",
});
S.buildpad = (s) => ({
  b: '<div class="clip bg" id="bpb" data-start="0" data-duration="' + s + '" data-track-index="1"></div>' +
     '<div class="clip tag" id="bpt" style="left:5%;top:6.5%" data-start="0" data-duration="' + s + '" data-track-index="3">BUILDING THE LOOMPAD</div>',
  j: "gsap.set('#bpt',{opacity:0,scale:.94});tl.to('#bpt',{opacity:1,scale:1,duration:.26,ease:'back.out(3)'},.3);" +
     "tl.to('#bpt',{opacity:0,duration:.3}," + (s - 1.0).toFixed(2) + ");",
});
S.circuits = (s) => ({
  b: `<div class="clip bg" id="cb" data-start="0" data-duration="${s}" data-track-index="1"></div>
   <div class="clip tag" id="tg" style="left:5%;top:6.5%" data-start="0" data-duration="${s}" data-track-index="3">OPEN SOURCE &mdash; SCHEMATIC, WIRING, CAD</div>`,
  j: `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.26,ease:"back.out(3)"},.3);tl.to('#tg',{opacity:0,duration:.3},7.5);`,
});
S.prompt = real("001-prompt-typed", 0, { k: 1.72, x: 3, y: 20 }, { k: 1.5, x: 2, y: 19 }, "THE REAL APP");
S.board = real("017-board-kanban", 0, { k: 1.34, x: 8, y: 2 }, { k: 1.24, x: -6, y: 2 }, "THE BOARD");
S.roles = real("018-roles-per-ade", 0, { k: 1.46, x: 0, y: -3 }, { k: 1.36, x: -1, y: 5 }, "ROLES PER AGENT");
S.brain = real("019-brain", 0, { k: 1.32, x: 1, y: -14 }, { k: 1.2, x: 0, y: 11 }, "THE BRAIN");

// the real streaming turn, played as the captures it was
S.stream = (s) => {
  const f = Array.from({ length: 14 }, (_, i) => `00${i + 3}`.slice(-3) + "-generating-" + `0${i}`.slice(-2));
  const per = s / f.length;
  return {
    b: f.map((n, i) => `<img class="clip sh" id="f${i}" src="${SH(n)}" data-start="0" data-duration="${s}" data-track-index="${1 + i}">`).join("\n") +
      `<div class="clip tag" id="tg" style="left:5%;top:6.5%" data-start="0" data-duration="${s}" data-track-index="30">CODEX &mdash; WORKING, LIVE</div>`,
    j: f.map((_, i) => `gsap.set('#f${i}',{opacity:${i ? 0 : 1},scale:1.3,xPercent:2,yPercent:5});` + (i ? `tl.set('#f${i}',{opacity:1},${(i * per).toFixed(2)});` : "")).join("\n") +
      f.map((_, i) => `tl.to('#f${i}',{scale:1.16,duration:${s},ease:"none"},0);`).join("") +
      `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.26,ease:"back.out(3)"},.2);`,
  };
};

// the fleet, marks landing on a stagger
S.fleet = (s) => {
  const a = [["claude-code", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["grok-code", "Grok"], ["antigravity", "Antigravity"]];
  return {
    b: `<div class="clip m" id="fk" data-start="0" data-duration="${s}" data-track-index="1" style="left:0;right:0;top:300px;text-align:center;font-size:17px;letter-spacing:.2em;color:${DIM};text-transform:uppercase">agents that can take a turn</div>` +
      a.map((x, i) => `<img class="clip lg" id="fl${i}" src="${LG(x[0])}" data-start="0" data-duration="${s}" data-track-index="${2 + i}" style="left:${300 + i * 280}px;top:430px">
      <div class="clip" id="fn${i}" data-start="0" data-duration="${s}" data-track-index="${9 + i}" style="left:${240 + i * 280}px;top:580px;width:240px;text-align:center;font-size:21px;font-weight:500">${x[1]}</div>`).join("\n"),
    j: `gsap.set('[id^=fl]',{opacity:0,y:26,scale:.8});gsap.set('[id^=fn]',{opacity:0,y:14});gsap.set('#fk',{opacity:0});
tl.to('#fk',{opacity:1,duration:.3},.1)
 .to('[id^=fl]',{opacity:1,y:0,scale:1,duration:.4,stagger:.16,ease:"back.out(2.8)"},.5)
 .to('[id^=fn]',{opacity:1,y:0,duration:.28,stagger:.16},.72);`,
  };
};

S.pad = (s) => ({
  b: `<div class="clip bg" id="pb" data-start="0" data-duration="${s}" data-track-index="1"></div>
   <div class="clip tag" id="tg" style="left:5%;top:6.5%" data-start="0" data-duration="${s}" data-track-index="3">THE LOOMPAD &mdash; REAL HARDWARE</div>`,
  j: `gsap.set('#tg',{opacity:0,scale:.94});tl.to('#tg',{opacity:1,scale:1,duration:.26,ease:"back.out(3)"},.3);tl.to('#tg',{opacity:0,duration:.3},6.5);`,
});

S.close = (s) => ({
  b: `<div class="clip ttl" id="zw" data-start="0" data-duration="${s}" data-track-index="1" style="top:322px;font-size:160px">LOOM</div>
   <div class="clip" id="zs" data-start="0" data-duration="${s}" data-track-index="2" style="left:0;right:0;top:512px;text-align:center;font-size:35px;color:${DIM}">one brain, every agent</div>
   <div class="clip m" id="zi" data-start="0" data-duration="${s}" data-track-index="3" style="left:0;right:0;top:612px;text-align:center;font-size:30px;color:${O}">npm i -g @loompad/cli</div>
   <div class="clip m" id="zg" data-start="0" data-duration="${s}" data-track-index="4" style="left:0;right:0;top:668px;text-align:center;font-size:20px;color:#5a5a63">github.com/nickthelegend/loom</div>`,
  j: `gsap.set('#zw',{opacity:0,scale:.9});gsap.set(['#zs','#zi','#zg'],{opacity:0,y:14});
tl.to('#zw',{opacity:1,scale:1,duration:.42,ease:"back.out(2.2)"},0).to(['#zs','#zi','#zg'],{opacity:1,y:0,duration:.3,stagger:.11},.36)
.fromTo('#zo',{opacity:0,y:16},{opacity:1,y:0,duration:.4,ease:"back.out(2)"},1.1);`,
});

let T = 0; const M = [];
const WIN = {};
for (const [id, secs, vo, lines] of SC) {
  const cid = "d-" + id;
  const { b, j } = S[id](secs);
  WIN[id] = windows(id, secs, lines, vo);
  const sb = subs(lines, secs, 40, WIN[id]);
  fs.writeFileSync(path.join(FR, `${id}.html`), `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
${head(cid)}</head><body>
<div id="${cid}" data-composition-id="${cid}" data-width="1920" data-height="1080" data-start="0" data-duration="${secs}">
<div class="clip bg" id="${cid}-bg" data-start="0" data-duration="${secs}" data-track-index="0"></div>
${b}
${sb.h}
</div>
${W(cid, j + "\n" + sb.j)}</body></html>`);
  M.push({ id, secs, vo, at: T }); T += secs;
}

/** Every audio tag on the root timeline: one per scene, or one per caption. */
const audioTags = M.flatMap((m) => {
  const per = LINEDUR[m.id];
  if (per) {
    return per.map((d, i) => `  <audio class="clip" id="vl-${m.id}-${i}" src="assets/vo180/lines/${m.id}-${i}.wav"
   data-start="${(m.at + WIN[m.id][i][0]).toFixed(2)}" data-duration="${(d + .05).toFixed(2)}" data-track-index="${20 + i}"></audio>`);
  }
  if (!m.vo) return [];
  return [`  <audio class="clip" id="vo-${m.vo}" src="assets/vo180/${m.vo}.wav"
   data-start="${(m.at + VO_OFFSET).toFixed(2)}" data-duration="${(m.secs - VO_OFFSET).toFixed(2)}" data-track-index="20"></audio>`];
}).join("\n");

fs.writeFileSync(path.join(D, "index-d3.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Loom</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<style>html,body{margin:0;background:#0A0A0B}#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#0A0A0B}
#root .clip{position:absolute}</style></head><body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${T.toFixed(2)}">
${M.map((m) => `  <div class="clip" id="mt-${m.id}" data-composition-id="d-${m.id}" data-composition-src="compositions/d3/${m.id}.html"
   data-start="${m.at.toFixed(2)}" data-duration="${m.secs}" data-track-index="1" style="inset:0;width:100%;height:100%"></div>`).join("\n")}
${audioTags}
</div>
<script>window.__timelines=window.__timelines||{};window.__timelines["root"]=gsap.timeline({paused:true});<\/script>
</body></html>`);


const SD = path.join(D, "compositions", "subs");
fs.mkdirSync(SD, { recursive: true });
for (const m of M) {
  const scene = SC.find((x) => x[0] === m.id);
  const sb = subs(scene[3] || [], m.secs, 40, WIN[m.id]);
  fs.writeFileSync(path.join(SD, m.id + ".html"), `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<style>
@font-face{font-family:"SG";src:url("assets/${FONT}") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"LoomMono";src:local("Menlo"),local("SF Mono"),local("Monaco");font-display:block}
#k-${m.id}{position:absolute;inset:0;overflow:hidden;background:#00FF00;font-family:"SG",system-ui,sans-serif;color:#FAFAFA}
#k-${m.id} .clip{position:absolute}
#k-${m.id} .sub{left:0;right:0;bottom:58px;text-align:center;font-size:36px;font-weight:600}
/* Opaque, unlike the base pass. A translucent plate lets the key colour through
   it, and 8% of pure green over near-black is a visibly green caption box. */
#k-${m.id} .sub span{background:#0A0A0B;padding:10px 25px;border-radius:9px;
  box-decoration-break:clone;-webkit-box-decoration-break:clone;line-height:1.8}
#k-${m.id} .tag{background:#FF6B2B;color:#0A0A0B;font-weight:700;font-size:21px;letter-spacing:.05em;padding:8px 14px;border-radius:6px;white-space:nowrap}
</style></head><body>
<div id="k-${m.id}" data-composition-id="k-${m.id}" data-width="1920" data-height="1080" data-start="0" data-duration="${m.secs}">
${sb.h}
</div>
<script>(function(){window.__timelines=window.__timelines||{};var tl=gsap.timeline({paused:true});
window.__timelines["k-${m.id}"]=tl;
${sb.j}})();<\/script></body></html>`);
}
fs.writeFileSync(path.join(D, "index-subs.html"), `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<style>html,body{margin:0;background:#00FF00}
#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#00FF00}
#root .clip{position:absolute}</style></head><body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${T.toFixed(2)}">
${M.map((m) => `  <div class="clip" id="ks-${m.id}" data-composition-id="k-${m.id}" data-composition-src="compositions/subs/${m.id}.html"
   data-start="${m.at.toFixed(2)}" data-duration="${m.secs}" data-track-index="1" style="inset:0;width:100%;height:100%"></div>`).join("\n")}
</div>
<script>window.__timelines=window.__timelines||{};window.__timelines["root"]=gsap.timeline({paused:true});<\/script>
</body></html>`);

const p = M.find((m) => m.id === "pad");
console.log(`${M.length} scenes · ${T.toFixed(2)}s (${Math.floor(T / 60)}:${String(Math.round(T % 60)).padStart(2, "0")})`);
console.log(`PAD ${p.at.toFixed(2)} ${(p.at + p.secs).toFixed(2)}`);
