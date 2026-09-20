/**
 * A picture of the page Loom is previewing.
 *
 * The preview is an iframe pointing at someone else's origin, so the browser
 * will not let the page photograph it — and a person who can see the bug on
 * screen shouldn't have to describe it in words. The daemon takes the shot
 * instead, with the Playwright the project already has for its specs, and the
 * file lands where attachments live so the composer can carry it like any
 * pasted image.
 *
 * A project without Playwright is told so plainly rather than handed an empty
 * file: `npx --no-install` never installs anything behind your back.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShotRequest {
  url: string;
  width?: number;
  height?: number;
  /** What the page should think the OS is set to. */
  colorScheme?: "light" | "dark";
  fullPage?: boolean;
  timeoutMs?: number;
}

export const MAX_SHOT_MS = 45_000;

/** The little script Playwright runs. Kept here so what it does is readable. */
export function shotScript(req: Required<Omit<ShotRequest, "timeoutMs">> & { out: string }): string {
  return `const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: ${req.width}, height: ${req.height} },
    colorScheme: ${JSON.stringify(req.colorScheme)},
    deviceScaleFactor: 2,
  });
  try {
    await page.goto(${JSON.stringify(req.url)}, { waitUntil: "load", timeout: 20000 });
    // Settle: fonts and the first paint of whatever loaded late.
    await page.waitForTimeout(400);
    await page.screenshot({ path: ${JSON.stringify(req.out)}, fullPage: ${req.fullPage} });
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
`;
}

export interface ShotResult {
  /** Where the PNG landed, absolute. */
  file: string;
  width: number;
  height: number;
  colorScheme: "light" | "dark";
  fullPage: boolean;
}

/**
 * Take the shot in `projectDir` (so the project's own Playwright and browsers
 * are the ones used). Rejects with something a person can act on.
 */
export async function capture(projectDir: string, req: ShotRequest, spawnImpl: typeof spawn = spawn): Promise<ShotResult> {
  const url = req.url.trim();
  if (!/^https?:\/\//.test(url)) throw new Error("a screenshot needs an http(s) url");
  const width = clamp(req.width ?? 1280, 200, 3840);
  const height = clamp(req.height ?? 800, 200, 3840);
  const colorScheme = req.colorScheme === "dark" ? "dark" : "light";
  const fullPage = Boolean(req.fullPage);

  // The script lives in the PROJECT, not in /tmp: node resolves `playwright`
  // from the script's own directory, and a script in /tmp would never find the
  // project's copy — it would report "no Playwright" for a project that has it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-shot-"));
  const scriptDir = path.join(projectDir, ".loom");
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, `preview-shot-${process.pid}-${Date.now()}.cjs`);
  const out = path.join(tmp, "shot.png");
  fs.writeFileSync(script, shotScript({ url, width, height, colorScheme, fullPage, out }));

  const code = await new Promise<{ code: number; err: string }>((resolve) => {
    const child = spawnImpl("npx", ["--no-install", "node", script], {
      cwd: projectDir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => (err += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), req.timeoutMs ?? MAX_SHOT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, err: e.message });
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve({ code: c ?? 1, err });
    });
  });

  fs.rmSync(script, { force: true });
  if (code.code !== 0 || !fs.existsSync(out)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(explain(code.err));
  }
  return { file: out, width, height, colorScheme, fullPage };
}

/** Playwright's failures, in words that say what to do. */
export function explain(stderr: string): string {
  const s = stderr.trim();
  if (/Cannot find module 'playwright'|Cannot find package 'playwright'/.test(s)) {
    return "this project has no Playwright — add it (npm i -D playwright) and run npx playwright install chromium";
  }
  if (/Executable doesn't exist|browserType.launch/.test(s)) {
    return "Playwright is here but its browser isn't — run npx playwright install chromium";
  }
  if (/net::ERR_CONNECTION_REFUSED/.test(s)) return "nothing answered at that address — is the server running?";
  if (/Timeout .* exceeded|navigation timeout/i.test(s)) return "the page didn't finish loading in time";
  return s.split("\n").slice(-3).join(" ").slice(0, 300) || "the screenshot failed";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
}
