/**
 * loom doctor — one command that answers "why is nothing working?".
 * Checks the environment (node, agent CLIs, tailscale), the daemon (health,
 * build freshness, binding), and the current project's config — and, since
 * the daemon is often started by the desktop app rather than this shell,
 * whether the daemon sees what this shell sees (PATH, keys, sign-ins), whether
 * each provider answers, and whether a free model keeps getting refused.
 */

import { execFile } from "../core/process.js";
import { codexBin, codexVersion } from "../providers/codex/adapter.js";
import fs from "node:fs";
import path from "node:path";
import { createAgent, knownAgentKinds } from "../adapters/index.js";
import { setupReport } from "../core/setup.js";
import {
  readDaemonConfig,
  readProjectConfig,
  readProjectState,
  writeProjectConfig,
  writeProjectState,
} from "../core/registry.js";
import { resolveSteps, stepName } from "../core/routes.js";
import { isAdapter, type AgentConfig, type LoomEvent } from "../types.js";
import { ADES } from "../core/ades.js";
import { isPool } from "../core/free-pool.js";
import { BUILTIN_PROVIDERS, listProviders, modelsUrl, requestHeaders, resolveProvider } from "../core/providers.js";
import { BUILD_REV } from "../daemon/server.js";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  summary: {
    ok: boolean;
    warnings: number;
    failures: number;
  };
}

export function doctorReport(checks: Check[]): DoctorReport {
  const warnings = checks.filter((check) => check.status === "warn").length;
  const failures = checks.filter((check) => check.status === "fail").length;
  return { checks, summary: { ok: failures === 0, warnings, failures } };
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
    // A switched-off agent is configured but can't take a turn; counting it
    // as able to hold the baton overstated what this project can run.
    const off = config.agents.filter((a) => a.enabled === false).map((a) => a.id);
    for (const id of off) adapterIds.delete(id);
    checks.push(ok("agents", `${config.agents.length} configured, ${adapterIds.size} can hold the baton${off.length ? ` (${off.join(", ")} switched off)` : ""}`));
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
// Fixes — the repairs doctor can make without guessing
// ---------------------------------------------------------------------------

/**
 * Repair what has exactly one safe repair; report what doesn't.
 *
 * doctor used to diagnose accurately and then leave you to fix it by hand,
 * which for half the findings meant retyping a value it had just printed. The
 * line: a fix is offered only when the correct end state is unambiguous —
 *
 *  - a persisted baton holder that no longer exists → cleared (it auto-clears
 *    on the next send anyway; this just stops the warning outliving the bug)
 *  - defaultAgent naming an agent that isn't configured → dropped, falling
 *    back to the first adapter, which is what the runtime does regardless
 *  - an agent with an empty role → role becomes its kind, the same default
 *    addAgent gives a fresh agent
 *  - a missing .loom/memory directory → created
 *
 * Duplicate ids and unknown kinds stay reports: choosing which duplicate dies,
 * or what a typo meant, is the human's call. A fixer that guesses there turns
 * a visible problem into an invisible wrong answer.
 */
export function fixProject(dir: string): { fixed: string[]; unfixable: string[] } {
  const fixed: string[] = [];
  const unfixable: string[] = [];
  const config = readProjectConfig(dir);
  if (!config) {
    return { fixed, unfixable: ["no .loom/config.json — loom init creates one, doctor won't"] };
  }

  const ids = new Set(config.agents.map((a) => a.id));
  let dirty = false;

  for (const agent of config.agents) {
    if (!agent.role || !String(agent.role).trim()) {
      agent.role = agent.kind;
      dirty = true;
      fixed.push(`"${agent.id}" had no role — set to "${agent.kind}"`);
    }
  }

  if (config.defaultAgent && !ids.has(config.defaultAgent)) {
    fixed.push(`defaultAgent "${config.defaultAgent}" doesn't exist — cleared`);
    delete config.defaultAgent;
    dirty = true;
  }

  const seen = new Set<string>();
  for (const agent of config.agents) {
    if (seen.has(agent.id)) unfixable.push(`duplicate agent id "${agent.id}" — pick which one to keep`);
    seen.add(agent.id);
    if (!knownAgentKinds().includes(agent.kind)) {
      unfixable.push(`"${agent.id}" has unknown kind "${agent.kind}" — fix the typo or remove it`);
    }
  }

  if (dirty) writeProjectConfig(dir, config);

  const state = readProjectState(dir);
  if (state.holder && !ids.has(state.holder)) {
    fixed.push(`stale baton holder "${state.holder}" — cleared`);
    writeProjectState(dir, { ...state, holder: null });
  }

  const memDir = path.join(dir, ".loom", "memory");
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true });
    fixed.push(".loom/memory was missing — created");
  }

  return { fixed, unfixable };
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

