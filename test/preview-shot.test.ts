/**
 * A picture of the previewed page.
 *
 * The capture itself is Playwright's job in the project's own directory, so
 * what's worth testing here is everything around it: the script it's handed,
 * the sizes it's given, and — most of all — what a person is told when it
 * doesn't work, because "the screenshot failed" helps nobody.
 */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { capture, explain, shotScript } from "../src/core/preview-shot.js";
import { tmpDir } from "./helpers.js";

/** A spawn that runs nothing: it reports what it was asked, and writes the png. */
function fakeSpawn(opts: { code?: number; stderr?: string; writeOut?: boolean } = {}) {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const impl = ((cmd: string, args: string[], o: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      if (opts.writeOut !== false) {
        // the script's last argument is the file it was told to write
        const script = fs.readFileSync(args[args.length - 1]!, "utf8");
        const out = /screenshot\(\{ path: "([^"]+)"/.exec(script)?.[1];
        if (out) fs.writeFileSync(out, Buffer.from("PNG"));
      }
      child.emit("exit", opts.code ?? 0);
    }, 5);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { impl, calls };
}

describe("the script Playwright is handed", () => {
  it("asks for the size, the scheme and the page it was given, and nothing else", () => {
    const js = shotScript({ url: "http://localhost:3000/checkout", width: 375, height: 812, colorScheme: "dark", fullPage: true, out: "/tmp/a.png" });
    expect(js).toContain('viewport: { width: 375, height: 812 }');
    expect(js).toContain('colorScheme: "dark"');
    expect(js).toContain('"http://localhost:3000/checkout"');
    expect(js).toContain("fullPage: true");
    expect(js).toContain("browser.close()"); // never leave chromium running
  });

  it("quotes the url rather than pasting it into the script", () => {
    const js = shotScript({ url: 'http://x/"); process.exit(1); //', width: 100, height: 100, colorScheme: "light", fullPage: false, out: "/tmp/a.png" });
    expect(js).toContain(JSON.stringify('http://x/"); process.exit(1); //'));
  });
});

describe("taking one", () => {
  it("runs in the project, clamps silly sizes, and returns the file", async () => {
    const dir = tmpDir("shot-ok");
    const { impl, calls } = fakeSpawn();
    const shot = await capture(dir, { url: "http://localhost:5173", width: 99_999, height: 10 }, impl);
    expect(calls[0]!.cwd).toBe(dir); // the project's Playwright, not ours
    expect(calls[0]!.args[0]).toBe("--no-install"); // never installs behind your back
    expect(shot.width).toBe(3840);
    expect(shot.height).toBe(200);
    expect(fs.existsSync(shot.file)).toBe(true);
    expect(path.extname(shot.file)).toBe(".png");
  });

  it("refuses a url that isn't a url", async () => {
    await expect(capture(tmpDir("shot-bad"), { url: "localhost:3000" }, fakeSpawn().impl)).rejects.toThrow(/http\(s\) url/);
    await expect(capture(tmpDir("shot-bad2"), { url: "file:///etc/passwd" }, fakeSpawn().impl)).rejects.toThrow(/http\(s\) url/);
  });

  it("says what to do when Playwright or its browser is missing", async () => {
    const noPw = fakeSpawn({ code: 1, stderr: "Error: Cannot find module 'playwright'", writeOut: false });
    await expect(capture(tmpDir("shot-nopw"), { url: "http://localhost:3000" }, noPw.impl)).rejects.toThrow(/npm i -D playwright/);

    const noBrowser = fakeSpawn({ code: 1, stderr: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium", writeOut: false });
    await expect(capture(tmpDir("shot-nobr"), { url: "http://localhost:3000" }, noBrowser.impl)).rejects.toThrow(/playwright install chromium/);
  });
});

describe("what the failure says", () => {
  it("turns Playwright's words into something to act on", () => {
    expect(explain("Cannot find module 'playwright'")).toMatch(/npm i -D playwright/);
    expect(explain("browserType.launch: Executable doesn't exist")).toMatch(/install chromium/);
    expect(explain("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000")).toMatch(/is the server running/);
    expect(explain("Timeout 20000ms exceeded")).toMatch(/didn't finish loading/);
    expect(explain("")).toBe("the screenshot failed");
    // anything else is passed through rather than swallowed
    expect(explain("TypeError: something odd")).toContain("something odd");
  });
});
