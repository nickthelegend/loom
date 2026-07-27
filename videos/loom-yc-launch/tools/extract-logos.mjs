/**
 * Renders each real vendor brand mark out of src/daemon/brand-icons.ts into a
 * transparent PNG, so the video uses the actual Claude Code / Codex / OpenCode /
 * Grok / Antigravity logos rather than text chips.
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BRAND_SPRITE, BRAND_TITLES } from "../../../dist/daemon/brand-icons.js";

const CHROME = "/Users/jaibajrang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const OUT = process.argv[2];
const PORT = 9344;
const SIZE = 512;
fs.mkdirSync(OUT, { recursive: true });

const KINDS = ["claude-code", "codex", "opencode", "grok-code", "antigravity", "kiro"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  #stage{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}
  svg.mark{width:${SIZE * 0.82}px;height:${SIZE * 0.82}px;color:#FAFAFA;fill:#FAFAFA}
</style></head><body>
${BRAND_SPRITE}
<div id="stage"><svg class="mark" id="m" aria-hidden="true"><use id="u" href=""></use></svg></div>
</body></html>`;

const tmp = path.join(OUT, "_sprite.html");
fs.writeFileSync(tmp, html);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, "--headless=new", "--hide-scrollbars",
  `--window-size=${SIZE},${SIZE}`, "--force-device-scale-factor=2",
  "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/loom-logo-profile", "--default-background-color=00000000",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

let ws, id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
});

(async () => {
  let wsUrl;
  for (let i = 0; i < 60; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break; }
    catch { await sleep(500); }
  }
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.once("open", r));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: SIZE, height: SIZE, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  await send("Page.navigate", { url: "file://" + tmp }, sessionId);
  await sleep(2500);

  for (const kind of KINDS) {
    const ok = await send("Runtime.evaluate", {
      expression: `(()=>{const u=document.getElementById('u');
        u.setAttribute('href','#brand-${kind}');
        const s=document.querySelector('#brand-${kind}'); return !!s })()`,
      returnByValue: true,
    }, sessionId);
    await sleep(400);
    if (!ok.result?.value) { console.log(`  ${kind}: NO SYMBOL, skipped`); continue; }
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    const f = path.join(OUT, `logo-${kind}.png`);
    fs.writeFileSync(f, Buffer.from(shot.data, "base64"));
    console.log(`  ${kind} -> ${path.basename(f)} (${BRAND_TITLES[kind] ?? kind})`);
  }
  fs.unlinkSync(tmp);
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
