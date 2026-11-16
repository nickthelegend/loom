import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureLoomHome, loomHome } from "./registry.js";
import type { AgentConfig } from "../types.js";

export type AccountKind = "claude-code" | "codex";
/** Machine-local metadata only. Loom never opens files inside configDir. */
export interface Account {
  id: string;
  kind: AccountKind;
  label: string;
  configDir: string;
}
/** null means the CLI could not establish sign-in status. */
export interface AccountStatus extends Account { authed: boolean | null }

export function configDirPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("configDir must be an absolute path");
  const expanded = value === "~" ? os.homedir() : /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error("configDir must be an absolute path (or start with ~/)");
  return path.normalize(expanded);
}

const file = () => path.join(loomHome(), "accounts.json");
export function listAccounts(): Account[] {
  if (!fs.existsSync(file())) return [];
  const data = JSON.parse(fs.readFileSync(file(), "utf8")) as { accounts: Account[] };
  if (!Array.isArray(data.accounts)) throw new Error("invalid accounts registry");
  return data.accounts.map(a => {
    if (!a || typeof a.id !== "string" || typeof a.label !== "string" || !isAccountKind(a.kind)) throw new Error("invalid account entry");
    return { id: a.id, kind: a.kind, label: a.label, configDir: configDirPath(a.configDir) };
  });
}
function saveAccounts(accounts: Account[]): void {
  ensureLoomHome();
  const temp = `${file()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file());
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function isAccountKind(kind: unknown): kind is AccountKind { return kind === "claude-code" || kind === "codex"; }

export function addAccount(input: { kind: unknown; label: unknown; configDir?: unknown }): Account {
  if (!isAccountKind(input.kind)) throw new Error("account kind must be claude-code or codex");
  if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 100 || /[\r\n\0]/.test(input.label)) throw new Error("label must be a nonempty string of at most 100 characters");
  const accounts = listAccounts();
  const id = randomUUID();
  const label = input.label.trim();
  const configDir = configDirPath(input.configDir === undefined ? path.resolve(loomHome(), "accounts", id) : input.configDir);
  if (accounts.some(a => a.kind === input.kind && a.label === label)) throw new Error("an account of this kind already has that label");
  if (accounts.some(a => a.kind === input.kind && a.configDir === configDir)) throw new Error("this configDir is already registered for that kind");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const account: Account = { id, kind: input.kind, label, configDir };
  saveAccounts([...accounts, account]);
  return account;
}
/** Remove metadata only; the CLI owns its configuration directory. */
export function removeAccount(id: string): boolean {
  const accounts = listAccounts();
  if (!accounts.some(a => a.id === id)) return false;
  saveAccounts(accounts.filter(a => a.id !== id));
  return true;
}
export function findAccount(idOrLabel: string, kind?: string): Account | undefined {
  const accounts = listAccounts().filter(a => !kind || a.kind === kind);
  const exact = accounts.find(a => a.id === idOrLabel);
  if (exact) return exact;
  const matches = accounts.filter(a => a.label === idOrLabel);
  if (matches.length > 1) throw new Error(`ambiguous account label "${idOrLabel}"; use its id`);
  return matches[0];
}

const CONFIG_ENV: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME",
  // https://docs.x.ai/build/settings and https://github.com/anomalyco/opencode/issues/63129
  "grok-code": "GROK_HOME", opencode: "OPENCODE_CONFIG_DIR",
};
/** Explicit configDir wins over the same key in options.env; other env values survive. */
export function configDirEnv(kind: string, configDir?: unknown): Record<string, string> {
  if (configDir === undefined) return {};
  const dir = configDirPath(configDir);
  const key = CONFIG_ENV[kind];
  if (!key) throw new Error(`configDir is not supported for ${kind}`);
  return { [key]: dir };
}

/** Persist a resolved path so forgetting a registry entry cannot silently change an agent's login. */
export function resolveAgentAccount(cfg: AgentConfig): AgentConfig {
  let configDir = cfg.options?.configDir;
  let account = cfg.account;
  if (account !== undefined) {
    if (typeof account !== "string" || !account || !isAccountKind(cfg.kind)) throw new Error("account requires a claude-code or codex account id or label");
    const selected = findAccount(account, cfg.kind);
    if (!selected && configDir === undefined) throw new Error(`unknown ${cfg.kind} account "${account}"`);
    if (selected) { account = selected.id; configDir = selected.configDir; }
  }
  if (configDir === undefined) return cfg;
  configDirEnv(cfg.kind, configDir);
  return { ...cfg, ...(account ? { account } : {}), options: { ...cfg.options, configDir: configDirPath(configDir) } };
}

/** Quota belongs to the config home, even when several instances or labels point there. */
export function accountKey(cfg: AgentConfig): string {
  const key = CONFIG_ENV[cfg.kind];
  const env = cfg.options?.env as Record<string, string> | undefined;
  const selected = cfg.account ? findAccount(cfg.account, cfg.kind) : undefined;
  const dir = selected?.configDir ?? cfg.options?.configDir ?? (key ? env?.[key] ?? process.env[key] : undefined);
  const fallback = cfg.kind === "codex" ? path.join(os.homedir(), ".codex") : cfg.kind === "claude-code" ? path.join(os.homedir(), ".claude") : "default";
  return `${cfg.kind}:${dir === undefined ? fallback : configDirPath(dir)}`;
}

/** The daemon returns a display command; the CLI executes bin/args/env directly, without a shell. */
export interface AccountLogin { command: string; bin: string; args: string[]; env: Record<string, string> }
export function accountLogin(account: Account): AccountLogin {
  const bin = account.kind === "codex" ? "codex" : "claude";
  const args = account.kind === "codex" ? ["login"] : ["auth", "login"];
  const env = configDirEnv(account.kind, account.configDir);
  const [key, value] = Object.entries(env)[0]!;
  const quote = (s: string) => `'${s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = process.platform === "win32"
    ? `$env:${key}=${quote(value)}; ${bin} ${args.join(" ")}`
    : `${key}=${quote(value)} ${bin} ${args.join(" ")}`;
  return { command, bin, args, env };
}
