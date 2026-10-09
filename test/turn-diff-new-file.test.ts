/** A file a turn creates counts in its diff: "+3", not "+0 −0", with the lines shown as additions. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { diffSinceSnapshot, porcelainStatus } from "../src/core/worktree.js";
import { tmpDir } from "./helpers.js";

describe("a turn's diff", () => {
  it("counts and shows a new file's lines, and notes a binary one", async () => {
    const dir = tmpDir("turn-diff-new");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
    git("init", "-q"); fs.writeFileSync(path.join(dir, "a.txt"), "a\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
    const before = await porcelainStatus(dir);
    fs.mkdirSync(path.join(dir, "demo"));
    fs.writeFileSync(path.join(dir, "demo", "hello.html"), "<h1>Hi</h1>\n<p>x</p>\n<p>y</p>\n");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const d = (await diffSinceSnapshot(dir, before))!;
    expect(d.added).toBe(3);
    expect(d.patch).toContain("+++ b/demo/hello.html");
    expect(d.patch).toContain("+<h1>Hi</h1>");
    expect(d.patch).toContain("blob.bin (binary)");
  });
});
