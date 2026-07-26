/**
 * Skills: parsing SKILL.md, loading a skills dir, building the injection block,
 * and the keyword → skill suggestion matcher.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkillsBlock, loadSkills, parseSkillMd, suggestSkill, type SkillManifest } from "../src/core/skills.js";
import { tmpDir } from "./helpers.js";

function writeSkill(root: string, id: string, name: string, description: string, body: string): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: >\n  ${description}\n---\n\n${body}\n`);
}

describe("parseSkillMd", () => {
  it("reads name, a folded description, and the body", () => {
    const out = parseSkillMd("---\nname: my-skill\ndescription: >\n  line one\n  line two\n---\n\n# Body\ndo the thing");
    expect(out.name).toBe("my-skill");
    expect(out.description).toBe("line one line two");
    expect(out.body).toContain("do the thing");
  });
  it("handles a plain quoted description and no frontmatter", () => {
    expect(parseSkillMd(`---\nname: x\ndescription: "quick one"\n---\nbody`).description).toBe("quick one");
    expect(parseSkillMd("just a body").body).toBe("just a body");
  });
});

describe("loadSkills", () => {
  it("scans a dir for */SKILL.md and applies enabled state", () => {
    const root = tmpDir("skills");
    writeSkill(root, "alpha", "Alpha", "the alpha skill", "alpha body");
    writeSkill(root, "beta", "Beta", "the beta skill", "beta body");
    fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true }); // no SKILL.md → skipped
    const skills = loadSkills([root], { alpha: true });
    expect(skills.map((s) => s.id)).toEqual(["alpha", "beta"]);
    expect(skills.find((s) => s.id === "alpha")!.enabled).toBe(true);
    expect(skills.find((s) => s.id === "beta")!.enabled).toBe(false);
  });
  it("dedupes by id across roots (first root wins) and tolerates missing dirs", () => {
    const a = tmpDir("a"), b = tmpDir("b");
    writeSkill(a, "dup", "A", "from a", "A body");
    writeSkill(b, "dup", "B", "from b", "B body");
    writeSkill(b, "only-b", "OB", "b only", "OB body");
    const skills = loadSkills([a, b, "/no/such/dir"]);
    expect(skills.find((s) => s.id === "dup")!.body).toBe("A body");
    expect(skills.map((s) => s.id)).toContain("only-b");
  });
});

describe("buildSkillsBlock", () => {
  it("frames the enabled skills' bodies, and is empty when none are on", () => {
    const mk = (id: string, body: string, enabled: boolean): SkillManifest => ({ id, name: id, description: "", path: "", body, enabled, source: "", origin: "project" });
    const block = buildSkillsBlock([mk("a", "AAA", true), mk("b", "BBB", true), mk("c", "CCC", false)]);
    expect(block).toContain("ACTIVE SKILLS");
    expect(block).toContain("AAA");
    expect(block).toContain("BBB");
    expect(block).not.toContain("CCC");
    expect(buildSkillsBlock([mk("a", "AAA", false)])).toBe("");
  });
});

describe("suggestSkill", () => {
  const skills: SkillManifest[] = [
    { id: "signoz-agent-multi-agent-triage", name: "", description: "", path: "", body: "", enabled: false, source: "", origin: "project" },
    { id: "signoz-generating-queries", name: "", description: "", path: "", body: "", enabled: false, source: "", origin: "project" },
  ];
  it("suggests triage for a 'why is my agent failing' message", () => {
    expect(suggestSkill("why is my agent failing?", skills)!.id).toBe("signoz-agent-multi-agent-triage");
  });
  it("suggests the query skill for a ClickHouse/traces message", () => {
    expect(suggestSkill("show me the traces in clickhouse", skills)!.id).toBe("signoz-generating-queries");
  });
  it("returns null when nothing matches or the match is already enabled", () => {
    expect(suggestSkill("hello there", skills)).toBeNull();
    expect(suggestSkill("triage this", skills.map((s) => ({ ...s, enabled: true })))).toBeNull();
  });
});
