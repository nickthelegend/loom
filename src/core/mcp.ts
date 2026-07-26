/**
 * MCP servers — turning the project's configured list into something the agents
 * actually receive.
 *
 * Until this existed, `config.mcps` was a list you could edit and nothing else:
 * it was written by the composer, read back by GET /mcps, and never once handed
 * to an agent. A row said "connected" because it had a URL typed into it, which
 * is not the same claim at all. Both halves of that are fixed here.
 *
 *   1. `writeMcpSession` renders the enabled servers into the standard
 *      `{"mcpServers": {…}}` document, in a temp file the adapter passes to its
 *      CLI for one turn and which is deleted afterwards. Nothing is left behind
 *      in the project, and nothing survives a turn it wasn't meant for.
 *
 *   2. `probeMcpServer` asks the server whether it is there. A bounded HTTP
 *      round-trip is a weak signal — it proves an endpoint answered, not that it
 *      speaks MCP — but it is a *measurement*, and the alternative on offer was
 *      `!!url`. A server that refuses the connection is reported as unreachable,
 *      which is the honest reading.
 *
 * Two CLIs consume this, and they take it differently — see the adapters:
 * `claude --mcp-config <file>` reads the document, `codex -c mcp_servers.<key>=…`
 * takes TOML overrides (verified against claude 2.1.193 and codex-cli 0.144.6 by
 * running both, not by reading docs).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig, McpServerEntry, ResolvedMcpServer } from "../types.js";

export type { McpServerEntry, ResolvedMcpServer };

/** A generated config file plus the servers in it. Alive for exactly one turn. */
export interface McpSession {
  /** Absolute path to the `{"mcpServers": …}` document. */
  configPath: string;
  servers: ResolvedMcpServer[];
  /** Delete the temp file (and its directory). Idempotent, never throws. */
  cleanup: () => void;
}

/**
 * MCP config keys land in a TOML dotted path (`mcp_servers.<key>` for codex),
 * so a display name like "My Server / prod" can't be used raw. Lower-cased and
 * reduced to word characters, which is stable across turns and collision-free
 * for any two names that differ by more than punctuation.
 */
export function mcpKey(name: string): string {
  const k = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return k || "server";
}

/**
 * Which configured servers are real enough to hand to an agent.
 *
 * A server counts when it has somewhere to connect to — a URL, or a command to
 * run — and hasn't been switched off for the session. The built-in suggestion
 * rows (GitHub, Slack, … with an empty url) are exactly the rows that fail this,
 * which is the point: they're placeholders, and shipping a placeholder to a CLI
 * as if it were a server is how you get an agent that reports a tool it doesn't
 * have.
 */
export function resolveMcpServers(mcps: McpServerConfig[] | undefined): ResolvedMcpServer[] {
  const out: ResolvedMcpServer[] = [];
  const seen = new Set<string>();
  for (const m of mcps ?? []) {
    if (m?.enabledForSession === false) continue;
    const url = String(m?.url ?? "").trim();
    const command = String(m?.command ?? "").trim();
    if (!url && !command) continue;
    const key = mcpKey(m.name);
    if (seen.has(key)) continue; // first wins; a duplicate key would overwrite it
    seen.add(key);
    const entry: McpServerEntry = url
      ? {
          type: transportOf(m, url),
          url,
          // `headers` is the documented field of the mcp.json remote entry, and
          // it is how a hosted server that wants an `Authorization: Bearer …`
          // gets one. Only emitted when there is something to say, so a config
          // for a server that needs no auth reads exactly as it did before.
          ...(m.headers && Object.keys(m.headers).length ? { headers: stringValues(m.headers) } : {}),
        }
      : {
          type: "stdio",
          command,
          ...(m.args?.length ? { args: m.args.map((a) => String(a)) } : {}),
          ...(m.env && Object.keys(m.env).length ? { env: stringValues(m.env) } : {}),
        };
    out.push({ key, name: m.name, entry });
  }
  return out;
}

/**
 * http unless told otherwise. An explicit `transport` wins; failing that a URL
 * whose path ends in /sse is the long-standing convention for an SSE endpoint,
 * and guessing it right saves a server that would otherwise fail to handshake.
 */
function transportOf(m: McpServerConfig, url: string): "http" | "sse" {
  if (m.transport === "sse" || m.transport === "http") return m.transport;
  return /\/sse\/?$/i.test(url) ? "sse" : "http";
}

function stringValues(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = String(v);
  return out;
}

