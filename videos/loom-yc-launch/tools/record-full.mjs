/**
 * A patient recording of the real UI.
 *
 * The first pass used fixed sleeps and moved on before menus had populated, so
 * half the shots were of things still loading. Every step here waits on a
 * predicate — the menu has rows, the board has cards, the brain has units —
 * and only then acts. Nothing is hurried; the point is that a viewer can read
 * what happened.
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Users/jaibajrang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PAIR = process.argv[2], OUT = process.argv[3], PORT = 9399;
const W = 1920, H = 1080, FPS = 15;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless=new", "--hide-scrollbars",
  `--window-size=${W},${H}`, "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/loom-full-profile", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

let ws, id = 0, sid; const pend = new Map();
const S = (m, p = {}, s) => new Promise((res, rej) => { const k = ++id; pend.set(k, { res, rej });
  ws.send(JSON.stringify(s ? { id: k, method: m, params: p, sessionId: s } : { id: k, method: m, params: p })); });
const E = async (e) => { const r = await S("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };

let frame = 0, recording = false;
async function pump() {
  while (recording) {
    const t0 = Date.now();
    try {
      const r = await S("Page.captureScreenshot", { format: "jpeg", quality: 80 }, sid);
      fs.writeFileSync(path.join(OUT, `f${String(frame++).padStart(5, "0")}.jpg`), Buffer.from(r.data, "base64"));
    } catch {}
    await sleep(Math.max(0, 1000 / FPS - (Date.now() - t0)));
  }
}

/** Wait until the page says it is ready, up to `secs`. Returns whether it was. */
async function waitFor(expr, secs = 20, label = "") {
  for (let i = 0; i < secs * 2; i++) {
    try { if (await E(`!!(${expr})`)) { await sleep(700); return true; } } catch {}
    await sleep(500);
  }
  console.log("    ! timed out waiting:", label || expr);
  return false;
}

const CURSOR = `(() => {
  if (document.getElementById('__cur')) return;
  const c = document.createElement('div'); c.id = '__cur';
  c.style.cssText='position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-3px);will-change:transform';
  c.innerHTML='<svg viewBox="0 0 26 26" style="filter:drop-shadow(0 2px 6px rgba(0,0,0,.85))"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.8 21.4 L11.4 14.2 L18 14 Z" fill="#fff" stroke="#0A0A0B" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const r=document.createElement('div'); r.id='__ring';
  r.style.cssText='position:fixed;left:0;top:0;width:52px;height:52px;margin:-26px 0 0 -26px;border:3px solid #FF6B2B;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0;will-change:transform,opacity';
  document.body.appendChild(c); document.body.appendChild(r);
  window.__cx=960; window.__cy=540;
  window.__moveCur=(x,y)=>{window.__cx=x;window.__cy=y;
    c.style.transform='translate('+(x-3)+'px,'+(y-3)+'px)'; r.style.transform='translate('+x+'px,'+y+'px)';};
  window.__moveCur(960,540);
  window.__ping=()=>{r.style.transition='none';r.style.opacity='.95';
    r.style.transform='translate('+window.__cx+'px,'+window.__cy+'px) scale(.3)';
    requestAnimationFrame(()=>{r.style.transition='transform .5s ease-out, opacity .5s ease-out';
      r.style.opacity='0'; r.style.transform='translate('+window.__cx+'px,'+window.__cy+'px) scale(1.3)';});};
})()`;

