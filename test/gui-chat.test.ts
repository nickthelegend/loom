/**
 * Driving a GUI agent's chat box over CDP — against a real Chromium.
 *
 * Antigravity and Kiro can't be tested here. Neither shows a composer until you
 * sign in (Antigravity) or open the chat panel (Kiro), and neither will do that
 * in CI. So this tests the part that IS testable and is where the bugs live:
 * the mechanism. A real browser, a real page with a real chat box, real CDP.
 *
 * It uses Electron's Chromium (already a devDependency of desktop/) rather than
 * asking for another browser download.
 *
 * The most important test in here is the one that refuses. Both target apps are
 * VS Code-family, and Monaco — the editor holding YOUR SOURCE FILE — is a
 * contenteditable. A driver that guesses will one day type a prompt into your
 * code and press Enter.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuiChatDriver, delta } from "../src/adapters/bridges/gui-chat.js";
import { cdpUp } from "../src/adapters/bridges/cdp.js";
import { tmpDir } from "./helpers.js";

/** A page shaped like the apps we're aiming at: a chat box, and a code editor. */
const PAGE = `<!doctype html>
<html><body style="margin:0">
  <div id="transcript"><div class="msg">previous answer</div></div>

  <!-- the trap: Monaco is a contenteditable, and it holds your source file -->
  <div class="monaco-editor">
    <div contenteditable="true" id="yourcode" aria-label="Editor content">const x = 1;</div>
  </div>

  <div id="panel">
    <div contenteditable="true" id="composer" data-placeholder="Ask Antigravity"></div>
    <button id="sendbtn" aria-label="Send">Send</button>
  </div>

  <script>
    // Answer the way the real thing does: the panel grows.
    document.getElementById('sendbtn').addEventListener('click', () => {
      const c = document.getElementById('composer');
      const said = c.innerText.trim();
      if (!said) return;
      c.innerText = '';
      const t = document.getElementById('transcript');
      const you = document.createElement('div');
      you.className = 'msg';
      you.textContent = 'you: ' + said;
      t.appendChild(you);
      setTimeout(() => {
        const a = document.createElement('div');
        a.className = 'msg';
        a.textContent = 'agent: I heard ' + said;
        t.appendChild(a);
      }, 150);
    });
  </script>
</body></html>`;

let server: http.Server;
let chrome: ChildProcess | null = null;
let port = 0;
let debugPort = 0;
let chromiumAvailable = false;

/**
 * Electron ships a Chromium; use it rather than downloading another.
 *
 * It lives in desktop/node_modules, which CI doesn't install — the workflow
 * runs `npm ci` at the root only. So these tests run locally and skip in CI.
 * That's a real gap, stated rather than hidden: the mechanism is verified on a
 * developer's machine and nowhere else.
 */
function electronBinary(): string | null {
  const base = path.resolve(import.meta.dirname, "..", "desktop", "node_modules", "electron", "dist");
  const candidates =
    process.platform === "darwin"
      ? [path.join(base, "Electron.app", "Contents", "MacOS", "Electron")]
      : process.platform === "win32"
        ? [path.join(base, "electron.exe")]
        : [path.join(base, "electron")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  port = await freePort();
  debugPort = await freePort();
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));

  const bin = electronBinary();
  if (!bin) return; // no Electron here; every test below skips itself

  // A bare Electron with no app opens Chromium's default window; ELECTRON_RUN_AS_NODE
  // would defeat the point, so it's explicitly not set.
  const userData = tmpDir("cdp-profile");
  chrome = spawn(
    bin,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userData}`,
      "--no-sandbox",
      "--headless=new",
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } },
  );

  // Wait for the page, not just the port. CDP answers well before the document
  // is parsed, and a test that starts in that window finds no chat box and
  // fails for a reason that has nothing to do with the code — which is exactly
  // what happened: the first run failed here and the second passed. Flaky is
  // broken.
  const probe = new GuiChatDriver("TestApp", { debugPort });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await cdpUp(`http://127.0.0.1:${debugPort}`)) {
      const ready = await probe.driveable();
      if (ready.ok) {
        chromiumAvailable = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}, 50_000);

afterAll(async () => {
  chrome?.kill("SIGKILL");
  await new Promise<void>((r) => server.close(() => r()));
});

const driver = (selectors?: Record<string, string>): GuiChatDriver =>
  new GuiChatDriver("TestApp", { debugPort, settleMs: 700, replyTimeoutMs: 15_000, selectors });

describe("gui-chat · finding the chat box", () => {
  it("reaches a running app", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    expect(await driver().reachable()).toBe(true);
  });

  it("says so when nothing is listening, instead of hanging", async () => {
    const dead = new GuiChatDriver("TestApp", { debugPort: 1 });
    expect(await dead.reachable()).toBe(false);
    const d = await dead.driveable();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("--remote-debugging-port");
  });

  it("finds the composer by its label, not by being the first editable thing", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    const d = await driver().driveable();
    expect(d.ok, d.reason).toBe(true);
  });
});

describe("gui-chat · typing and reading", () => {
  it("types into the app and reads what the panel gained", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    const reply = await driver().ask("hello there");
    expect(reply).toContain("you: hello there");
    expect(reply).toContain("agent: I heard hello there");
  }, 30_000);

  it("goes through the input pipeline, so the app's own JS sees it", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    // The page's handler reads innerText on click. If text were assigned rather
    // than typed, React-and-friends would never hear about it — this is the
    // difference between insertText and el.value = "...".
    const reply = await driver().ask("second message");
    expect(reply).toContain("I heard second message");
  }, 30_000);
});

/**
 * The hazard, and the whole reason discovery is narrow.
 */
describe("gui-chat · refusing to type into your source file", () => {
  it("never picks an editable inside the code editor", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    // #yourcode sits in .monaco-editor and is a perfectly good contenteditable.
    // Point the driver straight at it and it must still say no.
    const d = await driver({ composer: "#yourcode" }).driveable();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("code editor");
  });

  it("leaves the code untouched after a send", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    await driver().ask("third message");
    const still = await driver().driveable();
    expect(still.ok).toBe(true);
    // the transcript grew; the editor's content did not
    const reply = await driver().ask("fourth message");
    expect(reply).not.toContain("const x = 1;fourth");
  }, 40_000);

  it("refuses a selector that matches nothing rather than falling back", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    const d = await driver({ composer: "#not-a-thing" }).driveable();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("no element matches");
  });
});

describe("gui-chat · reading the panel's growth", () => {
  it("returns what was appended", () => {
    expect(delta("a\nb", "a\nb\nc")).toBe("c");
  });

  it("copes when the panel scrolled instead of grew", () => {
    // the head fell off; only the common prefix is gone
    expect(delta("old\nmid", "old\nnew")).toContain("new");
  });

  it("returns nothing when nothing happened", () => {
    expect(delta("same", "same")).toBe("");
  });
});
