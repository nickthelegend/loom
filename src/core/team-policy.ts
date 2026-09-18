/**
 * Loom Teams, Phase 2 — `loom.team.json`, the team's policy as code.
 *
 * D37: it's read from the default branch on origin (`git show origin/HEAD:…`),
 * so changing policy takes a reviewed PR; a local copy may only make rules
 * STRICTER. D38: it enforces hard zones, a permission ceiling, an agent
 * allowlist, protected-branch delivery and concurrency caps. D39: changes apply
 * to new actions only — callers check policy at the moment they act.
 *
 *   {
 *     "hardZones": ["db/migrations/**", "package-lock.json"],
 *     "permissions": { "ceiling": "auto", "bypassRequiresPlan": true },
 *     "agents": { "allow": ["claude-code", "codex", "antigravity-cli"] },
 *     "delivery": { "protected": ["main", "release/*"] },
 *     "orchestra": { "maxParallelPerMember": 6, "teamMaxConcurrentAgents": 20 }
 *   }
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { PermissionMode } from "./permissions.js";
import { globToRegExp } from "./team-leases.js";

export interface TeamPolicy {
  hardZones: string[];
  permissions: { ceiling: PermissionMode; bypassRequiresPlan: boolean };
  agents: { allow: string[] | null }; // null = any agent
  delivery: { protected: string[] };
  orchestra: { maxParallelPerMember: number | null; teamMaxConcurrentAgents: number | null };
}

export const OPEN_POLICY: TeamPolicy = {
  hardZones: [],
  permissions: { ceiling: "bypass", bypassRequiresPlan: false },
  agents: { allow: null },
  delivery: { protected: [] },
  orchestra: { maxParallelPerMember: null, teamMaxConcurrentAgents: null },
};

const RANK: Record<PermissionMode, number> = { ask: 0, auto: 1, bypass: 2 };

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 200) : [];
}

function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a policy file leniently: unknown keys ignored, bad values fall back to open. */
export function parsePolicy(raw: unknown): TeamPolicy {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | unknown>;
  const perm = (o.permissions ?? {}) as Record<string, unknown>;
  const ceiling = ["ask", "auto", "bypass"].includes(String(perm.ceiling)) ? (perm.ceiling as PermissionMode) : "bypass";
  const agents = (o.agents ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(agents.allow) ? strs(agents.allow) : null;
  const orch = (o.orchestra ?? {}) as Record<string, unknown>;
  const del = (o.delivery ?? {}) as Record<string, unknown>;
  return {
    hardZones: strs(o.hardZones),
    permissions: { ceiling, bypassRequiresPlan: perm.bypassRequiresPlan === true },
    agents: { allow },
    delivery: { protected: strs(del.protected) },
    orchestra: {
      maxParallelPerMember: posInt(orch.maxParallelPerMember),
      teamMaxConcurrentAgents: posInt(orch.teamMaxConcurrentAgents),
    },
  };
}

/**
 * Combine the reviewed policy with a local one so the local copy can only
 * tighten: more hard zones, a lower ceiling, a narrower allowlist, more
 * protected branches, smaller caps.
 */
export function stricter(base: TeamPolicy, local: TeamPolicy): TeamPolicy {
  const minN = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
  const allow =
    base.agents.allow === null ? local.agents.allow : local.agents.allow === null ? base.agents.allow
      : base.agents.allow.filter((x) => local.agents.allow!.includes(x));
  return {
    hardZones: [...new Set([...base.hardZones, ...local.hardZones])],
    permissions: {
      ceiling: RANK[local.permissions.ceiling] < RANK[base.permissions.ceiling] ? local.permissions.ceiling : base.permissions.ceiling,
      bypassRequiresPlan: base.permissions.bypassRequiresPlan || local.permissions.bypassRequiresPlan,
    },
    agents: { allow },
    delivery: { protected: [...new Set([...base.delivery.protected, ...local.delivery.protected])] },
    orchestra: {
      maxParallelPerMember: minN(base.orchestra.maxParallelPerMember, local.orchestra.maxParallelPerMember),
      teamMaxConcurrentAgents: minN(base.orchestra.teamMaxConcurrentAgents, local.orchestra.teamMaxConcurrentAgents),
    },
  };
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 15_000 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out)));
  });
}

/**
 * The effective policy for a repo: origin's default branch, tightened by any
 * local working-copy file. No file anywhere → the open policy.
 */
export async function loadPolicy(repoDir: string): Promise<TeamPolicy & { source: "origin" | "local" | "none" }> {
  let base: TeamPolicy | null = null;
  const head = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoDir).catch(() => "")).trim() || "origin/main";
  const text = await git(["show", `${head}:loom.team.json`], repoDir).catch(() => "");
  if (text) {
    try {
      base = parsePolicy(JSON.parse(text));
    } catch {
      base = null; // a broken policy file on main is a review failure; fall through to open
    }
  }
  let local: TeamPolicy | null = null;
  try {
    local = parsePolicy(JSON.parse(fs.readFileSync(path.join(repoDir, "loom.team.json"), "utf8")));
  } catch {
    local = null;
  }
  if (base && local) return { ...stricter(base, local), source: "origin" };
  if (base) return { ...base, source: "origin" };
  // A local-only file can't loosen anything (there's nothing to loosen), so it applies as-is.
  if (local) return { ...stricter(OPEN_POLICY, local), source: "local" };
  return { ...OPEN_POLICY, source: "none" };
}

/** The permission mode an agent actually gets under this policy (D38). */
export function cappedPermission(policy: TeamPolicy, wanted: PermissionMode, planMode: boolean): PermissionMode {
  let mode = RANK[wanted] > RANK[policy.permissions.ceiling] ? policy.permissions.ceiling : wanted;
  if (mode === "bypass" && policy.permissions.bypassRequiresPlan && !planMode) mode = "auto";
  return mode;
}

export function agentAllowed(policy: TeamPolicy, kind: string): boolean {
  return policy.agents.allow === null || policy.agents.allow.includes(kind);
}

export function isProtected(policy: TeamPolicy, branch: string): boolean {
  return policy.delivery.protected.some((p) => globToRegExp(p).test(branch));
}