async function glide(x, y, ms = 900) {
  const from = await E(`[window.__cx, window.__cy]`);
  const steps = Math.max(10, Math.round((ms / 1000) * FPS * 1.8));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const cx = Math.round(from[0] + (x - from[0]) * e), cy = Math.round(from[1] + (y - from[1]) * e);
    await E(`window.__moveCur(${cx},${cy})`);
    await S("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy }, sid);
    await sleep(ms / steps);
  }
  await sleep(260);
}
async function click(x, y) {
  await E(`window.__ping()`);
  await S("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
  await sleep(90);
  await S("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
  await sleep(600);
}
async function at(sel, nth = 0) {
  const r = await E(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
    if(!e) return null; const b=e.getBoundingClientRect();
    return [Math.round(b.x+b.width/2), Math.round(b.y+b.height/2)];})()`);
  if (!r) throw new Error("not found: " + sel);
  return r;
}
async function tap(sel, nth = 0, ms = 900) { const [x, y] = await at(sel, nth); await glide(x, y, ms); await click(x, y); }
async function tapText(text, ms = 900) {
  const i = await E(`[...document.querySelectorAll('button')].findIndex(b=>b.innerText.trim()===${JSON.stringify(text)})`);
  if (i < 0) throw new Error("no button: " + text);
  const [x, y] = await at("button", i); await glide(x, y, ms); await click(x, y);
}
async function type(t, per = 62) {
  for (const ch of t) {
    await S("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, sid);
    await S("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sid);
    await sleep(per);
  }
}

(async () => {
  let u; for (let i = 0; i < 60; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break; } catch { await sleep(500); } }
  ws = new WebSocket(u); await new Promise((r) => ws.once("open", r));
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const { targetInfos } = await S("Target.getTargets");
  ({ sessionId: sid } = await S("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true }));
  await S("Page.enable", {}, sid); await S("Runtime.enable", {}, sid);
  await S("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sid);

  await S("Page.navigate", { url: "http://127.0.0.1:7420/app" }, sid); await sleep(3000);
  await E(`localStorage.setItem('loomSetupSeen','1')`);
  await S("Page.navigate", { url: PAIR }, sid);
  await waitFor(`document.getElementById('cagent')`, 25, "app paired");
  await E(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await waitFor(`document.querySelectorAll('#feed .msg, #feed .sys').length > 3`, 20, "thread populated");
  await E(CURSOR);

  const marks = {}; const mark = (k) => { marks[k] = frame; console.log("  @" + k, frame); };
  recording = true; pump();
  await sleep(1800);

  // ---------------- 1. the thread ----------------
  // Each menu is opened, verified open, held, then closed by clicking its own
  // trigger again. The previous pass fired the click while the textarea still
  // had focus and the blur closed the menu on the same tick.
  mark("chat");
  await E(`(()=>{const f=document.getElementById('feed'); if(f) f.scrollTop=f.scrollHeight;})()`);
  await sleep(2400);
  await tap("#box");
  await type("Add a --json flag to `loom agents` and update its test");
  await sleep(1500);
  await E(`document.getElementById('box').blur()`);     // drop focus before menus
  await sleep(600);

  for (const [sel, label, secs] of [["#cagent","agents",12],["#modelpick","models",25]]) {
    await tap(sel);
    const open = await waitFor(`document.getElementById('cmenu') &&
      getComputedStyle(document.getElementById('cmenu')).display !== 'none' &&
      document.querySelectorAll('#cmenu .cmi').length > 1`, secs, label);
    console.log("    " + label + " menu open:", open,
      "rows:", await E(`document.querySelectorAll('#cmenu .cmi').length`));
    await sleep(3600);
    await tap(sel);                                     // close by its own trigger
    await sleep(900);
  }

  await tap("#skillbtn");
  const sk = await waitFor(`document.querySelectorAll('.mcpitem').length > 4`, 25, "skills");
  console.log("    skills modal:", sk, "rows:", await E(`document.querySelectorAll('.mcpitem').length`));
  await sleep(3800);
  await E(`(()=>{const s=document.querySelector('.scrim'); if(s) s.remove();})()`);
  await sleep(1000);

  // ---------------- 2. the board ----------------
  mark("board");
  await tapText("Board");
  await waitFor(`document.querySelectorAll('.bcol').length >= 4`, 25, "board columns");
  await sleep(2600);
  await E(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await sleep(900);

  mark("newtask");
  const ti = await E(`[...document.querySelectorAll('button')].findIndex(b=>/^\\+?\\s*task$/i.test(b.innerText.trim()))`);
  if (ti >= 0) { const [tx, ty] = await at("button", ti); await glide(tx, ty, 1000); await click(tx, ty); }
  await waitFor(`document.querySelector('.scrim input, .scrim textarea')`, 15, "task form");
  await sleep(1600);
  await type("Fix the phone brain sheet");
  await sleep(1400);
  const ci = await E(`[...document.querySelectorAll('.scrim button')].findIndex(b=>/create|add card|save/i.test(b.innerText))`);
  if (ci >= 0) { const [cx, cy] = await at(".scrim button", ci); await glide(cx, cy, 800); await click(cx, cy); }
  await sleep(3400);

  // ---------------- 3. the brain ----------------
  mark("brain");
  await tapText("Brain");
  await waitFor(`/CONSTRAINT|CONVENTION|DECISION|FAILURE/.test(document.body.innerText)`, 30, "brain units");
  await sleep(3000);
  await E(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await glide(1020, 560, 900);
  await sleep(1600);
  for (let k = 0; k < 40; k++) {
    await S("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1020, y: 560, deltaX: 0, deltaY: 58 }, sid);
    await sleep(330);
  }
  await sleep(2400);
  mark("end");

  recording = false; await sleep(800);
  fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify({ fps: FPS, frames: frame, marks }, null, 2));
  console.log("frames:", frame, "→", (frame / FPS).toFixed(1) + "s |", JSON.stringify(marks));
  chrome.kill(); process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
