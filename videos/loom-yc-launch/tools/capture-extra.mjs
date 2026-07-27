/**
 * The captures the 3-minute demo needs that the first pass didn't take:
 * the real model picker, a task actually changing column, the phone app at a
 * phone viewport, and loompad.tech.
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Users/jaibajrang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PAIR = process.argv[2], OUT = process.argv[3], PORT = 9366;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless=new", "--hide-scrollbars",
  "--window-size=1920,1080", "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/loom-extra-profile", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

let ws, id = 0, sid; const pend = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify(s ? { id: i, method: m, params: p, sessionId: s } : { id: i, method: m, params: p })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
let n = 0;
const shot = async (label) => { const r = await send("Page.captureScreenshot", { format: "png" }, sid);
  const f = `${String(n++).padStart(2, "0")}-${label}.png`; fs.writeFileSync(path.join(OUT, f), Buffer.from(r.data, "base64"));
  console.log("  ", f); };
const size = (w, h, m = false) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: m ? 3 : 1, mobile: m }, sid);

(async () => {
  let u; for (let i = 0; i < 60; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break; } catch { await sleep(500); } }
  ws = new WebSocket(u); await new Promise((r) => ws.once("open", r));
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const { targetInfos } = await send("Target.getTargets");
  ({ sessionId: sid } = await send("Target.attachToTarget", { targetId: targetInfos.find((t) => t.type === "page").targetId, flatten: true }));
  await send("Page.enable", {}, sid); await send("Runtime.enable", {}, sid);

  // ---- desktop ----
  await size(1920, 1080);
  await send("Page.navigate", { url: "http://127.0.0.1:7420/app" }, sid); await sleep(2500);
  await ev(`localStorage.setItem('loomSetupSeen','1')`);
  await send("Page.navigate", { url: PAIR }, sid); await sleep(6000);
  await ev(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  console.log("paired:", await ev(`!!document.getElementById('cagent')`));

  // 1. the model picker, with the models the CLIs actually reported
  await ev(`document.getElementById('modelpick').click()`); await sleep(3500);
  console.log("  models listed:", await ev(`document.querySelectorAll('#cmenu .cmi').length`));
  await shot("model-picker");
  await ev(`(()=>{const m=document.getElementById('cmenu'); if(m) m.style.display='none';})()`); await sleep(400);

  // 2. the agent switcher, every agent
  await ev(`document.getElementById('cagent').click()`); await sleep(900);
  await shot("agent-switcher");
  await ev(`(()=>{const m=document.getElementById('cmenu'); if(m) m.style.display='none';})()`); await sleep(400);

  // 3. the board, then the same board with a task moved — the change itself
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Board'); if(b) b.click();})()`);
  await sleep(3500); await ev(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await shot("board-before");
  const moved = await ev(`(async()=>{
    const pid='9fdeb1f4205d';
    const tok = ${JSON.stringify(process.env.LOOM_TOKEN || "")};
    const r = await fetch('/api/projects/'+pid+'/board/tasks/700b90c0',{method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},
      body:JSON.stringify({column:'in-review'})});
    return r.status; })()`);
  console.log("  task move status:", moved);
  await sleep(2600); await shot("board-after");

  // 4. the brain
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Brain'); if(b) b.click();})()`);
  await sleep(4000); await ev(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`); await shot("brain");

  // ---- the phone app, at a phone ----
  await size(430, 932, true);
  await send("Page.navigate", { url: "http://127.0.0.1:7420/app" }, sid); await sleep(5000);
  await ev(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  await ev(`(()=>{const c=document.querySelector('.pcard,[data-id],.srow'); if(c) c.click();})()`);
  await sleep(3500);
  await ev(`document.querySelectorAll('.scrim').forEach(s=>s.remove())`);
  console.log("  mobile tabs:", await ev(`[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,10).join('|')`));
  await shot("mobile-thread");
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/board/i.test(x.innerText)); if(b) b.click();})()`);
  await sleep(3000); await shot("mobile-board");
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/brain/i.test(x.innerText)); if(b) b.click();})()`);
  await sleep(3000); await shot("mobile-brain");

  // ---- the landing page ----
  await size(1920, 1080);
  await send("Page.navigate", { url: "https://loompad.tech" }, sid); await sleep(8000);
  await shot("landing-top");
  await ev(`window.scrollTo({top:900,behavior:'instant'})`); await sleep(1600); await shot("landing-2");
  await ev(`window.scrollTo({top:2100,behavior:'instant'})`); await sleep(1600); await shot("landing-3");

  console.log("done —", n, "shots");
  chrome.kill(); process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
