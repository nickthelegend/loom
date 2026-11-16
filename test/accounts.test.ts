import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountKey, accountLogin, addAccount, configDirEnv, configDirPath, findAccount, listAccounts, removeAccount, resolveAgentAccount } from "../src/core/accounts.js";
import { expandWorkerSpecs } from "../src/core/orchestra.js";
import { createAgent } from "../src/adapters/index.js";
import { ClaudeCodeAdapter, stopAllProviderSessions } from "../src/providers/agent.js";
import { isAdapter, type AgentConfig } from "../src/types.js";
import { fakeClaude, fakeCodex } from "./native-fakes.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

beforeEach(() => { process.env.LOOM_HOME = tmpDir("accounts"); });
afterEach(async () => { await stopAllProviderSessions(); });

/** Record only the test's configuration path and marker, never the process environment. */
function recordEnv(bin: string, key: string): string {
  const file = path.join(path.dirname(bin), "selected.json");
  const source = fs.readFileSync(bin, "utf8");
  const newline = source.indexOf("\n");
  fs.writeFileSync(bin, source.slice(0, newline + 1) + `require("node:fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({dir:process.env[${JSON.stringify(key)}], marker:process.env.LOOM_ACCOUNT_TEST}));\n` + source.slice(newline + 1));
  return file;
}

describe("account metadata", () => {
  it("creates private directories, keeps only metadata, and forgets without deleting", () => {
    const account = addAccount({ kind: "codex", label: "work" });
    expect(account.configDir).toBe(path.join(process.env.LOOM_HOME!, "accounts", account.id));
    if (process.platform !== "win32") expect(fs.statSync(account.configDir).mode & 0o777).toBe(0o700);
    expect(findAccount("work", "codex")).toEqual(account);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.LOOM_HOME!, "accounts.json"), "utf8"))).toEqual({ accounts: [account] });
    const cfg = resolveAgentAccount({ id: "c", kind: "codex", role: "worker", account: "work" });
    expect(cfg).toMatchObject({ account: account.id, options: { configDir: account.configDir } });
    expect(removeAccount(account.id)).toBe(true);
    expect(listAccounts()).toEqual([]);
    expect(fs.existsSync(account.configDir)).toBe(true);
    expect(resolveAgentAccount(cfg)).toEqual(cfg);
    expect(removeAccount(account.id)).toBe(false);
  });

  it("validates kind, label, paths and duplicate entries", () => {
    expect(() => addAccount({ kind: "echo", label: "work" })).toThrow(/kind/);
    expect(() => addAccount({ kind: "codex", label: " " })).toThrow(/label/);
    for (const dir of ["relative", "", 1, "~someone/config", "/bad\0path"]) expect(() => configDirPath(dir)).toThrow(/absolute path/);
    expect(configDirPath("~/loom-account-test")).toBe(path.join(os.homedir(), "loom-account-test"));
    const a = addAccount({ kind: "codex", label: "work" });
    expect(() => addAccount({ kind: "codex", label: "work" })).toThrow(/label/);
    expect(() => addAccount({ kind: "codex", label: "other", configDir: a.configDir })).toThrow(/already registered/);
    expect(() => resolveAgentAccount({ id: "c", kind: "codex", role: "worker", account: "missing" })).toThrow(/unknown/);
    expect(() => resolveAgentAccount({ id: "e", kind: "echo", role: "worker", account: a.id })).toThrow(/requires/);
    expect(configDirEnv("grok-code", a.configDir)).toEqual({ GROK_HOME: a.configDir });
    expect(configDirEnv("opencode", a.configDir)).toEqual({ OPENCODE_CONFIG_DIR: a.configDir });
    expect(() => configDirEnv("antigravity-cli", a.configDir)).toThrow(/not supported/);
  });

  it("quotes terminal commands while keeping executable arguments literal", () => {
    const configDir = path.join(tmpDir("account-quotes"), "work's $(echo hi)");
    const a = addAccount({ kind: "codex", label: "work", configDir });
    expect(accountLogin(a)).toMatchObject({ bin: "codex", args: ["login"], env: { CODEX_HOME: configDir } });
    expect(accountLogin(a).command).toContain(process.platform === "win32" ? "work''s" : "work'\\''s");
  });
});

describe("provider process environments", () => {
  it("resolves a named Codex account and overrides only its home variable", async () => {
    const a = addAccount({ kind: "codex", label: "work" });
    const bin = fakeCodex();
    const recorded = recordEnv(bin, "CODEX_HOME");
    const agent = createAgent({ id: "c", kind: "codex", role: "worker", account: "work", options: {
      bin, env: { CODEX_HOME: tmpDir("wrong-account"), LOOM_ACCOUNT_TEST: "kept" },
    } }, makeProjectDir());
    expect(isAdapter(agent)).toBe(true);
    if (!isAdapter(agent)) throw new Error("expected adapter");
    try {
      await agent.send({ text: "fake turn" });
      expect(JSON.parse(fs.readFileSync(recorded, "utf8"))).toEqual({ dir: a.configDir, marker: "kept" });
    } finally { await agent.stop(); }
  });

  it("expands Claude's configDir and passes it through the SDK to the fake process", async () => {
    const bin = fakeClaude();
    const recorded = recordEnv(bin, "CLAUDE_CONFIG_DIR");
    const agent = new ClaudeCodeAdapter("fake", makeProjectDir(), { bin, configDir: "~/loom-account-test",
      env: { CLAUDE_CONFIG_DIR: tmpDir("wrong-account"), LOOM_ACCOUNT_TEST: "kept" } });
    try {
      await agent.send({ text: "fake turn" });
      expect(JSON.parse(fs.readFileSync(recorded, "utf8"))).toEqual({ dir: path.join(os.homedir(), "loom-account-test"), marker: "kept" });
    } finally { await agent.stop(); }
  });
});

describe("account fleets", () => {
  it("rotates across model rows, preserves options, and starts at an explicitly selected account", () => {
    const a = addAccount({ kind: "codex", label: "personal" });
    const b = addAccount({ kind: "codex", label: "work" });
    const base: AgentConfig = { id: "c", kind: "codex", role: "worker", options: { effort: "high", extraArgs: ["keep"] } };
    const workers = expandWorkerSpecs(["codexx2", "codex"], () => base);
    expect(workers.map(w => w.account)).toEqual([a.id, b.id, a.id]);
    expect(workers.map(w => w.id)).toEqual(["c", "c#2", "c#3"]);
    expect(workers.map(w => w.options?.configDir)).toEqual([a.configDir, b.configDir, a.configDir]);
    expect(workers.every(w => w.options?.effort === "high")).toBe(true);
    expect(base).not.toHaveProperty("account");
    const selected = expandWorkerSpecs(["codexx2"], () => ({ ...base, account: b.id }));
    expect(selected.map(w => w.account)).toEqual([b.id, a.id]);
    expect(expandWorkerSpecs(["codex", "codex"], () => ({ ...base, account: b.id })).map(w => w.account)).toEqual([b.id, a.id]);
    expect(accountKey(workers[0]!)).toBe(accountKey({ ...base, options: { configDir: a.configDir } }));
    expect(expandWorkerSpecs(["team:codexx2"], () => ({ ...base, id: "team:codex" })).every(w => !w.account)).toBe(true);
  });
});
