/**
 * The daemon must survive the faults that used to kill it.
 *
 * These run in a REAL child process, because that's the only place the
 * behaviour exists: Node's default for an unhandled rejection is to terminate,
 * and you can't observe "the process did not die" from inside the process that
 * would have died. Each case is run twice — with the guard and without — so the
 * test proves the guard is what makes the difference, not the harness.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GUARDS = fileURLToPath(new URL("../src/daemon/guards.ts", import.meta.url));
const tsx = path.resolve(fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)));

/** Run a snippet in its own process; report how it ended. */
function run(body: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      tsx,
      ["--eval", body],
      { timeout: 20_000, env: { ...process.env } },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as { code?: number }).code === "number"
            ? (err as { code?: number }).code!
            : err
              ? 1
              : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    child.stdin?.end();
  });
}

const REJECT = `
  Promise.reject(new Error("boom-from-an-adapter"));
  setTimeout(() => { console.log("STILL-ALIVE"); process.exit(0); }, 400);
`;
const THROW = `
  setTimeout(() => { throw new Error("boom-in-a-timer"); }, 10);
  setTimeout(() => { console.log("STILL-ALIVE"); process.exit(0); }, 400);
`;

describe("daemon crash guards", () => {
  it("an unhandled rejection kills an unguarded process (the bug)", async () => {
    const r = await run(REJECT);
    expect(r.stdout).not.toContain("STILL-ALIVE");
    expect(r.code).not.toBe(0);
  });

  it("...and the guard keeps it serving, with the reason written down", async () => {
    const r = await run(`import { installCrashGuards } from ${JSON.stringify(GUARDS)};
      installCrashGuards();
      ${REJECT}`);
    expect(r.stdout).toContain("STILL-ALIVE");
    expect(r.code).toBe(0);
    // it must not die *quietly* either — a silent survivor is its own bug
    expect(r.stderr).toContain("unhandled rejection");
    expect(r.stderr).toContain("boom-from-an-adapter");
  });

  it("an uncaught exception kills an unguarded process (the bug)", async () => {
    const r = await run(THROW);
    expect(r.stdout).not.toContain("STILL-ALIVE");
    expect(r.code).not.toBe(0);
  });

  it("...and the guard keeps it serving, with the stack written down", async () => {
    const r = await run(`import { installCrashGuards } from ${JSON.stringify(GUARDS)};
      installCrashGuards();
      ${THROW}`);
    expect(r.stdout).toContain("STILL-ALIVE");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("uncaught exception");
    expect(r.stderr).toContain("boom-in-a-timer");
  });
});
