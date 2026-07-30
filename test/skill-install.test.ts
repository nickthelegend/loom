/**
 * Skill discovery across every root, and installing one.
 *
 * Discovery is tested against a fixture ~/.claude rather than the developer's
 * real one (CLAUDE_CONFIG_DIR, which is Claude Code's own override) — a test
 * whose answer depends on which plugins the machine happens to have installed
 * isn't testing anything.
 *
 * The install half is mostly about refusals, because that is where the damage
 * lives: an id that escapes the project directory, an overwrite of something
 * the user wrote, a "git URL" that is actually a command.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findSkillDir,
  installSkillFromDir,
  installSkillFromGit,
  SkillInstallError,
} from "../src/core/skill-install.js";
import { discoverSkillRoots, loadSkills, pluginSkillRoots } from "../src/core/skills.js";
import { tmpDir } from "./helpers.js";

function writeSkill(dir: string, name: string, body = "do the thing"): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n${body}\n`);
  return dir;
}

const savedHome = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedHome;
});

describe("skill discovery", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    home = tmpDir("claude-home");
    projectDir = tmpDir("proj");
    process.env.CLAUDE_CONFIG_DIR = home;
  });

  it("finds a skill in each kind of root and labels where it came from", () => {
    writeSkill(path.join(projectDir, "skills", "proj-skill"), "proj-skill");
    writeSkill(path.join(projectDir, ".claude", "skills", "repo-skill"), "repo-skill");
    writeSkill(path.join(home, "skills", "user-skill"), "user-skill");
    // The versioned plugin layout, which is what a current Claude Code install
    // actually writes: cache/<marketplace>/<plugin>/<version>/skills/<id>.
    writeSkill(path.join(home, "plugins", "cache", "market", "plug", "1.2.0", "skills", "plugin-skill"), "plugin-skill");
    // …and the flat one, which older installs write.
    writeSkill(path.join(home, "plugins", "cache", "market", "flat", "skills", "flat-skill"), "flat-skill");
    const bundled = tmpDir("bundled");
    writeSkill(path.join(bundled, "bundled-skill"), "bundled-skill");

    const skills = loadSkills(discoverSkillRoots(projectDir, bundled));
    const origins = Object.fromEntries(skills.map((s) => [s.id, s.origin]));
    expect(origins).toEqual({
      "proj-skill": "project",
      "repo-skill": "project",
      "user-skill": "user",
      "plugin-skill": "plugin",
      "flat-skill": "plugin",
      "bundled-skill": "bundled",
    });
    expect(skills.find((s) => s.id === "user-skill")!.source).toBe(path.join(home, "skills"));
  });

  it("dedupes by id with the project root winning over the user's", () => {
    writeSkill(path.join(projectDir, "skills", "shared"), "shared", "PROJECT VERSION");
    writeSkill(path.join(home, "skills", "shared"), "shared", "USER VERSION");
    const skills = loadSkills(discoverSkillRoots(projectDir));
    expect(skills.filter((s) => s.id === "shared")).toHaveLength(1);
    expect(skills[0]!.body).toContain("PROJECT VERSION");
    expect(skills[0]!.origin).toBe("project");
  });

  it("skips roots that do not exist and plugin dirs with no skills", () => {
    fs.mkdirSync(path.join(home, "plugins", "cache", "empty-market", "empty-plugin"), { recursive: true });
    expect(pluginSkillRoots(home)).toEqual([]);
    expect(() => loadSkills(discoverSkillRoots(projectDir, "/no/such/bundled"))).not.toThrow();
    expect(loadSkills(discoverSkillRoots(projectDir))).toEqual([]);
  });

  it("does not list the same directory twice when the project is also the cwd root", () => {
    const own = path.join(projectDir, "skills");
    writeSkill(path.join(own, "only-one"), "only-one");
    const roots = discoverSkillRoots(projectDir, own);
    expect(roots.filter((r) => r.dir === own)).toHaveLength(1);
    expect(loadSkills(roots).map((s) => s.origin)).toEqual(["project"]);
  });
});

describe("installSkillFromDir", () => {
  let projectDir: string;
  let src: string;
  beforeEach(() => {
    projectDir = tmpDir("proj");
    src = writeSkill(path.join(tmpDir("src"), "my-skill"), "my-skill", "the real body");
  });

  it("copies the whole directory into <project>/skills/<id>", () => {
    fs.mkdirSync(path.join(src, "references"), { recursive: true });
    fs.writeFileSync(path.join(src, "references", "notes.md"), "attached file");

    const out = installSkillFromDir(src, projectDir);
    expect(out.id).toBe("my-skill");
    expect(out.name).toBe("my-skill");
    expect(out.from).toBe("dir");
    expect(out.replaced).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, "skills", "my-skill", "SKILL.md"), "utf8")).toContain("the real body");
    // The attachments come too — a skill whose instructions point at a missing
    // file is a skill that half works.
    expect(fs.readFileSync(path.join(projectDir, "skills", "my-skill", "references", "notes.md"), "utf8")).toBe("attached file");
  });

  it("refuses to overwrite an existing skill unless forced", () => {
    installSkillFromDir(src, projectDir);
    const other = writeSkill(path.join(tmpDir("src2"), "my-skill"), "my-skill", "replacement body");

    expect(() => installSkillFromDir(other, projectDir)).toThrow(SkillInstallError);
    expect(() => installSkillFromDir(other, projectDir)).toThrow(/already installed/);
    // …and the original is untouched by the refused install.
    expect(fs.readFileSync(path.join(projectDir, "skills", "my-skill", "SKILL.md"), "utf8")).toContain("the real body");

    const forced = installSkillFromDir(other, projectDir, { force: true });
    expect(forced.replaced).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, "skills", "my-skill", "SKILL.md"), "utf8")).toContain("replacement body");
  });

  it("rejects an id that would escape the project directory", () => {
    for (const bad of ["../escape", "..", "a/b", "/etc/passwd", ".hidden", "with space"]) {
      expect(() => installSkillFromDir(src, projectDir, { id: bad }), bad).toThrow(SkillInstallError);
    }
    // Nothing was written anywhere while those were being refused.
    expect(fs.existsSync(path.join(projectDir, "skills"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(projectDir), "escape"))).toBe(false);
  });

  it("refuses a directory that is not a skill, and a SKILL.md with no name", () => {
    const notASkill = tmpDir("empty");
    expect(() => installSkillFromDir(notASkill, projectDir)).toThrow(/no readable SKILL.md/);

    const nameless = path.join(tmpDir("nameless"), "nameless");
    fs.mkdirSync(nameless, { recursive: true });
    fs.writeFileSync(path.join(nameless, "SKILL.md"), "---\ndescription: no name here\n---\nbody");
    expect(() => installSkillFromDir(nameless, projectDir)).toThrow(/no `name:`/);

    expect(() => installSkillFromDir("/no/such/dir", projectDir)).toThrow(/does not exist/);
  });
});

describe("installSkillFromGit", () => {
  it("rejects anything that is not an http(s) or ssh git URL, without running git", async () => {
    const projectDir = tmpDir("proj");
    const bad = [
      "not a url",
      "file:///etc",
      "ext::sh -c 'touch /tmp/pwned'",
      "--upload-pack=touch /tmp/pwned",
      "/local/path/repo",
      "",
    ];
    for (const url of bad) {
      await expect(installSkillFromGit(url, projectDir), url).rejects.toThrow(SkillInstallError);
    }
    expect(fs.existsSync(path.join(projectDir, "skills"))).toBe(false);
  });

  it("accepts the real forms as far as the clone, and cleans up when it fails", async () => {
    const projectDir = tmpDir("proj");
    // A syntactically valid https remote that resolves to nothing: this gets
    // past the URL guard and fails at git, which is the boundary under test.
    // Bounded so a DNS black hole can't hang the suite.
    await expect(
      installSkillFromGit("https://127.0.0.1:1/loom-does-not-exist.git", projectDir, { timeoutMs: 10_000 }),
    ).rejects.toThrow(SkillInstallError);
    expect(fs.existsSync(path.join(projectDir, "skills"))).toBe(false);
  });

  // The clone itself needs a network and a remote, so the judgement it feeds —
  // where in a checkout the skill is — is tested on a directory that looks like
  // one. These are the two shapes people publish.
  it("finds SKILL.md at a checkout root, or one level down, and nowhere deeper", () => {
    const isSkill = tmpDir("repo-is-skill");
    writeSkill(isSkill, "whole-repo");
    expect(findSkillDir(isSkill)).toBe(isSkill);

    const holdsSkills = tmpDir("repo-holds-skills");
    fs.writeFileSync(path.join(holdsSkills, "README.md"), "a repo of skills");
    fs.mkdirSync(path.join(holdsSkills, ".github"), { recursive: true }); // dotdirs are skipped
    writeSkill(path.join(holdsSkills, "packaged-skill"), "packaged-skill");
    expect(findSkillDir(holdsSkills)).toBe(path.join(holdsSkills, "packaged-skill"));

    // Two levels down is ambiguous — a repo could hold several — so it is not
    // guessed at, and the caller reports that it found nothing.
    const tooDeep = tmpDir("repo-too-deep");
    writeSkill(path.join(tooDeep, "a", "b"), "buried");
    expect(findSkillDir(tooDeep)).toBeNull();
  });
});

/**
 * Authoring (#22): the scaffold is validated by the same parser the roster
 * reads with, so a skill this accepts is one the loader will actually offer.
 */
