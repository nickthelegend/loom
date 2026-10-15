/**
 * Review Triage: a turn's diff, ranked by what to read first — and the
 * turn card carries it, so the thread (and the phone) can say where to look.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { splitPatch, triage } from "../src/core/review-triage.js";
import { writeProjectConfig } from "../src/core/registry.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

const file = (p: string, added: string[] = [], removed: string[] = [], extra = "") =>
  [`diff --git a/${p} b/${p}`, extra, `--- a/${p}`, `+++ b/${p}`, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].filter(Boolean).join("\n");
const at = (t: ReturnType<typeof triage>, p: string) => t.files.find((f) => f.path === p)!;

describe("reading a patch", () => {
  it("splits git's diff and Loom's new-file notes into files", () => {
    const patch = [file("a.ts", ["x"], ["y"]), file("gone.ts", [], ["z"], "deleted file mode 100644"), "?? new file: logo.png (binary)"].join("\n");
    expect(splitPatch(patch)).toEqual([
      { path: "a.ts", added: ["x"], removed: ["y"], deleted: false, created: false },
      { path: "gone.ts", added: [], removed: ["z"], deleted: true, created: false },
      { path: "logo.png", added: [], removed: [], deleted: false, created: true },
    ]);
  });
});

describe("what to read first", () => {
  it("a secret beats everything, and a lockfile is skimmed", () => {
    const t = triage([
      file("package-lock.json", Array(400).fill('"x": "1"')),
      file("src/config.ts", ['export const key = "sk-proj-abcdefghijklmnopqrstuvwx";']),
      file("README.md", ["more words"]),
    ].join("\n"));
    expect(t.files.map((f) => f.path)).toEqual(["src/config.ts", "package-lock.json", "README.md"]);
    expect(at(t, "src/config.ts")).toMatchObject({ level: "high", reasons: ["adds what looks like a secret key"] });
    expect(at(t, "package-lock.json")).toMatchObject({ level: "low", reasons: ["generated or a lockfile: skim it"] });
  });

  it("a deleted, skipped or hollowed-out test is flagged — the diff says so, without guessing why", () => {
    const t = triage([
      file("test/auth.test.ts", [], ["it('rejects a bad token', () => {", "  expect(check('x')).toBe(false);", "});"], "deleted file mode 100644"),
      file("test/add.test.ts", ["it.skip('adds', () => {"], ["it('adds', () => {"]),
      file("test/math.test.ts", ["// TODO"], ["  expect(a).toBe(1);", "  expect(b).toBe(2);", "  expect(c).toBe(3);"]),
    ].join("\n"));
    expect(at(t, "test/auth.test.ts")).toMatchObject({ level: "high", reasons: ["deletes a test file"] });
    expect(at(t, "test/add.test.ts")).toMatchObject({ level: "high", reasons: ["skips or focuses a test"] });
    expect(at(t, "test/math.test.ts").reasons).toEqual(["removes 3 test assertions or cases"]);
    expect(t.flagged).toBe(3);
  });

  it("auth code, migrations, CI and new dependencies each get their reason", () => {
    const t = triage([
      file("src/middleware/auth.ts", ["if (!user) return next();"], ["if (!user) return deny();"]),
      file("db/migrations/0042_drop_col.sql", ["ALTER TABLE users DROP COLUMN email;"]),
      file(".github/workflows/ci.yml", ["      - run: npm test || true"], ["      - run: npm test"]),
      file("package.json", ['    "left-pad": "^1.3.0",']),
      file("src/util.ts", ["export const a = 1;"]),
    ].join("\n"));
    expect(at(t, "src/middleware/auth.ts").reasons).toContain("touches auth or security code");
    expect(at(t, "db/migrations/0042_drop_col.sql").reasons).toContain("changes the database schema or a migration");
    expect(at(t, ".github/workflows/ci.yml").reasons).toContain("changes CI, build or deploy");
    expect(at(t, "package.json").reasons).toContain("adds or changes dependencies");
    expect(at(t, "src/util.ts")).toMatchObject({ level: "low", reasons: [] });
    expect(t.files.at(-1)!.path).toBe("src/util.ts");
  });

  it("risky calls in added lines, not removed ones", () => {
    const t = triage([
      file("src/run.ts", ["import { execSync } from 'node:child_process';", "execSync(`rm -rf ${dir}`);"]),
      file("src/old.ts", ["const x = 1;"], ["eval(code);"]),
      file("src/page.tsx", ["<div dangerouslySetInnerHTML={{ __html: body }} />"]),
      file("src/fetch.ts", ["const agent = new https.Agent({ rejectUnauthorized: false });"]),
      file("src/quiet.ts", ["// @ts-ignore", "broken();"]),
    ].join("\n"));
    expect(at(t, "src/run.ts").reasons).toEqual(expect.arrayContaining(["adds running shell commands", "adds a destructive command"]));
    expect(at(t, "src/old.ts").reasons).toEqual([]);
    expect(at(t, "src/page.tsx").reasons).toEqual(["adds raw HTML injection"]);
    expect(at(t, "src/fetch.ts").reasons).toEqual(["adds TLS checks turned off"]);
    expect(at(t, "src/quiet.ts").reasons).toEqual(["adds a check silenced"]);
  });

  it("a big change with no test touched says so; with a test touched, it doesn't", () => {
    const big = file("src/engine.ts", Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`));
    expect(at(triage(big), "src/engine.ts")).toMatchObject({ level: "medium", reasons: ["30 lines changed and no test was touched this turn"] });
    expect(at(triage([big, file("src/engine.test.ts", ["it('works', () => {});"])].join("\n")), "src/engine.ts").reasons).toEqual([]);
  });

  it("a file git saw but the patch doesn't show (truncated, binary) is still listed", () => {
    const t = triage(file("a.ts", ["x"]), [{ path: "a.ts", status: " M" }, { path: "src/auth/keys.bin", status: " M" }]);
    expect(t.files.map((f) => f.path)).toContain("src/auth/keys.bin");
    expect(at(t, "src/auth/keys.bin").reasons).toContain("touches auth or security code");
  });
});

let rt: ProjectRuntime | undefined;
afterEach(async () => { await rt?.close(); rt = undefined; });
beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-triage");
  process.env.LOOM_NO_NOTIFY = "1";
});

describe("on a turn", () => {
  it("the turn card carries the triage, the file to read first at the top", async () => {
    const dir = tmpDir("triage-proj");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, ".gitignore"), ".loom/\n");
    fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "auth", "session.ts"), "export const ttl = 60;\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
    writeProjectConfig(dir, { name: "triage", agents: [{ id: "echo", kind: "echo" }], brain: { extractor: "off" } });
    rt = await ProjectRuntime.open({ id: `triage-${path.basename(dir)}`, name: "triage", dir });
    // echo writes notes.txt; the auth file changes during the same turn
    const sent = rt.sendMessage("write:notes.txt sleep:200");
    await new Promise((r) => setTimeout(r, 80));
    fs.writeFileSync(path.join(dir, "src", "auth", "session.ts"), "export const ttl = 6000000;\n");
    await sent;
    await waitUntil(() => rt!.log.list({ kinds: ["turn_diff"] }).length === 1);
    const card = rt.log.list({ kinds: ["turn_diff"] })[0]!.payload as { triage: Array<{ path: string; level: string; reasons: string[] }> };
    expect(card.triage[0]).toEqual({ path: "src/auth/session.ts", level: "medium", reasons: ["touches auth or security code"] });
    expect(card.triage.map((f) => f.path)).toContain("notes.txt");
  });
});
