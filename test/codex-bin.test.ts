/**
 * Which codex Loom runs. OpenAI serves its newest models only to recent
 * clients, so of the app bundles and the one on PATH, the newest wins.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { codexBin, codexVersion, planFallback } from "../src/providers/codex/adapter.js";
import { tmpDir } from "./helpers.js";

const fake = (dir: string, version: string): string => {
  const p = path.join(dir, "codex");
  fs.writeFileSync(p, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  return p;
};

const oldPath = process.env.PATH;
afterEach(() => { process.env.PATH = oldPath; delete process.env.LOOM_CODEX_BIN; });

describe("the codex binary", () => {
  it("reads its version, alpha suffixes and all", () => {
    expect(codexVersion(fake(tmpDir("cxv"), "0.162.0-alpha.2"))).toEqual([0, 162, 0]);
    expect(codexVersion(path.join(tmpDir("cxv"), "nope"))).toBeNull();
  });

  it("an override wins, then LOOM_CODEX_BIN", () => {
    const a = fake(tmpDir("cxa"), "0.1.0"), b = fake(tmpDir("cxb"), "9.9.9");
    process.env.LOOM_CODEX_BIN = b;
    expect(codexBin(a)).toBe(a);
    expect(codexBin()).toBe(b);
    expect(codexBin(path.join(tmpDir("cxn"), "missing"))).toBeNull();
  });

  it("takes the newest of the app bundle and PATH", () => {
    const onPath = fake(tmpDir("cxp"), "99.0.0");
    process.env.PATH = `${path.dirname(onPath)}${path.delimiter}${oldPath}`;
    // newer than any bundled app on this machine, so PATH's wins here; with no bundle it's the only one
    expect(codexBin()).toBe(onPath);
  });
});

describe("a model this Codex doesn't list for the sign-in", () => {
  const list = [{ id: "gpt-6-astra", isDefault: true }, { id: "gpt-6-sol" }];
  it("falls back to the account's default, else the first listed; leaves listed models alone", () => {
    expect(planFallback("gpt-6.1-sol", list)).toBe("gpt-6-astra");
    expect(planFallback("gpt-6.1-sol", [{ id: "gpt-6-sol" }])).toBe("gpt-6-sol");
    expect(planFallback("gpt-6-sol", list)).toBeNull();
    expect(planFallback("gpt-6.1-sol", [])).toBeNull();
    expect(planFallback(undefined, list)).toBeNull();
  });
});
