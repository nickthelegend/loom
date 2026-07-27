/**
 * Renders the video's designed still frames at 1920x1080 using the REAL vendor
 * brand marks from src/daemon/brand-icons.ts and Loom's real brand tokens
 * (captured from loompad.tech): near-black ground, one orange #ff6b2b, Space Grotesk.
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BRAND_SPRITE } from "./dist/daemon/brand-icons.js";

const CHROME = "/Users/jaibajrang/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const OUT = process.argv[2];
const FONT = process.argv[3]; // absolute path to a Space Grotesk woff2
const PORT = 9355;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fontB64 = fs.readFileSync(FONT).toString("base64");

const CSS = `
@font-face{font-family:"SG";src:url(data:font/woff2;base64,${fontB64}) format("woff2");font-weight:100 900;font-display:block}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;background:#0A0A0B;color:#FAFAFA;
  font-family:"SG",system-ui,sans-serif;overflow:hidden}
.wrap{width:1920px;height:1080px;position:relative;display:flex;flex-direction:column;
  align-items:center;justify-content:center}
.mark{width:150px;height:150px}
.mark.sm{width:104px;height:104px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.kicker{font-size:15px;letter-spacing:.22em;text-transform:uppercase;color:#6B6B74}
.orange{color:#FF6B2B}
.rule{height:1px;background:#1F1F22}
`;

const CARDS = {
  // Scene 1 — the pain. Two real vendor marks, visibly separate, each walled off.
  "scene01-pain": `
    <div class="wrap">
      <div style="display:flex;align-items:stretch;gap:0;width:1180px;height:400px">
        <div style="flex:1;border:1px solid #1F1F22;border-radius:14px;display:flex;
             flex-direction:column;align-items:center;justify-content:center;gap:26px;background:#0d0d0f">
          <svg class="mark"><use href="#brand-claude-code"/></svg>
          <div class="mono" style="font-size:20px;color:#A1A1AA">claude-code</div>
          <div class="mono" style="font-size:14px;color:#6B6B74">CLAUDE.md</div>
        </div>
        <div style="width:150px;display:flex;align-items:center;justify-content:center">
          <div class="mono orange" style="font-size:15px;letter-spacing:.16em;text-align:center;line-height:1.7">NO<br/>SHARED<br/>MEMORY</div>
        </div>
        <div style="flex:1;border:1px solid #1F1F22;border-radius:14px;display:flex;
             flex-direction:column;align-items:center;justify-content:center;gap:26px;background:#0d0d0f">
          <svg class="mark"><use href="#brand-codex"/></svg>
          <div class="mono" style="font-size:20px;color:#A1A1AA">codex</div>
          <div class="mono" style="font-size:14px;color:#6B6B74">AGENTS.md</div>
        </div>
      </div>
      <div style="margin-top:64px;font-size:36px;font-weight:500;letter-spacing:-0.02em;color:#A1A1AA">
        Two agents. Two brains. Neither can read the other.
      </div>
    </div>`,

  // Scene 2 — the claim.
  "scene02-claim": `
    <div class="wrap" style="align-items:flex-start;padding-left:190px">
      <div style="font-size:210px;font-weight:700;letter-spacing:-0.055em;line-height:.92">LOOM</div>
      <div class="rule orange" style="width:250px;height:3px;background:#FF6B2B;margin:26px 0 30px"></div>
      <div class="mono" style="font-size:29px;color:#A1A1AA;letter-spacing:.01em">
        the shared-memory layer for AI coding agents
      </div>
    </div>`,

  // Scene 7 — the fleet, with the real marks.
  "scene07-fleet": `
    <div class="wrap">
      <div class="kicker" style="margin-bottom:66px">agents that can take a turn</div>
      <div style="display:flex;align-items:flex-start;gap:74px">
        ${[["claude-code", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"],
           ["grok-code", "Grok"], ["antigravity", "Antigravity"]]
          .map(([k, n]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:22px;width:172px">
              <svg class="mark sm"><use href="#brand-${k}"/></svg>
              <div style="font-size:21px;font-weight:500;text-align:center">${n}</div>
            </div>`).join("")}
      </div>
      <div class="rule" style="width:1080px;margin:70px 0 26px"></div>
      <div class="mono" style="font-size:17px;color:#6B6B74">
        each verified against a real version &middot; each asked what models it can run
      </div>
    </div>`,

  // Scene 10 — close. The install line is the only orange thing on screen.
  "scene10-close": `
    <div class="wrap">
      <div style="font-size:176px;font-weight:700;letter-spacing:-0.055em;line-height:.94">LOOM</div>
      <div style="font-size:37px;font-weight:400;color:#A1A1AA;margin-top:16px">one brain, every agent</div>
      <div class="rule" style="width:190px;margin:52px 0 44px"></div>
      <div class="mono orange" style="font-size:31px">npm i -g @loompad/cli</div>
      <div class="mono" style="font-size:20px;color:#6B6B74;margin-top:20px">github.com/nickthelegend/loom</div>
    </div>`,
};

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, "--headless=new", "--hide-scrollbars",
  "--window-size=1920,1080", "--force-device-scale-factor=1",
  "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/loom-cards-profile", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

let ws, id = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify(s ? { id: i, method: m, params: p, sessionId: s } : { id: i, method: m, params: p }));
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);

  for (const [name, body] of Object.entries(CARDS)) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
      <body>${BRAND_SPRITE}${body}</body></html>`;
    const f = path.join(OUT, `_${name}.html`);
    fs.writeFileSync(f, html);
    await send("Page.navigate", { url: "file://" + f }, sessionId);
    await sleep(2200);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
    fs.unlinkSync(f);
    console.log("  rendered", name);
  }
  chrome.kill(); process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