/** The config document itself — the shape every MCP client reads. */
export function mcpConfigDocument(servers: ResolvedMcpServer[]): { mcpServers: Record<string, McpServerEntry> } {
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const s of servers) mcpServers[s.key] = s.entry;
  return { mcpServers };
}

/**
 * Write the enabled servers to a temp config file for one turn.
 *
 * Returns null when there is nothing to write — callers use that to decide
 * whether the CLI gets the flag at all, because passing an empty config is not
 * the same as passing none (with `--strict-mcp-config` it would *suppress* the
 * user's own servers).
 */
export function writeMcpSession(mcps: McpServerConfig[] | undefined): McpSession | null {
  const servers = resolveMcpServers(mcps);
  if (!servers.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mcp-"));
  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(configPath, JSON.stringify(mcpConfigDocument(servers), null, 2));
  return {
    configPath,
    servers,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover file in the OS temp dir is not worth failing a turn over.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// codex: TOML config overrides
// ---------------------------------------------------------------------------

/** TOML basic-string escaping — quotes, backslashes and the control chars. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** One server as a TOML inline table, the value half of a `-c key=value` pair. */
function tomlInline(entry: McpServerEntry): string {
  const fields: string[] = [];
  if (entry.type === "stdio") {
    fields.push(`command=${tomlString(entry.command)}`);
    if (entry.args?.length) fields.push(`args=[${entry.args.map(tomlString).join(",")}]`);
    if (entry.env && Object.keys(entry.env).length) {
      fields.push(`env={${Object.entries(entry.env).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(",")}}`);
    }
  } else {
    fields.push(`url=${tomlString(entry.url)}`);
    // Headers are NOT emitted here, and that is a deliberate gap rather than an
    // oversight. `url` was verified against codex-cli 0.144.6 by running it;
    // the key codex wants for per-server HTTP headers was not, and a guessed
    // TOML key is either ignored (silent) or rejected (turn fails). A server
    // that needs an Authorization header will fail to authenticate under codex
    // until this is verified — which is a visible, diagnosable failure, unlike
    // an invented field name.
  }
  return `{${fields.join(",")}}`;
}

/**
 * The `-c` arguments that put these servers in front of `codex exec`.
 *
 * Codex has no `--mcp-config <file>` flag — its servers live in the
 * `mcp_servers` table of config.toml, and `-c <dotted.path>=<toml>` is the
 * documented per-invocation override for exactly that. Verified against
 * codex-cli 0.144.6: `codex mcp list -c 'mcp_servers.x={url="…"}'` lists the
 * injected server alongside the persisted ones, for both URL and command forms.
 * Nothing is written to the user's config.toml.
 */
export function codexMcpArgs(servers: ResolvedMcpServer[]): string[] {
  const args: string[] = [];
  for (const s of servers) {
    args.push("-c", `mcp_servers.${s.key}=${tomlInline(s.entry)}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Is the server actually there?
 *
 * HEAD first (cheapest thing that proves a listener answered), then GET for the
 * servers that only implement the methods MCP uses. ANY HTTP status counts as
 * reachable — a 405 or a 401 is a server saying "not like that", which is still
 * a server. A connection refused, a DNS failure or a timeout is not.
 *
 * Bounded hard: this sits behind an HTTP handler that renders a list, and a
 * hanging endpoint must cost that request two seconds, not forever. The body is
 * cancelled immediately because an MCP endpoint may answer GET with an open SSE
 * stream that never ends.
 */
export async function probeMcpServer(url: string, timeoutMs = 2_000): Promise<boolean> {
  const target = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) return false;
  if (typeof globalThis.fetch !== "function") return false;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(target, { method, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      await res.body?.cancel().catch(() => {});
      return true;
    } catch {
      // try the next method; a network-level failure ends the loop below
    }
  }
  return false;
}

/**
 * Probe every configured server that has a URL, in parallel, and report which
 * ones answered. Servers with no URL aren't probed and aren't reachable —
 * including the command-based ones, whose liveness is "does the process start",
 * a question this can't answer without spawning it.
 */
export async function probeMcpServers(
  mcps: McpServerConfig[],
  timeoutMs = 2_000,
): Promise<Record<string, boolean>> {
  const withUrl = mcps.filter((m) => String(m?.url ?? "").trim());
  const results = await Promise.all(withUrl.map((m) => probeMcpServer(m.url, timeoutMs)));
  const out: Record<string, boolean> = {};
  withUrl.forEach((m, i) => (out[m.name] = results[i] ?? false));
  return out;
}
