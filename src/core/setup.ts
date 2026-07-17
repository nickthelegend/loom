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

import { execFile } from "node:child_process";
import os from "node:os";
import { GuiChatDriver } from "../adapters/bridges/gui-chat.js";
import { codexBin } from "../adapters/codex.js";
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
   * Is it actually signed in?
   *
   * `null` when we couldn't tell in the time we were willing to wait — an
   * honest "don't know", not a cheerful yes.
   */
  authed: boolean | null;
  /** What the tool said, when it said no. */
  authDetail?: string;
  /** The command that fixes it. */
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
  "claude-code": "run `claude`, then /login",
  codex: "codex login",
  opencode: "opencode auth login",
  "grok-code": "run `grok` once and sign in",
};

/**
 * Ask each tool whether it's actually signed in.
 *
 * I claimed this was impossible earlier in the day — that installed and
 * authenticated look identical from out here — and then watched a whole
 * afternoon go into "claude is installed" while `claude` answered "Not logged
 * in · Please run /login" to anyone who asked. It isn't impossible. It just
 * needs asking the right question.
 *
 * Every probe here is free and offline-ish:
 *   codex     — `login status` reports without touching a model
 *   opencode  — `auth list` reads its own credentials file
 *   claude    — a `-p` probe; when signed out it refuses in ~30ms having called
 *               nothing. When signed IN it would cost a token or two, so it is
 *               capped hard and a slow answer counts as "signed in": only the
 *               instant refusal is diagnostic.
 *   grok      — has no status command; unknown rather than guessed.
 */
async function probeAuth(kind: string): Promise<{ authed: boolean | null; detail?: string }> {
  const run = (cmd: string, args: string[], ms: number): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      let done = false;
      const child = execFile(cmd, args, { timeout: ms }, (_err, stdout, stderr) => {
        if (done) return;
        done = true;
        resolve({ code: 0, out: `${stdout}${stderr}` });
      });
      child.stdin?.end();
      child.on("error", () => {
        if (!done) {
          done = true;
          resolve({ code: null, out: "" });
        }
      });
      setTimeout(() => {
        if (!done) {
          done = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
          resolve({ code: null, out: "" });
        }
      }, ms + 200).unref?.();
    });

  try {
    if (kind === "codex") {
      const bin = codexBin();
      if (!bin) return { authed: null };
      const { out } = await run(bin, ["login", "status"], 6000);
      if (/logged in/i.test(out)) return { authed: true };
      if (/not logged in|no auth/i.test(out)) return { authed: false, detail: out.trim().slice(0, 60) };
      return { authed: null };
    }
    if (kind === "opencode") {
      const { out } = await run("opencode", ["auth", "list"], 8000);
      // its list marks each stored credential with a bullet
      return /●/.test(out) ? { authed: true } : { authed: null };
    }
    if (kind === "claude-code") {
      // Signed out, this refuses instantly and for free. Signed in, it would
      // start a real turn — so the timeout is the budget, and hitting it is a
      // yes, not a maybe.
      const { out } = await run("claude", ["-p", "hi", "--output-format", "json"], 6000);
      if (/not logged in|please run \/login|invalid api key/i.test(out)) {
        return { authed: false, detail: "the CLI says: Not logged in" };
      }
      return { authed: true };
    }
  } catch {
    /* fall through to unknown */
  }
  return { authed: null };
}

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

  const agents: AgentStatus[] = await Promise.all(
    ADES.filter((a) => a.tier === "adapter").map(async (a) => {
      const found = Boolean(available[a.kind]);
      const auth = found ? await probeAuth(a.kind) : { authed: null as boolean | null };
      return {
        kind: a.kind,
        label: a.label,
        found,
        install: INSTALL[a.kind] ?? "",
        authed: auth.authed,
        ...(auth.detail ? { authDetail: auth.detail } : {}),
        auth: AUTH[a.kind] ?? "",
      };
    }),
  );

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
    // Ready means a turn can actually happen. An installed-but-signed-out
    // roster is not ready, and saying it is was the exact shape of today's
    // wasted afternoon. Unknown counts as ready — don't cry wolf over a probe
    // that timed out.
    ready: agents.some((a) => a.found && a.authed !== false),
  };
}

/** For the "and this is your machine" line in onboarding. */
export function machineName(): string {
  return os.hostname().replace(/\.local$/, "");
}
