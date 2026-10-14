import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSkillDir, findSkillDirs } from "../src/core/skill-install.js";
import { tmpDir } from "./helpers.js";

const skill = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\nbody\n"); };

describe("finding skills in a checkout", () => {
  it("finds the root, then children, then skills/<name> and .claude/skills/<name>", () => {
    const root = tmpDir("skdirs-root"); skill(root);
    expect(findSkillDirs(root)).toEqual([root]);

    const kids = tmpDir("skdirs-kids"); skill(path.join(kids, "b")); skill(path.join(kids, "a")); fs.mkdirSync(path.join(kids, "docs"));
    expect(findSkillDirs(kids).map((d) => path.basename(d))).toEqual(["a", "b"]);
    expect(findSkillDir(kids)).toBe(path.join(kids, "a"));

    const nested = tmpDir("skdirs-nested"); skill(path.join(nested, "skills", "pdf")); skill(path.join(nested, ".claude", "skills", "review"));
    expect(findSkillDirs(nested).map((d) => path.basename(d))).toEqual(["pdf", "review"]);

    expect(findSkillDirs(tmpDir("skdirs-none"))).toEqual([]);
  });
});
