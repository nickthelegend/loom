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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GuiChatDriver, delta } from "../src/adapters/bridges/gui-chat.js";
import { CdpSession, cdpTargets, cdpUp, workbenchTarget } from "../src/adapters/bridges/cdp.js";
import { tmpDir } from "./helpers.js";

/**
 * A page shaped like Antigravity actually is.
 *
 * Not a convenient page — the real one. The structure comes from
 * antigravity_phone_chat's selectors: a `#conversation` panel, a Lexical
 * composer inside it (`data-lexical-editor`), a submit button that is an
 * `svg.lucide-arrow-right` wrapped in a `<button>`, and a cancel button carrying
 * `data-tooltip-id="input-send-button-cancel-tooltip"` that appears while it's
 * generating. Plus the Monaco editor holding a source file, because that's the
 * thing the driver must never type into.
 *
 * The composer refuses assignment on purpose: `textContent = …` leaves it
 * "empty" as far as the submit button is concerned, exactly like Lexical. Only a
 * real `beforeinput` counts. A driver that cheats fails here — which is how the
 * execCommand path was caught: it fires `input` and not `beforeinput`, so it
 * filled the box and sent nothing.
 */
const PAGE = `<!doctype html>
<html><body style="margin:0">
  <div id="conversation">
    <div class="msg">previous answer</div>
    <div class="mx-8 mb-8">
      <div contenteditable="true" data-lexical-editor="true" id="composer" data-placeholder="Ask anything"></div>
      <button id="sendbtn"><svg class="lucide lucide-arrow-right"></svg></button>
      <button id="cancelbtn" data-tooltip-id="input-send-button-cancel-tooltip" style="display:none">Stop</button>
    </div>
  </div>

  <!-- the trap: Monaco is a contenteditable too, and it holds your source file -->
  <div class="monaco-editor">
    <div contenteditable="true" id="yourcode" aria-label="Editor content">const x = 1;</div>
  </div>

  <script>
    // Lexical keeps its own model and only trusts real editing events. Assigning
    // to the DOM updates what you see and nothing else — which is why the driver
    // types with CDP Input.insertText, the only path that fires beforeinput.
    const composer = document.getElementById('composer');
    let model = '';
    composer.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertText' && typeof e.data === 'string') model += e.data;
      if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteByCommand') model = '';
    });
    // execCommand("delete") on a selection fires this
    document.addEventListener('selectionchange', () => {});
    composer.addEventListener('input', (e) => {
      if (e.inputType && e.inputType.startsWith('delete')) model = composer.innerText.trim();
    });

    document.getElementById('sendbtn').addEventListener('click', () => {
      // the app trusts its model, not the DOM
      const said = (model || '').trim();
      if (!said) return;
      model = '';
      composer.innerHTML = '';
      const t = document.getElementById('conversation');
      const you = document.createElement('div');
      you.className = 'msg';
      you.textContent = 'you: ' + said;
      t.appendChild(you);
      // while it answers, the cancel button is visible — the busy signal
      document.getElementById('cancelbtn').style.display = 'block';
      setTimeout(() => {
        const a = document.createElement('div');
        a.className = 'msg';
        a.textContent = 'agent: I heard ' + said;
        t.appendChild(a);
        document.getElementById('cancelbtn').style.display = 'none';
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
  const probe = new GuiChatDriver("Antigravity", { debugPort }, "antigravity");
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

/**
 * A clean page for every test.
 *
 * These all share one browser, and each `ask()` leaves the page changed — a
 * grown transcript, a composer that was typed into, a fixture with its own
 * model of what it has been told. Without this, a test passes alone and fails
 * after its neighbours, which is exactly what happened: "leaves the code
 * untouched" timed out in sequence and passed in isolation. That's a broken
 * test, not a broken driver, and the fix is to stop sharing state rather than
 * to widen the timeout until the flake hides.
 */
beforeEach(async () => {
  if (!chromiumAvailable) return;
  const session = await CdpSession.open(
    workbenchTarget(await cdpTargets(`http://127.0.0.1:${debugPort}`))!,
  );
  try {
    await session.send("Page.reload", { ignoreCache: true });
  } finally {
    session.close();
  }
  // reload is async; wait for the app to be there again rather than guessing
  const probe = new GuiChatDriver("Antigravity", { debugPort }, "antigravity");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await probe.driveable()).ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the fixture page didn't come back after reload");
});

afterAll(async () => {
  chrome?.kill("SIGKILL");
  await new Promise<void>((r) => server.close(() => r()));
});

/** The Antigravity profile, against the Antigravity-shaped page. */
const driver = (selectors?: Record<string, string>): GuiChatDriver =>
  new GuiChatDriver(
    "Antigravity",
    { debugPort, settleMs: 700, replyTimeoutMs: 15_000, selectors },
    "antigravity",
  );

describe("gui-chat · finding the chat box", () => {
  it("reaches a running app", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    expect(await driver().reachable()).toBe(true);
  });

  it("says so when nothing is listening, instead of hanging", async () => {
    const dead = new GuiChatDriver("Antigravity", { debugPort: 1 }, "antigravity");
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

  /**
   * The claim, checked directly: a send changes the conversation and not your
   * source file.
   *
   * This used to send twice and assert on the reply text, which was both vague
   * and slow enough to flake — two full round trips, and under coverage's
   * slowdown it timed out. Read the editor, send once, read it again. The
   * question is "did my code change", so ask the code.
   */
  it("leaves the code untouched after a send", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    const codeNow = async (): Promise<string> => {
      const session = await CdpSession.open(
        workbenchTarget(await cdpTargets(`http://127.0.0.1:${debugPort}`))!,
      );
      try {
        return await session.evaluate<string>(`document.getElementById('yourcode').innerText`);
      } finally {
        session.close();
      }
    };

    const before = await codeNow();
    expect(before).toContain("const x = 1;");

    const reply = await driver().ask("third message");
    expect(reply).toContain("I heard third message"); // the send really happened

    expect(await codeNow()).toBe(before); // ...and the file is exactly as it was
  }, 30_000);

  it("refuses a selector that matches nothing rather than falling back", async ({ skip }) => {
    if (!chromiumAvailable) return skip();
    const d = await driver({ composer: "#not-a-thing" }).driveable();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("nothing matches the selector you set");
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