/** Which codex Loom runs, and its version: the newest client gets the newest models. */
function codexWhich(): string {
  const bin = codexBin();
  if (!bin || bin === "codex") return "";
  const v = codexVersion(bin);
  return ` · ${v ? v.join(".") : "unknown version"} (${bin.includes("ChatGPT.app") ? "ChatGPT app" : bin.includes("Codex.app") ? "Codex app" : bin})`;
}

export async function envChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5)) {
    checks.push(ok("node", `v${process.versions.node}`));
  } else {
    checks.push(fail("node", `v${process.versions.node} — Loom needs ≥ 22.5 (node:sqlite)`));
  }

  // Every ADE Loom can drive, from the one list — and whether it's actually
  // signed in, which is the question that matters. "Installed" is not "usable":
  // a signed-out CLI answers --version cheerfully and refuses every real turn.
  const report = await setupReport();
  for (const a of report.agents) {
    if (!a.found) {
      checks.push(warn(a.kind, `not found — install ${a.label} to use the ${a.kind} adapter`));
    } else if (a.authed === false) {
      checks.push(fail(a.kind, `${a.label} is signed out — ${a.auth}`));
    } else if (a.authed === true) {
      checks.push(ok(a.kind, `${a.label} · signed in${a.authDetail ? ` with ${a.authDetail}` : ""}${a.kind === "codex" ? codexWhich() : ""}`));
    } else {
      checks.push(warn(a.kind, `${a.label} found — couldn't confirm sign-in · ${a.auth}`));
    }
  }

  // The GUI agents: reachable and driveable are different questions.
  for (const b of report.bridges) {
    checks.push(
      b.driveable
        ? ok(b.kind, `${b.label} · ready to drive on ${b.port}`)
        : warn(b.kind, b.reachable ? `${b.label} is up but not driveable — ${b.reason}` : `${b.reason}`),
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

// ---------------------------------------------------------------------------
// The daemon's view vs this shell's (#field-test: a key exported in a terminal
// never reaches a daemon the desktop app started; neither does a PATH entry)
// ---------------------------------------------------------------------------

/** What one process can see: its PATH, and which key variables are set — names only, never values. */
export interface EnvFacts { node: string; path: string[]; keys: string[] }

const KEY_VAR = /^[A-Z][A-Z0-9_]*_(API_KEY|AUTH_TOKEN)$/;

export function envFacts(env: NodeJS.ProcessEnv = process.env): EnvFacts {
  return {
    node: process.versions.node,
    path: (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean),
    keys: Object.keys(env).filter((k) => KEY_VAR.test(k) && Boolean(env[k])).sort(),
  };
}

const AGENT_KINDS = new Set(ADES.filter((a) => a.tier === "adapter").map((a) => a.kind));
const providerOfVar = (v: string) => BUILTIN_PROVIDERS.find((p) => p.envKeys.includes(v))?.id;

/** The command each CLI agent runs, to say which PATH dir the daemon is missing. */
const AGENT_BIN: Record<string, string> = { "claude-code": "claude", codex: "codex", opencode: "opencode", "grok-code": "grok", "antigravity-cli": "agy" };

/** Where the daemon and this shell disagree, as checks. Pure but for `exists`, which looks for an agent's command. */
export function compareWithDaemon(
  shell: { checks: Check[]; facts: EnvFacts },
  daemon: { checks: Check[]; facts: EnvFacts },
  exists: (file: string) => boolean = fs.existsSync,
): Check[] {
  const out: Check[] = [];
  const missingDirs = shell.facts.path.filter((d) => !daemon.facts.path.includes(d));
  // the dir an agent's command lives in, among those the daemon lacks; else the likely ones (not per-package node_modules/.bin)
  const whereMissing = (kind: string): string[] => {
    const bin = AGENT_BIN[kind];
    const home = bin ? missingDirs.find((d) => exists(path.join(d, bin)) || exists(path.join(d, `${bin}.cmd`)) || exists(path.join(d, `${bin}.exe`))) : undefined;
    return home ? [home] : missingDirs.filter((d) => !/node_modules[\\/]\.bin$/.test(d)).slice(0, 3);
  };
  const restart = "restart it from this terminal (loom up --restart) so it inherits this shell's environment";
  const theirs = new Map(daemon.checks.map((c) => [c.name, c]));
  for (const mine of shell.checks) {
    if (!AGENT_KINDS.has(mine.name) || /^not found/.test(mine.detail)) continue;
    const d = theirs.get(mine.name);
    if (!d) continue;
    if (/^not found/.test(d.detail)) {
      const dirs = whereMissing(mine.name);
      out.push(fail(`daemon:${mine.name}`, `installed here, but the daemon can't find it — it runs with a different PATH${dirs.length ? ` (missing ${dirs.join(", ")})` : ""}; ${restart}`));
    } else if (mine.status === "ok" && d.status === "fail") {
      out.push(fail(`daemon:${mine.name}`, /^a turn by /.test(d.detail) ? `looks signed in, but ${d.detail}` : `signed in here, signed out for the daemon — ${d.detail}`));
    }
  }
  const keysHere = shell.facts.keys.filter((k) => !daemon.facts.keys.includes(k));
  for (const k of keysHere) {
    const id = providerOfVar(k);
    out.push(warn("daemon:keys", `${k} is set in this shell but not in the daemon — ${id ? `loom providers:set ${id} --key … stores it for both, or ` : ""}${restart}`));
  }
  if (daemon.facts.node !== shell.facts.node) out.push(ok("daemon:node", `the daemon runs Node ${daemon.facts.node}; this shell has ${shell.facts.node}`));
  if (!out.some((c) => c.status !== "ok")) {
    out.push(ok("daemon:env", missingDirs.length ? `sees every agent and key this shell does (its PATH lacks ${missingDirs.length} of your dirs, none an agent needs)` : "same PATH and keys as this shell"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Providers: does each configured one answer, with the key the daemon holds?
// ---------------------------------------------------------------------------

export async function providerChecks(opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const rows = listProviders(env).filter((r) => r.configured);
  return Promise.all(rows.map(async (row): Promise<Check> => {
    const p = resolveProvider(row.id, env);
    const name = `provider:${row.id}`;
    if (!p) return warn(name, "configured but can't be resolved");
    try {
      const res = await doFetch(modelsUrl(p), { headers: requestHeaders(p), signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) return fail(name, `${p.label} refused the key (${res.status}) — loom providers:set ${row.id} --key …`);
      if (res.status === 429) return warn(name, `${p.label} is rate-limiting this key right now (429)`);
      if (!res.ok) return warn(name, `${p.label} answered ${res.status}`);
      if (row.id !== "openrouter") return ok(name, `${p.label} answers`);
      // OpenRouter says what the key has left without spending a request
      const key = await doFetch("https://openrouter.ai/api/v1/key", { headers: requestHeaders(p), signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ data?: { is_free_tier?: boolean; limit_remaining?: number | null } }>) : null)).catch(() => null);
      const d = key?.data;
      if (d && typeof d.limit_remaining === "number" && d.limit_remaining <= 0) return fail(name, "OpenRouter answers, but this key's credit limit is used up");
      return ok(name, `OpenRouter answers${d?.is_free_tier ? " · free tier: :free models share 50 requests a day across the account" : ""}`);
    } catch (err) {
      // Ollama counts as set up without a key; not running is only a problem for an agent that uses it
      if (row.id === "ollama") return ok(name, "not running here — only needed for a local model");
      return warn(name, `couldn't reach ${p.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

/**
 * A model agent pinned to one free model that keeps being refused — 429
 * (that model is busy, or the day's free requests are spent) or 503 (no
 * capacity) — is better off on the free pool, which rotates. Pure over the log.
 */
export function freeModelTrouble(events: readonly LoomEvent[], agents: readonly AgentConfig[], now = Date.now()): Check[] {
  const out: Check[] = [];
  const since = now - 24 * 60 * 60_000;
  for (const a of agents) {
    const model = String((a as { model?: unknown }).model ?? "");
    if (a.kind !== "model" || !/:free$/.test(model) || isPool(model)) continue; // the pool already rotates
    const refused = events.filter((e) => e.kind === "error" && e.agentId === a.id && e.ts >= since && /\b(429|503)\b|rate.?limit|no capacity|overloaded/i.test(String(e.payload?.message ?? "")));
    if (!refused.length) continue;
    const daily = refused.some((e) => /free-models-per-day|per[- ]day/i.test(String(e.payload?.message ?? "")));
    out.push(warn(`model:${a.id}`, daily
      ? `${model} hit OpenRouter's daily free-request cap ${refused.length}× in 24h — it resets daily; credits raise it`
      : `${model} was refused (429/503) ${refused.length}× in 24h — set this agent's model to pool:free to rotate across free models`));
  }
  return out;
}
