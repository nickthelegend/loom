/**
 * Your defaults for every project (~/.loom/defaults.json): which agents a project should have and
 * what access they get, applied by `loom init`. Field: a chain across 13 repos meant running
 * `loom init`, `loom agents:add grok-code` and `loom agents:mode … bypass` repo by repo first —
 * and one misplaced key there failed silently for hours.
 */

import fs from "node:fs";
import path from "node:path";
import { loomHome } from "./registry.js";
import { isPermissionMode, type PermissionMode } from "./permissions.js";
import type { AgentConfig } from "../types.js";

export interface UserDefaults {
  /** Agent kinds every project should have (added when installed here). */
  agents?: string[];
  /** Access for every agent that hasn't chosen its own. */
  mode?: PermissionMode;
  /** Per-kind access, over `mode`. */
  modes?: Record<string, PermissionMode>;
  /** Add .loom/ to .gitignore without asking. */
  gitignore?: boolean;
}

const file = () => path.join(loomHome(), "defaults.json");

export function readUserDefaults(): UserDefaults {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, unknown>;
    const d: UserDefaults = {};
    if (Array.isArray(raw.agents)) d.agents = raw.agents.map(String).filter(Boolean);
    if (isPermissionMode(raw.mode)) d.mode = raw.mode;
    if (raw.modes && typeof raw.modes === "object") {
      const modes = Object.entries(raw.modes as Record<string, unknown>).filter((e): e is [string, PermissionMode] => isPermissionMode(e[1]));
      if (modes.length) d.modes = Object.fromEntries(modes);
    }
    if (typeof raw.gitignore === "boolean") d.gitignore = raw.gitignore;
    return d;
  } catch {
    return {};
  }
}

export function writeUserDefaults(d: UserDefaults): void {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2) + "\n");
}

export interface DefaultsPlan {
  /** Kinds to add. */
  add: string[];
  /** Agents (existing, or about to be added — by kind) to give a mode. */
  modes: Array<{ id?: string; kind: string; mode: PermissionMode }>;
  /** Kinds named in the defaults that this machine can't drive. */
  missing: string[];
}

/**
 * What applying the defaults to a project would do. Additive only: it never removes an agent or
 * changes a mode someone set on one — an agent with options.permissions (or a top-level
 * "permissions") keeps it.
 */
export function planDefaults(agents: AgentConfig[], d: UserDefaults, installed: (kind: string) => boolean, hasModes: (kind: string) => boolean): DefaultsPlan {
  const plan: DefaultsPlan = { add: [], modes: [], missing: [] };
  const have = new Set(agents.map((a) => a.kind));
  for (const kind of d.agents ?? []) {
    if (have.has(kind)) continue;
    if (installed(kind)) plan.add.push(kind);
    else plan.missing.push(kind);
  }
  const want = (kind: string) => d.modes?.[kind] ?? d.mode;
  for (const a of agents) {
    const own = (a.options as { permissions?: unknown } | undefined)?.permissions ?? (a as { permissions?: unknown }).permissions;
    const mode = want(a.kind);
    if (mode && !isPermissionMode(own) && hasModes(a.kind)) plan.modes.push({ id: a.id, kind: a.kind, mode });
  }
  for (const kind of plan.add) {
    const mode = want(kind);
    if (mode && hasModes(kind)) plan.modes.push({ kind, mode });
  }
  return plan;
}
