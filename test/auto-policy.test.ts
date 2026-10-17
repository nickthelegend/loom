/**
 * Loom's Auto policy (core/auto-policy.ts): an agent in Auto edits files and
 * runs commands inside the project — its tests included — and a refusal names
 * the rule that fired and the path or command it fired on.
 *
 * The cases are the REACH field test's (#244, #260): a project under a folder
 * with a space in its name, a .venv test runner, a sibling repo to read.
 */

import { describe, expect, it } from "vitest";
import { allowMatches, decideAuto, refusalText, shellWords, type AutoPolicy } from "../src/core/auto-policy.js";

const project = "/Volumes/Extreme SSD/Projects/wave1/reach-amazon";
const policy: AutoPolicy = { projectDir: project, readPaths: ["/Volumes/Extreme SSD/Projects/wave1/chatterbox-api"], allow: [".venv/bin/python -m pytest -q"] };
const bash = (command: string, p = policy) => decideAuto("Bash", { command }, p);

describe("shell words", () => {
  it("keeps quoted paths with spaces whole", () => {
    expect(shellWords(`cd "${project}" && git ls-files`)).toEqual(["cd", project, "&", "&", "git", "ls-files"]);
    expect(shellWords("ls /Volumes/Extreme\\ SSD/x 'a b'")).toEqual(["ls", "/Volumes/Extreme SSD/x", "a b"]);
  });
});

describe("Auto runs the project's own commands (#260)", () => {
  it("executes inside the project: the .venv python, pytest, npm test", () => {
    expect(bash(".venv/bin/python --version")).toEqual({ allow: true });
    expect(bash("./.venv/bin/pytest -q")).toEqual({ allow: true });
    expect(bash("npm test -- --run")).toEqual({ allow: true });
    expect(bash("git status && git diff --stat")).toEqual({ allow: true });
  });

  it("an absolute in-project path with a space in it is inside the project (#244)", () => {
    expect(bash(`cd "${project}" && git ls-files | head -50`)).toEqual({ allow: true });
    expect(bash(`ls "${project}/src"`)).toEqual({ allow: true });
    expect(bash(`cat ${project.replace(/ /g, "\\ ")}/README.md`)).toEqual({ allow: true });
  });

  it("the allowlist and the project's test command always run", () => {
    expect(bash(".venv/bin/python -m pytest -q tests/test_tts.py")).toMatchObject({ allow: true, rule: "permissions.allow" });
    expect(bash("docker compose up -d", { ...policy, allow: ["docker compose"] })).toMatchObject({ allow: true });
  });
});

describe("and refuses what leaves it, naming the rule and the path", () => {
  it("a path outside the project", () => {
    const d = bash("cat /Users/me/.ssh/id_rsa");
    expect(d).toMatchObject({ allow: false, rule: "a path outside the project" });
    expect(refusalText(d as never)).toMatch(/refused a path outside the project: `\/Users\/me\/\.ssh\/id_rsa` resolves to \/Users\/me\/\.ssh\/id_rsa/);
    expect(bash("cd /etc && ls")).toMatchObject({ allow: false, rule: "a command run outside the project", detail: "it changes directory to /etc" });
    expect(bash("ls ../other-project")).toMatchObject({ allow: false, rule: "a path outside the project" });
  });

  it("a sibling in readPaths can be read, never written (#255)", () => {
    expect(bash("ls ../chatterbox-api")).toEqual({ allow: true });
    expect(decideAuto("Read", { file_path: "/Volumes/Extreme SSD/Projects/wave1/chatterbox-api/app.py" }, policy)).toEqual({ allow: true });
    expect(decideAuto("Edit", { file_path: "/Volumes/Extreme SSD/Projects/wave1/chatterbox-api/app.py" }, policy))
      .toMatchObject({ allow: false, rule: "a write to a read-only path" });
    expect(decideAuto("Read", { file_path: "/etc/passwd" }, policy)).toMatchObject({ allow: false, rule: "a read outside the project" });
    expect(decideAuto("Write", { file_path: `${project}/src/new.py` }, policy)).toEqual({ allow: true });
  });

  it("a command that can't be taken back, even if allowed by name", () => {
    expect(bash("git push --force origin main")).toMatchObject({ allow: false, rule: "a command that can't be taken back (a force-push)" });
    expect(bash("git push --force origin main", { ...policy, allow: ["git push"] })).toMatchObject({ allow: false });
  });

  it("system tools, temp and devices aren't 'outside'", () => {
    expect(bash("/usr/bin/env python3 -c 1")).toEqual({ allow: true });
    expect(bash("python3 script.py > /dev/null 2>&1")).toEqual({ allow: true });
    expect(bash("curl -s https://example.com/api")).toEqual({ allow: true });
  });

  it("MCP tools need allowing; subagents and web reads don't", () => {
    expect(decideAuto("mcp__github__create_issue", {}, policy)).toMatchObject({ allow: false, rule: "an MCP tool nobody allowed" });
    expect(decideAuto("mcp__github__create_issue", {}, { ...policy, allow: ["mcp__github__*"] })).toEqual({ allow: true });
    expect(decideAuto("Task", { prompt: "run the tests" }, policy)).toEqual({ allow: true });
    expect(decideAuto("WebFetch", { url: "https://docs.x" }, policy)).toEqual({ allow: true });
  });
});

describe("allow patterns", () => {
  it("a prefix on a word boundary, or a glob", () => {
    expect(allowMatches("npm test", "npm test -- --run")).toBe(true);
    expect(allowMatches("npm test", "npm testify")).toBe(false);
    expect(allowMatches("mcp__github__*", "mcp__github__list")).toBe(true);
  });
});
