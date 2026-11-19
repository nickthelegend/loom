import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { applyStarterTemplate, starterTemplates } from "../src/core/starter-templates.js";
import { validateConfigFile, validateProjectConfig } from "../src/core/config-validation.js";
import { expandAlias, readAliases, saveAlias } from "../src/core/aliases.js";
import { completionScript, completionWords } from "../src/cli/completions.js";
import { cycleView, formatScoreboard, paletteItems, renderTabs } from "../src/cli/tui-model.js";
import { modelScoreboard } from "../src/core/scoreboard.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

describe("2.1 starter templates", () => {
  it("creates every starter, including a runnable library test", () => {
    for (const t of starterTemplates()) {
      const dir = tmpDir(`r3-${t.name}`);
      applyStarterTemplate(dir, t.name);
      expect(fs.readdirSync(dir).length).toBeGreaterThan(1);
      if (t.name === "library") expect(execFileSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8" })).toContain("pass 1");
    }
  });
  it("rejects unknown templates, collisions and symlinks without overwriting or partial files", () => {
    const dir = tmpDir("r3-collision");
    fs.writeFileSync(path.join(dir, "main.js"), "keep");
    expect(() => applyStarterTemplate(dir, "web")).toThrow(/template could not be written/);
    expect(fs.readdirSync(dir)).toEqual(["main.js"]);
    expect(fs.readFileSync(path.join(dir, "main.js"), "utf8")).toBe("keep");
    expect(() => applyStarterTemplate(dir, "../../bad")).toThrow(/unknown template/);
    fs.symlinkSync(path.join(dir, "main.js"), path.join(dir, "index.html"));
    expect(() => applyStarterTemplate(dir, "web")).toThrow();
    expect(fs.readFileSync(path.join(dir, "main.js"), "utf8")).toBe("keep");
  });
});

describe("2.1 config validation", () => {
  it("reads the file, reports malformed JSON and missing files without changing them", () => {
    const dir = makeProjectDir();
    expect(validateConfigFile(dir).valid).toBe(true);
    const file = path.join(dir, ".loom/config.json");
    fs.writeFileSync(file, '{"agents":');
    expect(validateConfigFile(dir)).toMatchObject({ valid: false, errors: [{ path: "$" }] });
    expect(fs.readFileSync(file, "utf8")).toBe('{"agents":');
    fs.unlinkSync(file);
    expect(validateConfigFile(dir).valid).toBe(false);
  });
  it("explains nested types, duplicate ids, unknown kinds and unresolved routes", () => {
    const agent = { id: "a", kind: "echo", role: "worker" };
    const result = validateProjectConfig({ name: "p", agents: [agent, agent, { ...agent, id: "b", kind: "not-an-agent" }], defaultAgent: "missing", routes: { ship: ["nope"] } });
    expect(result.errors.map(e => e.path)).toEqual(["agents.1.id", "agents.2.kind", "defaultAgent", "routes.ship.0"]);
    expect(validateProjectConfig({ name: "p", agents: [], git: { commitPerTurn: "yes" } }).errors[0]?.path).toBe("git.commitPerTurn");
    expect(validateProjectConfig({ name: "p", agents: [], servers: [{ name: "web", command: "node app", port: 99999 }] }).valid).toBe(false);
    expect(validateProjectConfig({ name: "p", agents: [{ ...agent, model: "misplaced" }] }).warnings[0]).toContain("options.model");
    expect(validateProjectConfig(null).valid).toBe(false);
    expect(validateProjectConfig({ name: "p", agents: [], brane: {} }).valid).toBe(false);
  });
});

describe("2.1 aliases and completions", () => {
  it("persists literal argv, appends arguments, resolves aliases, and rejects cycles", () => {
    process.env.LOOM_HOME = tmpDir("r3-alias");
    saveAlias("review", ["send", "$(touch not-a-shell)", "two words"]);
    saveAlias("check", ["review", "--wait"]);
    expect(expandAlias(["check", "--json"], readAliases(), ["send"])).toEqual(["send", "$(touch not-a-shell)", "two words", "--wait", "--json"]);
    expect(() => saveAlias("review", ["check"])).toThrow(/cycle/);
    expect(readAliases().review?.[0]).toBe("send");
    expect(expandAlias(["send"], { send: ["bad"] }, ["send"])).toEqual(["send"]);
    expect(() => saveAlias("__proto__", ["send"])).toThrow();
    saveAlias("check"); expect(readAliases().check).toBeUndefined();
  });
  it("completes nested commands, command aliases and every registered short/long flag", () => {
    const p = new Command("loom");
    p.command("send").alias("say").option("-a, --agent <id>").option("--json");
    p.command("config").command("validate").option("--strict");
    expect(completionWords(p, [], ["review"])).toContain("review");
    expect(completionWords(p, ["say"])).toEqual(["--agent", "--help", "--json", "-a"]);
    expect(completionWords(p, ["config", "validate"])).toContain("--strict");
    for (const shell of ["bash", "zsh", "fish"]) expect(completionScript(shell)).toContain("completion candidates");
    expect(() => completionScript("bad")).toThrow();
  });
  it("generates executable Bash and Zsh completion functions with the right command context", () => {
    // each shell runs only where it's installed (CI's Linux images have no zsh; Windows has neither for real)
    const installed = (shell: string) => process.platform !== "win32" && (() => { try { execFileSync(shell, ["-c", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();
    for (const shell of ["bash", "zsh"].filter(installed)) {
      const script = completionScript(shell);
      const prefix = 'loom() { [ "$*" = "completion candidates -- send" ] || return 2; printf "%s\\n" --json --wait; }; compdef() { :; }; compadd() { printf "%s\\n" "$@"; };\n';
      const invoke = shell === "bash" ? 'COMP_WORDS=(loom send --j); COMP_CWORD=2; _loom; printf "%s\\n" "${COMPREPLY[@]}"' : 'words=(loom send --j); CURRENT=3; _loom';
      const out = execFileSync(shell, ["-c", prefix + script + "\n" + invoke], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(out).toContain("--json");
      if (shell === "bash") {
        const colonPrefix = prefix.replace("completion candidates -- send", "completion candidates -- agents:mode");
        const colon = execFileSync(shell, ["-c", colonPrefix + script + '\nCOMP_WORDS=(loom agents : mode --j); COMP_CWORD=4; _loom; printf "%s\\n" "${COMPREPLY[@]}"'], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        expect(colon).toContain("--json");
      }
    }
  });

});

it("opens a fifth TUI view and renders observed standings, empty data and unknown costs", () => {
  expect(cycleView("diff")).toBe("scoreboard");
  expect(cycleView("scoreboard")).toBe("orchestra");
  expect(cycleView("orchestra")).toBe("approvals");
  expect(cycleView("approvals")).toBe("thread");
  expect(renderTabs("scoreboard")).toContain("5 Scoreboard");
  expect(paletteItems([], [], null).find(p => p.id === "view:scoreboard")).toBeTruthy();
  const board = modelScoreboard([]);
  expect(formatScoreboard(board).join("\n")).toContain("Nothing recorded");
  const observed = modelScoreboard([{ id: "p", agents: [{ id: "a", kind: "echo", role: "worker" }], runs: [], events: [{ id: 1, ts: Date.now(), kind: "run_complete", agentId: "a", payload: { durationMs: 100 } }] }]);
  expect(formatScoreboard(observed).join("\n")).toContain("finishes 100%");
  expect(formatScoreboard(observed).join("\n")).toContain("per turn —");
});
