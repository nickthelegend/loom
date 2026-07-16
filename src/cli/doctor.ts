/**
 * loom doctor — one command that answers "why is nothing working?".
 * Checks the environment (node, agent CLIs, tailscale), the daemon (health,
 * build freshness, binding), and the current project's config.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createAgent, knownAgentKinds } from "../adapters/index.js";
import { ADES, detectAdes } from "../core/ades.js";
import { GuiChatDriver } from "../adapters/bridges/gui-chat.js";
import { profileFor } from "../adapters/bridges/profiles.js";
import { readDaemonConfig, readProjectConfig, readProjectState } from "../core/registry.js";
import { resolveSteps, stepName } from "../core/routes.js";
import { isAdapter } from "../types.js";
import { BUILD_REV } from "../daemon/server.js";

/**
 * How to check an agent is actually logged in.
 *
 * Doctor can tell you a CLI exists. It cannot tell you it will work, because
 * "installed" and "authenticated" look identical from out here — the binary
 * answers --version either way and only fails once it's holding your turn. So
 * it hands you the command that WILL tell you.
 */
const AUTH_HINT: Record<string, string> = {
  "claude-code": "check auth: run `claude` once",
  codex: "check auth: `codex login status`",
  opencode: "check auth: `opencode auth list`",
  "grok-code": "check auth: run `grok` once",
};

function launchOs(): "darwin" | "win32" | "linux" {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
}

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function ok(name: string, detail: string): Check {
  return { name, status: "ok", detail };
}
function warn(name: string, detail: string): Check {
  return { name, status: "warn", detail };
}
function fail(name: string, detail: string): Check {
  return { name, status: "fail", detail };
}

// ---------------------------------------------------------------------------
// Project checks (pure over a directory — unit tested)
// ---------------------------------------------------------------------------

export function projectChecks(dir: string): Check[] {
  const checks: Check[] = [];
  const config = readProjectConfig(dir);
  if (!config) {
    return [fail("project", `no .loom/config.json under ${dir} — run loom init`)];
  }
  checks.push(ok("project", `${config.name} (${dir})`));

  const known = new Set(knownAgentKinds());
  const seen = new Set<string>();
  const adapterIds = new Set<string>();
  for (const agent of config.agents) {
    if (seen.has(agent.id)) {
      checks.push(fail("agents", `duplicate agent id "${agent.id}"`));
      continue;
    }
    seen.add(agent.id);
    if (!known.has(agent.kind)) {
      checks.push(
        fail("agents", `"${agent.id}" has unknown kind "${agent.kind}" (known: ${[...known].join(", ")})`),
      );
      continue;
    }
    // No role whitelist: a role is free text you chose ("architect", "the one
    // that writes docs"). Only an empty one is a problem — it's the label the
    // pipeline matches steps against, so a blank means nothing can target it.
    if (!agent.role || !String(agent.role).trim()) {
      checks.push(fail("agents", `"${agent.id}" has no role — give it a name, any name`));
      continue;
    }
    try {
      if (isAdapter(createAgent(agent, dir))) adapterIds.add(agent.id);
    } catch (err) {
      checks.push(fail("agents", `"${agent.id}" failed to construct: ${String(err)}`));
    }
  }
  if (!checks.some((c) => c.name === "agents" && c.status === "fail")) {
    checks.push(ok("agents", `${config.agents.length} configured, ${adapterIds.size} can hold the baton`));
  }
  if (!adapterIds.size) {
    checks.push(fail("agents", "no full-duplex adapters — nothing can take a turn"));
  }

  if (config.defaultAgent && !seen.has(config.defaultAgent)) {
    checks.push(fail("config", `defaultAgent "${config.defaultAgent}" is not a configured agent`));
  }

  for (const [name, steps] of Object.entries(config.routes ?? {})) {
    try {
      resolveSteps(steps, config, (id) => adapterIds.has(id));
      checks.push(ok("routes", `"${name}": ${steps.map(stepName).join(" → ")}`));
    } catch (err) {
      checks.push(fail("routes", `"${name}" is broken: ${err instanceof Error ? err.message : err}`));
    }
  }

  const holder = readProjectState(dir).holder;
  if (holder && !seen.has(holder)) {
    checks.push(warn("baton", `persisted holder "${holder}" no longer exists (auto-clears on next send)`));
  } else {
    checks.push(ok("baton", holder ? `held by ${holder}` : "unheld"));
  }

  try {
    const memDir = path.join(dir, ".loom", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const probe = path.join(memDir, ".doctor-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    checks.push(ok("memory", ".loom/memory is writable"));
  } catch (err) {
    checks.push(fail("memory", `cannot write .loom/memory: ${String(err)}`));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Environment + daemon checks
// ---------------------------------------------------------------------------

function version(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim().split("\n")[0] ?? "");
      });
    } catch {
      resolve(null);
    }
  });
}

export async function envChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5)) {
    checks.push(ok("node", `v${process.versions.node}`));
  } else {
    checks.push(fail("node", `v${process.versions.node} — Loom needs ≥ 22.5 (node:sqlite)`));
  }

  // Every ADE Loom can drive, from the one list — not a hardcoded pair. The
  // whole point of core/ades.ts is that this answer lives in one place.
  const available = await detectAdes();
  for (const ade of ADES.filter((a) => a.tier === "adapter")) {
    if (!available[ade.kind]) {
      checks.push(warn(ade.kind, `not found — install ${ade.label} to use the ${ade.kind} adapter`));
      continue;
    }
    // Installed is not the same as usable: an unauthenticated CLI answers
    // --version happily and then fails the first real turn. Doctor can't log in
    // for you, so it says which ones it can't vouch for.
    checks.push(ok(ade.kind, `${ade.label} found${AUTH_HINT[ade.kind] ? ` · ${AUTH_HINT[ade.kind]}` : ""}`));
  }

  // The GUI agents: reachable and driveable are different questions.
  for (const ade of ADES.filter((a) => a.tier === "bridge")) {
    const profile = profileFor(ade.kind);
    const driver = new GuiChatDriver(profile.name, {}, ade.kind);
    if (!(await driver.reachable())) {
      checks.push(warn(ade.kind, `not listening on ${profile.defaultPort} — ${profile.launch[launchOs()]}`));
      continue;
    }
    const drive = await driver.driveable();
    checks.push(
      drive.ok
        ? ok(ade.kind, `${profile.name} · ready to drive on ${profile.defaultPort}`)
        : warn(ade.kind, `${profile.name} is up but not driveable — ${drive.reason}`),
    );
  }

  const tv = await version("tailscale");
  checks.push(tv !== null ? ok("tailscale", tv) : warn("tailscale", "not found — install Tailscale for phone access"));

  const cfg = readDaemonConfig();
  if (!cfg) {
    checks.push(warn("daemon", "never started — loom up"));
    return checks;
  }
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = (await res.json()) as { rev?: string };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (health.rev === BUILD_REV) {
      checks.push(ok("daemon", `http://${cfg.host}:${cfg.port} · current build`));
    } else {
      checks.push(warn("daemon", "running an older build — loom up --restart"));
    }
  } catch {
    checks.push(warn("daemon", `configured for http://${cfg.host}:${cfg.port} but not responding — loom up`));
  }
  if (["127.0.0.1", "localhost", "::1"].includes(cfg.host)) {
    checks.push(warn("binding", "localhost only — phones can't reach it (loom up --restart --tailnet)"));
  } else {
    checks.push(ok("binding", `${cfg.host} (tailnet)`));
  }
  checks.push(ok("devices", `${cfg.clients.length} paired`));

  return checks;
}
