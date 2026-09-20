/**
 * Permission modes — one dropdown, five CLIs with five different vocabularies.
 *
 * Every agent Loom drives has its own idea of "may I?": Claude has permission
 * modes and a prompt tool, Codex has sandboxes, Antigravity has execution
 * modes and a skip flag, Grok has permission modes, OpenCode has an approve
 * switch. Loom offers three words and maps them per agent:
 *
 *   bypass — do anything, never ask. What headless orchestration usually needs
 *            (Agent Orchestrator users hit this with Antigravity: without its
 *            skip flag set explicitly, a headless turn stalls on a prompt
 *            nobody can answer).
 *   auto   — edit files freely; the agent's own guardrails decide the rest.
 *   ask    — nothing changes without you. Where the agent supports routing a
 *            permission prompt to a tool (Claude Code), each request appears
 *            in Loom as an approval you allow or deny. Where it doesn't, "ask"
 *            is the agent's read-only / plan mode — it proposes, it doesn't
 *            touch — and the UI says which of the two you're getting.
 *
 * The mapping is data, here, so the dropdown, the adapters and the docs read
 * the same table. Every cell was run against the real CLI with
 * scripts/verify-permissions.mjs (2026-09-18: claude 2.1.276, codex 0.155.0,
 * agy 1.2.6, grok 0.2.103, opencode 1.18.31); cells that failed are marked
 * `unsupported` with what was observed.
 */

export type PermissionMode = "bypass" | "auto" | "ask";
export const PERMISSION_MODES: PermissionMode[] = ["bypass", "auto", "ask"];

export interface PermissionCell {
  /** What the agent is actually run with, in its own words. */
  flags: string;
  /** One line for the dropdown. */
  label: string;
  /** How "ask" is honoured: real approvals, or a read-only stand-in. */
  ask?: "approvals" | "read-only";
  /**
   * Set when this mode does not do what it says on this agent, measured
   * against the real CLI — the dropdown shows it disabled with this reason and
   * the API refuses it. Better an honest gap than a switch that lies.
   */
  unsupported?: string;
}

export interface PermissionProfile {
  /** The mode an agent runs in when nobody chose one — today's behaviour. */
  default: PermissionMode;
  modes: Record<PermissionMode, PermissionCell>;
}

export const PERMISSION_PROFILES: Record<string, PermissionProfile> = {
  "claude-code": {
    default: "auto",
    modes: {
      bypass: { flags: "--permission-mode bypassPermissions", label: "Bypass — runs any tool, never asks" },
      auto: { flags: "--permission-mode acceptEdits", label: "Auto — edits files; other tools only if pre-allowed" },
      ask: {
        flags: "--permission-mode manual --permission-prompt-tool mcp__loom__approve",
        label: "Always ask — every tool call waits for your approval in Loom",
        ask: "approvals",
      },
    },
  },
  codex: {
    default: "auto",
    modes: {
      bypass: { flags: "--dangerously-bypass-approvals-and-sandbox", label: "Bypass — no sandbox, no approvals" },
      auto: { flags: "-s workspace-write", label: "Auto — writes inside the project, sandboxed" },
      ask: { flags: "-s read-only", label: "Ask — read-only: proposes changes, makes none", ask: "read-only" },
    },
  },
  "antigravity-cli": {
    default: "bypass",
    modes: {
      bypass: { flags: "--dangerously-skip-permissions", label: "Bypass — auto-approves every tool" },
      auto: {
        flags: "--mode accept-edits",
        label: "Auto — accepts edits; commands need approval",
        unsupported:
          "agy 1.2.6 headless in accept-edits writes into its own scratch folder instead of your project — use Bypass",
      },
      ask: { flags: "--mode plan", label: "Ask — plan mode: proposes, makes no changes", ask: "read-only" },
    },
  },
  "grok-code": {
    default: "bypass",
    modes: {
      bypass: { flags: "--permission-mode bypassPermissions", label: "Bypass — runs any tool, never asks" },
      auto: { flags: "--permission-mode auto", label: "Auto — grok's own classifier decides" },
      ask: { flags: "--permission-mode plan", label: "Ask — plan mode: proposes, makes no changes", ask: "read-only" },
    },
  },
  opencode: {
    default: "auto",
    modes: {
      bypass: { flags: 'permission: {"*":"allow"}', label: "Bypass — every tool allowed" },
      auto: { flags: "opencode defaults", label: "Auto — opencode's own defaults" },
      ask: {
        flags: "—",
        label: "Ask — not available for OpenCode",
        unsupported:
          "opencode 1.18.31's headless API ignores both a deny-all permission config and its read-only plan agent — a file write went through",
      },
    },
  },
  /**
   * A model agent (adapters/model.ts) has no CLI flags — Loom runs its tool
   * loop itself, so these say what Loom does rather than what a command line
   * says. It defaults to ASK, unlike every CLI here, and the reason is the
   * asymmetry: a CLI in your roster is one you installed and signed into,
   * while a model agent is a name you picked off a provider's list an hour
   * ago. Reading is never gated; writing and running always are unless you
   * chose bypass.
   */
  model: {
    default: "ask",
    modes: {
      bypass: { flags: "", label: "Bypass — writes and runs without asking" },
      auto: { flags: "", label: "Auto — still asks before it writes or runs", ask: "approvals" },
      ask: { flags: "", label: "Always ask — every write and every command waits for you", ask: "approvals" },
    },
  },
};

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === "bypass" || v === "auto" || v === "ask";
}

/** The mode an agent config runs in: its explicit choice, else the kind's default. */
export function permissionFor(kind: string, options?: Record<string, unknown>): PermissionMode {
  const chosen = options?.permissions;
  const profile = PERMISSION_PROFILES[kind];
  // A mode this agent can't honour (hand-edited config, or a newer table)
  // falls back to its default rather than pretending.
  if (isPermissionMode(chosen) && !profile?.modes[chosen].unsupported) return chosen;
  return profile?.default ?? "auto";
}

/** Why `mode` can't be used with `kind`, or null when it can. */
export function unsupportedReason(kind: string, mode: PermissionMode): string | null {
  return PERMISSION_PROFILES[kind]?.modes[mode].unsupported ?? null;
}

/** The dropdown's rows for a kind — null for kinds with no mapping (bridges, echo). */
export function permissionMenu(kind: string): Array<{ mode: PermissionMode } & PermissionCell> | null {
  const p = PERMISSION_PROFILES[kind];
  if (!p) return null;
  return PERMISSION_MODES.map((mode) => ({ mode, ...p.modes[mode] }));
}
