/**
 * Records the real UI being driven — real clicks, real typing, a visible cursor.
 *
 * Zooming around a screenshot shows the app; this shows someone USING it. A
 * cursor is injected into the page and tweened between targets, CDP dispatches
 * genuine mouse and key events at those coordinates, and frames are captured
 * continuously throughout, so what lands on disk is the app actually responding.
 *
 * Usage: node record-ui.mjs <pairUrl> <outDir>
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Users/jaibajrang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PAIR = process.argv[2], OUT = process.argv[3], PORT = 9388;
const W = 1920, H = 1080, FPS = 12;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless=new", "--hide-scrollbars",
  `--window-size=${W},${H}`, "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/loom-rec-profile", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

let ws, id = 0, sid; const pend = new Map();
const S = (m, p = {}, s) => new Promise((res, rej) => { const k = ++id; pend.set(k, { res, rej });
  ws.send(JSON.stringify(s ? { id: k, method: m, params: p, sessionId: s } : { id: k, method: m, params: p })); });
const E = async (e) => { const r = await S("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception?.description || "")); return r.result?.value; };

// ---- frame capture, running the whole time ----------------------------------
let frame = 0, recording = false;
async function pump() {
  while (recording) {
    const t0 = Date.now();
    try {
      const r = await S("Page.captureScreenshot", { format: "jpeg", quality: 82 }, sid);
      fs.writeFileSync(path.join(OUT, `f${String(frame++).padStart(5, "0")}.jpg`), Buffer.from(r.data, "base64"));
    } catch { /* a frame lost mid-navigation is not worth stopping for */ }
    const wait = Math.max(0, 1000 / FPS - (Date.now() - t0));
    await sleep(wait);
  }
}

// ---- the cursor -------------------------------------------------------------
const CURSOR = `(() => {
  if (document.getElementById('__cur')) return;
  const c = document.createElement('div');
  c.id = '__cur';
  c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;' +
    'pointer-events:none;transform:translate(-3px,-3px);will-change:transform';
  c.innerHTML =
    '<svg viewBox="0 0 26 26" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,.75))">' +
    '<path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.8 21.4 L11.4 14.2 L18 14 Z" fill="#fff" stroke="#0A0A0B" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const r = document.createElement('div');
  r.id = '__ring';
  r.style.cssText = 'position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;' +
    'border:3px solid #FF6B2B;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0;will-change:transform,opacity';
  document.body.appendChild(c); document.body.appendChild(r);
  window.__cx = 960; window.__cy = 540;
  window.__moveCur = (x, y) => { window.__cx = x; window.__cy = y;
    c.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 3) + 'px)';
    r.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  window.__moveCur(960, 540);
  // the click tell: a ring that snaps out and fades, so a viewer sees the press
  window.__ping = () => {
    r.style.transition = 'none'; r.style.opacity = '.95';
    r.style.transform = 'translate(' + window.__cx + 'px,' + window.__cy + 'px) scale(.35)';
    requestAnimationFrame(() => { r.style.transition = 'transform .42s ease-out, opacity .42s ease-out';
      r.style.opacity = '0';
      r.style.transform = 'translate(' + window.__cx + 'px,' + window.__cy + 'px) scale(1.25)'; });
  };
})()`;

/** Ease the cursor to a point over `ms`, so the eye can follow it. */
async function glide(x, y, ms = 620) {
  const from = await E(`[window.__cx, window.__cy]`);
  const steps = Math.max(6, Math.round((ms / 1000) * FPS * 1.6));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    const cx = Math.round(from[0] + (x - from[0]) * e), cy = Math.round(from[1] + (y - from[1]) * e);
    await E(`window.__moveCur(${cx},${cy})`);
    await S("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy }, sid);
    await sleep(ms / steps);
  }
}

async function click(x, y) {
  await E(`window.__ping()`);
  await S("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
  await sleep(70);
  await S("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
  await sleep(420);
}

/** Where is this thing on screen? Returns the centre of the first match. */
async function at(sel, nth = 0) {
  const r = await E(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
    if(!e) return null; const b=e.getBoundingClientRect();
    return [Math.round(b.x+b.width/2), Math.round(b.y+b.height/2)];})()`);
  if (!r) throw new Error("not found: " + sel + " [" + nth + "]");
  return r;
}
async function goClick(sel, nth = 0, ms = 620) { const [x, y] = await at(sel, nth); await glide(x, y, ms); await click(x, y); }

async function type(text, perKey = 55) {
  for (const ch of text) {
    await S("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, sid);
    await S("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sid);
    await sleep(perKey);
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

  await S("Page.navigate", { url: "http://127.0.0.1:7420/app" }, sid); await sleep(2500);
  await E(`localStorage.setItem('loomSetupSeen','1')`);
  await S("Page.navigate", { url: PAIR }, sid); await sleep(6500);
  await E(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await E(CURSOR);
  const marks = {};
  const mark = (k) => { marks[k] = frame; console.log("  @" + k, frame); };

  recording = true; pump();
  await sleep(700);

  // brain only — a long, readable scroll
  mark("brain");
  const bi2 = await E(`[...document.querySelectorAll('button')].findIndex(b=>b.innerText.trim()==='Brain')`);
  const [rx2, ry2] = await at("button", bi2); await glide(rx2, ry2, 800); await click(rx2, ry2);
  await sleep(3400);
  await E(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await glide(1000, 600, 800);
  await sleep(1400);
  // small wheel steps with a pause between, so the units can actually be read
  for (let k = 0; k < 46; k++) {
    await S("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1000, y: 600, deltaX: 0, deltaY: 62 }, sid);
    await sleep(300);
  }
  await sleep(1600);
  mark("end");

  recording = false; await sleep(600);
  fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify({ fps: FPS, frames: frame, marks }, null, 2));
  console.log("frames:", frame, "| marks:", JSON.stringify(marks));
  chrome.kill(); process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
