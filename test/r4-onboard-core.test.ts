import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerGuideStep } from "../src/core/help/provider.js";
import { readModelRouting } from "../src/core/model-routing-settings.js";
import { tmpDir } from "./helpers.js";
import { helpGuides, featureTours, whatsNew } from "../src/core/help/catalog.js";
import { projectReadiness, starterPrompts } from "../src/core/help/readiness.js";
import { applyExternalTemplate } from "../src/core/help/templates.js";
import { applyStarterTemplate, starterTemplates } from "../src/core/starter-templates.js";
import { examples, installExample } from "../src/core/help/examples.js";
import { listFleets, saveFleet } from "../src/core/fleets.js";
import { listRecipes } from "../src/core/recipes.js";
import { listPrompts, savePrompt } from "../src/core/prompts.js";
import { readTriggers } from "../src/core/triggers.js";
import { saveTutorialProgress, tutorialProgress } from "../src/core/help/tutorial.js";

beforeEach(() => { vi.stubEnv("LOOM_HOME", tmpDir("r4-core-home")); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("ships searchable guides and four actionable tours, and selects only the installed release", () => {
  expect(helpGuides().length).toBeGreaterThanOrEqual(9);
  expect(helpGuides("offline memory").some(g => g.id === "brain")).toBe(true);
  expect(helpGuides("../../etc/passwd")).toEqual([]);
  expect(featureTours.map(t => t.id)).toEqual(["orchestra", "brain", "triggers", "review"]);
  expect(featureTours.every(t => t.steps.length >= 2 && t.steps.every(s => s.body.length > 30))).toBe(true);
  expect(whatsNew("2.1.0").highlights.some(h => h.text.includes("#417"))).toBe(true);
  expect(whatsNew("2.1.0").highlights.some(h => h.text.includes("#449"))).toBe(false);
});
it("scores all five checks, previews additive fixes, and preserves existing instructions", async () => {
  const dir = tmpDir("r4-ready");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: { react: "1" } }));
  const before = await projectReadiness(dir);
  expect(before.score).toBe(40); expect(before.stack).toBe("React"); expect(before.draft).toContain("npm test");
  expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  const fixed = await projectReadiness(dir, true);
  expect(fixed.score).toBe(80); expect(fixed.applied).toHaveLength(2);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "custom instructions");
  expect((await projectReadiness(dir, true)).applied).toEqual([]);
  expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("custom instructions");
  execFileSync("git", ["init", "-q"], { cwd: dir }); execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: dir });
  expect((await projectReadiness(dir)).score).toBe(100);
  fs.writeFileSync(path.join(dir, "dirty.txt"), "changed");
  const starters = await starterPrompts(dir);
  expect(starters.prompts).toHaveLength(5); expect(starters.prompts[0]!.text).toContain("React");
  expect(starters.prompts[2]!.text).toContain("uncommitted");
});
it("does not follow readiness symlinks or count dependency directories as source", async () => {
  const dir = tmpDir("r4-ready-links"), outside = tmpDir("r4-outside");
  fs.writeFileSync(path.join(outside, "ignore"), "keep\n"); fs.symlinkSync(path.join(outside, "ignore"), path.join(dir, ".gitignore"));
  await expect(projectReadiness(dir, true)).rejects.toThrow("regular file");
  expect(fs.readFileSync(path.join(outside, "ignore"), "utf8")).toBe("keep\n");
  expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  fs.mkdirSync(path.join(dir, "node_modules")); fs.writeFileSync(path.join(dir, "node_modules", "large"), Buffer.alloc(1024));
  expect((await projectReadiness(dir)).checks.find(c => c.id === "size")?.ok).toBe(true);
});
it.each(["api", "cli", "static", "python"])("creates the %s starter and runs its own tests", name => {
  expect(starterTemplates().some(t => t.name === name)).toBe(true);
  const dir = tmpDir("r4-template"); applyStarterTemplate(dir, name);
  const output = name === "python" ? execFileSync("python3", ["-m", "unittest", "discover"], { cwd: dir, encoding: "utf8" }) : execFileSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8" });
  expect(typeof output).toBe("string");
  const files = fs.readdirSync(dir); expect(() => applyStarterTemplate(dir, name)).toThrow("template could not be written");
  expect(fs.readdirSync(dir)).toEqual(files);
});
it("copies nested directory and Git templates without metadata, secrets, overwrites or symlink escapes", async () => {
  const source = tmpDir("r4-template-source"), destination = tmpDir("r4-template-dest");
  fs.mkdirSync(path.join(source, "src")); fs.writeFileSync(path.join(source, "src", "index.js"), "export const value = 42;\n");
  fs.mkdirSync(path.join(source, ".loom")); fs.writeFileSync(path.join(source, ".loom", "config.json"), "secret"); fs.writeFileSync(path.join(source, ".env"), "secret");
  await applyExternalTemplate(destination, source);
  expect(fs.readFileSync(path.join(destination, "src", "index.js"), "utf8")).toContain("42");
  expect(fs.existsSync(path.join(destination, ".loom"))).toBe(false); expect(fs.existsSync(path.join(destination, ".env"))).toBe(false);
  fs.writeFileSync(path.join(source, "a-new"), "new");
  await expect(applyExternalTemplate(destination, source)).rejects.toThrow("overwrite");
  expect(fs.existsSync(path.join(destination, "a-new"))).toBe(false);
  execFileSync("git", ["init", "-q"], { cwd: source }); execFileSync("git", ["add", "src"], { cwd: source }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: source });
  const cloned = tmpDir("r4-template-clone"); await applyExternalTemplate(cloned, pathToFileURL(source).href);
  expect(fs.existsSync(path.join(cloned, "src", "index.js"))).toBe(true); expect(fs.existsSync(path.join(cloned, ".git"))).toBe(false);
  fs.symlinkSync("/tmp", path.join(source, "escape"));
  await expect(applyExternalTemplate(tmpDir("r4-template-symlink"), source)).rejects.toThrow("symlink");
  await expect(applyExternalTemplate(tmpDir("r4-template-badurl"), "ext::danger")).rejects.toThrow();
});
it("installs every example into existing stores idempotently without enabling a trigger or replacing user data", () => {
  const dir = tmpDir("r4-examples");
  for (const example of examples) {
    expect(installExample(example.name, dir).installed).toBe(true);
    expect(installExample(example.name, dir).installed).toBe(false);
  }
  expect(listRecipes().find(r => r.name === "small-change")!.steps).toHaveLength(3);
  expect(listPrompts().saved[0]!.text).toContain("{{component}}");
  expect(readTriggers(dir).triggers[0]).toMatchObject({ name: "daily-review", enabled: false, everyMin: 1440 });
  saveFleet("demo-team", "my-custom-agent"); installExample("demo-team"); expect(listFleets()[0]!.spec).toBe("my-custom-agent");
});
it("saves and resumes only recognized tutorial lessons", () => {
  expect(tutorialProgress()).toEqual({ completed: [] });
  saveTutorialProgress({ project: "demo", completed: ["send", "steer", "unknown"] });
  expect(tutorialProgress()).toEqual({ project: "demo", completed: ["send", "steer"] });
});

it("preserves a user's title when an example's prompt text is already saved", () => {
  savePrompt({ title: "My explanation", text: "Explain {{component}}, its callers and its tests. Do not edit files." });
  expect(installExample("explain-code").installed).toBe(false);
  expect(listPrompts().saved[0]!.title).toBe("My explanation");
});

it("qualifies provider model ids even when their own id starts with the provider name", async () => {
  vi.stubGlobal("fetch", async () => new Response('{"data":[{"id":"r4prefix/x"}]}', { headers: { "content-type": "application/json" } }));
  await providerGuideStep("key", { provider: "r4prefix", key: "fake", baseUrl: "http://fake.invalid" });
  await providerGuideStep("test", { provider: "r4prefix" });
  expect(await providerGuideStep("default", { provider: "r4prefix", model: "r4prefix/x" })).toMatchObject({ model: "r4prefix/r4prefix/x" });
  expect(readModelRouting().aliases.default).toBe("r4prefix/r4prefix/x");
});
