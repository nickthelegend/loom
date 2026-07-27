/**
 * Drives the real Loom daemon in headless Chrome and writes 1920x1080 PNGs of
 * the states the video needs. Real app, real data, real agent turns — the whole
 * point is that nothing here is a mockup.
 *
 * Usage: node capture-loom.mjs <pairUrl> <outDir>
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Users/jaibajrang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PAIR_URL = process.argv[2];
const OUT = process.argv[3];
const PORT = 9333;

if (!PAIR_URL || !OUT) { console.error("need <pairUrl> <outDir>"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--headless=new",
  "--hide-scrollbars",
  "--window-size=1920,1080",
  "--force-device-scale-factor=1",
  "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/loom-capture-profile",
  "--disable-features=Translate",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      return j.webSocketDebuggerUrl;
    } catch { await sleep(500); }
  }
  throw new Error("chrome never came up");
}

let sessionId;
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
}

let shotN = 0;
async function shot(label) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const name = `${String(shotN++).padStart(3, "0")}-${label}.png`;
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
  console.log("  shot", name);
  return name;
}

(async () => {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.once("open", r));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  ({ sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);

  console.log("→ pairing");
  // A fresh Chrome profile is a first run, so the app auto-opens Settings over
  // everything. Mark it seen on the origin before the app boots.
  await send("Page.navigate", { url: "http://127.0.0.1:7420/app" }, sessionId);
  await sleep(2500);
  await evaluate(`localStorage.setItem('loomSetupSeen','1')`);
  await send("Page.navigate", { url: PAIR_URL }, sessionId);
  await sleep(6000);
  // and belt-and-braces: kill any scrim that still made it up
  await evaluate(`(()=>{document.querySelectorAll('.scrim').forEach(s=>s.remove()); return 1})()`);
  await sleep(600);

  const paired = await evaluate(`!!document.getElementById('cagent')`);
  console.log("  paired:", paired);
  if (!paired) { console.log("  NOT PAIRED — token may be spent"); }

  // ---- 1. the thread, with the real route + handoff already in it ----
  await evaluate(`(()=>{const f=document.getElementById('feed'); if(f) f.scrollTop=f.scrollHeight; return 1})()`);
  await sleep(1200);
  await shot("thread-real-route");

  // ---- 2. a real prompt typed into the composer ----
  const PROMPT = "Add a --json flag to `loom agents` and update its test";
  await evaluate(`(()=>{
    const b=document.getElementById('box'); b.focus(); b.value=${JSON.stringify(PROMPT)};
    b.dispatchEvent(new Event('input',{bubbles:true})); return b.value })()`);
  await sleep(900);
  await shot("prompt-typed");

  // ---- 3. the agent switcher open, every agent listed ----
  await evaluate(`document.getElementById('cagent').click()`);
  await sleep(700);
  await shot("agent-switcher-open");
  await evaluate(`(()=>{const m=document.getElementById('cmenu'); if(m) m.style.display='none'; return 1})()`);
  await sleep(300);

  // ---- 4. send it for real, and burst-capture the generating state ----
  console.log("→ sending a real turn");
  await evaluate(`(()=>{const f=document.getElementById('cform');
    f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return 1})()`);
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    await evaluate(`(()=>{const f=document.getElementById('feed'); if(f) f.scrollTop=f.scrollHeight; return 1})()`);
    await shot(`generating-${String(i).padStart(2, "0")}`);
  }

  // ---- 5. the Board — kanban ----
  console.log("→ board");
  const bOk = await evaluate(`(()=>{
    document.querySelectorAll('.scrim').forEach(s=>s.remove());
    const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Board');
    if(b){ b.click(); return true } return false })()`);
  await sleep(4000);
  await evaluate(`(()=>{document.querySelectorAll('.scrim').forEach(s=>s.remove()); return 1})()`);
  await sleep(600);
  console.log("  board clicked:", bOk, "| cols:", await evaluate(`document.querySelectorAll('.bcol,.bcard').length`));
  await shot("board-kanban");

  // ---- 6. project settings — roles per ADE ----
  console.log("→ roles");
  const rOk = await evaluate(`(()=>{
    document.querySelectorAll('.scrim').forEach(s=>s.remove());
    const g=document.querySelector('[data-pset]'); if(g){ g.click(); return true } return false })()`);
  await sleep(2500);
  console.log("  gear clicked:", rOk, "| psrows:", await evaluate(`document.querySelectorAll('.psrow').length`));
  await shot("roles-per-ade");
  await evaluate(`(()=>{const s=document.querySelector('.scrim'); if(s) s.remove(); return 1})()`);
  await sleep(400);

  // ---- 7. the Brain ----
  console.log("→ brain");
  const brOk = await evaluate(`(()=>{
    document.querySelectorAll('.scrim').forEach(s=>s.remove());
    const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Brain');
    if(b){ b.click(); return true } return false })()`);
  await sleep(4500);
  await evaluate(`(()=>{document.querySelectorAll('.scrim').forEach(s=>s.remove()); return 1})()`);
  await sleep(600);
  console.log("  brain clicked:", brOk, "| units:", await evaluate(`document.querySelectorAll('.bu,.brainunit,.munit,.mu').length`));
  await shot("brain");
  await evaluate(`(()=>{const p=document.querySelector('.brainwrap,.brain,#brain'); if(p) p.scrollTop=260; return 1})()`);
  await sleep(900);
  await shot("brain-scrolled");

  // ---- 8. back to the thread to show the finished answer ----
  await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='Thread'); if(b) b.click(); return !!b})()`);
  await sleep(2500);
  await evaluate(`(()=>{const f=document.getElementById('feed'); if(f) f.scrollTop=f.scrollHeight; return 1})()`);
  await sleep(800);
  await shot("thread-answer");

  console.log("done —", shotN, "shots ->", OUT);
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