describe("authoring a skill", () => {
  it("scaffolds a loadable SKILL.md", async () => {
    const { authorSkill } = await import("../src/core/skill-install.js");
    const { loadSkills } = await import("../src/core/skills.js");
    const dir = tmpDir("author");
    const out = authorSkill(dir, {
      id: "Deploy Checklist!",
      name: "Deploy checklist",
      description: "Use before every production deploy",
    });
    // id sanitised to a directory-safe slug
    expect(out.dir.endsWith("skills/deploy-checklist")).toBe(true);

    const skills = loadSkills([path.join(dir, "skills")]);
    const mine = skills.find((s) => s.id === "deploy-checklist");
    expect(mine).toBeTruthy();
    expect(mine!.name).toBe("Deploy checklist");
    expect(mine!.description).toBe("Use before every production deploy");
  });

  it("refuses to overwrite an existing skill", async () => {
    const { authorSkill } = await import("../src/core/skill-install.js");
    const dir = tmpDir("author2");
    const input = { id: "one", name: "One", description: "d" };
    authorSkill(dir, input);
    expect(() => authorSkill(dir, input)).toThrow(/already exists/);
  });

  it("refuses the empty description that would make it undiscoverable", async () => {
    const { authorSkill } = await import("../src/core/skill-install.js");
    expect(() =>
      authorSkill(tmpDir("author3"), { id: "x", name: "X", description: "  " }),
    ).toThrow(/description/);
  });
});
