import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureLoomHome, loomHome } from "./registry.js";

export type CommandAliases = Record<string, string[]>;
export function readAliases(): CommandAliases {
  const file = path.join(loomHome(), "aliases.json");
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("aliases.json must be an object");
  for (const [name, args] of Object.entries(value)) checkAlias(name, args);
  return value;
}
export function checkAlias(name: unknown, args: unknown): asserts args is string[] {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) throw new Error("alias name must start with a letter and contain only lowercase letters, digits and hyphens");
  if (!Array.isArray(args) || !args.length || args.some(a => typeof a !== "string" || a.includes("\0")) || !args[0] || args[0].startsWith("-")) throw new Error("alias must contain a command and optional argument strings");
}
export function expandAlias(args: string[], aliases: CommandAliases, commands: string[]): string[] {
  const seen = new Set<string>();
  while (args[0] && !commands.includes(args[0]) && Object.hasOwn(aliases, args[0])) {
    const name = args[0];
    if (seen.has(name)) throw new Error(`alias cycle at "${name}"`);
    seen.add(name);
    args = [...aliases[name]!, ...args.slice(1)];
  }
  return args;
}
export function saveAlias(name: string, args?: string[]): CommandAliases {
  checkAlias(name, args ?? ["remove"]);
  const aliases = readAliases();
  if (args) aliases[name] = args;
  else if (!Object.hasOwn(aliases, name)) throw new Error(`unknown alias "${name}"`);
  else delete aliases[name];
  for (const key of Object.keys(aliases)) expandAlias([key], aliases, []);
  const file = path.join(ensureLoomHome(), "aliases.json"), tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(aliases, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return aliases;
}
