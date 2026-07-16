/**
 * What a new machine still needs — one answer, for the CLI and the app both.
 *
 * `loom doctor` and the onboarding screen ask the same question, so they share
 * a source. The alternative is what this codebase already learned the hard way
 * with agent kinds: two lists that agree until they don't, and a UI confidently
 * telling you something the code stopped believing months ago.
 *
 * Everything here is per-platform because the answers genuinely differ — a
 * Windows firewall prompt and a macOS notification permission are not the same
 * item worded differently.
 */

import os from "node:os";
import { GuiChatDriver } from "../adapters/bridges/gui-chat.js";
import { profileFor } from "../adapters/bridges/profiles.js";
import { ADES, detectAdes } from "./ades.js";

export type Platform = "darwin" | "win32" | "linux";

export function platform(): Platform {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
}

export interface AgentStatus {
  kind: string;
  label: string;
  found: boolean;
  /** How to get it, when it's missing. */
  install: string;
  /**
   * How to check it's logged in.
   *
   * Loom can't answer that itself: a signed-out CLI answers `--version`
   * cheerfully and only fails once it's holding your turn. So it hands over the
   * command that will actually tell you.
   */
  auth: string;
}

export interface BridgeStatus {
  kind: string;
  label: string;
  port: number;
  /** Something is answering the debugger. */
  reachable: boolean;
  /** ...and it has a chat we could actually type into. */
  driveable: boolean;
  /** Why not, in words worth showing a person. */
  reason?: string;
  /** How to start it with a debugger, on this OS. */
  launch: string;
}

export interface PermissionItem {
  title: string;
  why: string;
  how: string;
  /** True when Loom deliberately does NOT want this, despite expectations. */
  refused?: boolean;
}

export interface SetupReport {
  platform: Platform;
  node: { version: string; ok: boolean; needed: string };
  agents: AgentStatus[];
  bridges: BridgeStatus[];
  permissions: PermissionItem[];
  /** Nothing to drive: the one state that makes Loom useless. */
  ready: boolean;
}

const INSTALL: Record<string, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  codex: "install Codex.app, or npm i -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  "grok-code": "install the grok CLI from docs.x.ai",
};

const AUTH: Record<string, string> = {
  "claude-code": "run `claude` once",
  codex: "codex login status",
  opencode: "opencode auth list",
  "grok-code": "run `grok` once",
};

/**
 * The permissions Loom actually needs, and the ones it pointedly doesn't.
 *
 * The refusals are listed on purpose. People expect a tool that drives other
 * apps to demand Accessibility, and something that asks for it while claiming
 * to be Loom is worth being suspicious of. Loom talks to a debugging port; it
 * never pretends to be a mouse, so it never needs control of your machine.
 */
function permissionsFor(p: Platform): PermissionItem[] {
  const shared: PermissionItem[] = [
    {
      title: "Accessibility / Screen Recording / Automation",
      why: "Loom drives GUI agents through their debug port, not by faking clicks",
      how: "Not needed — don't grant it. If something asks for this in Loom's name, it isn't Loom.",
      refused: true,
    },
  ];

  if (p === "darwin") {
    return [
      {
        title: "Notifications",
        why: "so you hear when an agent needs you and you're in another window",
        how: "Allowed on first ask · System Settings → Notifications → Loom",
      },
      {
        title: "Opening an unsigned app",
        why: "Loom.app isn't notarized yet, so Gatekeeper blocks a double-click",
        how: "Right-click the app → Open, once. Double-clicking gives a dead end.",
      },
      {
        title: "Local Network",
        why: "your phone reaching the daemon over the LAN",
        how: "Prompted on first connection · System Settings → Privacy & Security → Local Network",
      },
      {
        title: "Run at login",
        why: "the daemon survives closing the window, but not a reboot",
        how: "System Settings → General → Login Items → + → Loom",
      },
      ...shared,
    ];
  }
  if (p === "win32") {
    return [
      {
        title: "Firewall — private networks",
        why: "your phone reaching the daemon; without it the tailnet can't connect",
        how: "Windows Defender prompts on first `loom up` — tick Private, leave Public off",
      },
      {
        title: "SmartScreen",
        why: "the installer isn't signed yet",
        how: "More info → Run anyway",
      },
      {
        title: "Notifications",
        why: "so you hear when an agent needs you",
        how: "Settings → System → Notifications → Loom",
      },
      {
        title: "Run at login",
        why: "the daemon survives closing the window, but not a reboot",
        how: "Win+R → shell:startup → put a shortcut to Loom in there",
      },
      ...shared,
    ];
  }
  return [
    {
      title: "Notifications",
      why: "so you hear when an agent needs you",
      how: "your desktop's notification settings — Loom uses libnotify",
    },
    {
      title: "Run at login",
      why: "the daemon survives closing the window, but not a reboot",
      how: "a user systemd unit running `loom up`",
    },
    ...shared,
  ];
}

/** Is this Node new enough for the event log to be real? */
export function nodeOk(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5);
}

export async function setupReport(): Promise<SetupReport> {
  const p = platform();
  const available = await detectAdes();

  const agents: AgentStatus[] = ADES.filter((a) => a.tier === "adapter").map((a) => ({
    kind: a.kind,
    label: a.label,
    found: Boolean(available[a.kind]),
    install: INSTALL[a.kind] ?? "",
    auth: AUTH[a.kind] ?? "",
  }));

  // Bridges are probed live: "installed" says nothing useful about an app whose
  // debugger has to be asked for at launch.
  const bridges: BridgeStatus[] = await Promise.all(
    ADES.filter((a) => a.tier === "bridge").map(async (a) => {
      const profile = profileFor(a.kind);
      const driver = new GuiChatDriver(profile.name, {}, a.kind);
      const reachable = await driver.reachable().catch(() => false);
      const drive = reachable ? await driver.driveable() : { ok: false as const, reason: undefined };
      return {
        kind: a.kind,
        label: profile.name,
        port: profile.defaultPort,
        reachable,
        driveable: drive.ok,
        ...(drive.ok ? {} : { reason: drive.reason ?? "not running" }),
        launch: profile.launch[p],
      };
    }),
  );

  return {
    platform: p,
    node: { version: process.versions.node, ok: nodeOk(), needed: "22.5" },
    agents,
    bridges,
    permissions: permissionsFor(p),
    // Bridges can't hold the baton, so they don't count towards being able to
    // do anything: an install with only Antigravity has nothing to route to.
    ready: agents.some((a) => a.found),
  };
}

/** For the "and this is your machine" line in onboarding. */
export function machineName(): string {
  return os.hostname().replace(/\.local$/, "");
}
