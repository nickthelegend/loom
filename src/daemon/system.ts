import { execFile, spawn } from "../core/process.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agyBin } from "../adapters/antigravity-cli.js";
import { codexBin } from "../providers/codex/adapter.js";
import { grokBin } from "../adapters/grok.js";
import { allModels } from "../core/providers.js";
import { type ServerConfig } from "../core/servers.js";
import { ProjectRuntime } from "./runtime.js";

export const DEFAULT_PORT = 7420;

/**
 * Fingerprint every built file the daemon can load, as one hash.
 *
 * The walk is what makes it honest. This used to hash exactly two files —
 * server.js and app-page.js — which meant a change anywhere else (an adapter,
 * the router, core/registry.ts) left the rev identical. `loom up` said "daemon
 * already running", the shell agreed it was current, and a daemon kept serving
 * the old code from memory. A correct fix looked like it did nothing, which
 * sends you debugging code that is already right.
 *
 * Content-based on purpose: mtimes are unreliable across runtimes on some
 * filesystems (exFAT drives skew them by the local timezone offset). Names are
 * hashed alongside contents so a rename or a deletion moves the rev too.
 *
 * Read the runtime JS, CSS and HTML once at import; exclude source maps and
 * declarations because they do not change the running app.
 *
 * The desktop shell has a twin of this in desktop/loom-app.js — it can't import
 * this module without pulling express into Electron's main process. They must
 * agree byte for byte; test/desktop-app.test.ts compares them against the real
 * built output so a drift fails there rather than in the field.
 */
export function fingerprintBuild(root: string): string | null {
  const rels: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|css|html)$/.test(entry.name)) rels.push(path.relative(root, full));
    }
  };
  walk(root);
  if (rels.length === 0) return null;
  rels.sort(); // readdir order is filesystem-dependent; the hash must not be
  const hash = crypto.createHash("sha256");
  for (const rel of rels) {
    hash.update(rel);
    hash.update(fs.readFileSync(path.join(root, rel)));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * This build's rev. Source runs retain the "dev" marker; hashing only their
 * browser JS would misleadingly ignore changes to the TypeScript daemon.
 */
export const BUILD_REV = (() => {
  try {
    // dist/daemon/system.js → dist: everything this process can import.
    const me = fileURLToPath(import.meta.url);
    if (me.endsWith(".ts")) return "dev";
    return fingerprintBuild(path.dirname(path.dirname(me))) ?? "dev";
  } catch {
    return "dev";
  }
})();

/**
 * Loom's own install root — the directory to ask "am I behind my remote?".
 *
 * Walks up from this module looking for a .git directory (a source checkout or
 * a cloned install). null when Loom was installed some other way (a package),
 * in which case "check for updates" honestly says there's no git tree to check.
 */
export function loomRoot(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export const TERM_MARK = "__LOOM_END__";

/**
 * Just enough to give a pasted attachment a sensible extension.
 */
export const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/markdown": "md",
  "text/plain": "txt",
  "application/pdf": "pdf",
};

/**
 * Paths from an HTTP body, as strings and nothing else.
 *
 * These reach `git checkout --` and `git clean -fd`, which delete things. A
 * body is whatever the caller felt like sending, so anything that isn't a
 * string is dropped here rather than stringified into a path somewhere deeper.
 * This is the shape check; core/git.ts does the safety check, resolving every
 * one of them against the project root.
 */
export function asPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 500);
}

/** KAIRO-style dense fleet metrics for the Observatory Metrics tab. */
export function kairoMetrics(rt: ProjectRuntime): Record<string, unknown> {
  const cs = rt.costSummary();
  const decisions = rt.getDecisions();
  const stats = rt.decisionStats();
  const events = rt.log.list({ limit: 2000 });
  const runs = events.filter((e) => e.kind === "run_complete");
  const recent = runs.slice(-10);
  const num = (v: unknown): number => Number(v) || 0;
  // Distinct paths any turn touched, and how many touches there were. The set
  // used to be reported as `filesCreated`, which it never was — a file edited
  // in five turns is one path here, and creating it was not what put it there.
  const filePaths = new Set<string>();
  let fileChanges = 0;
  let filesCreated = 0;
  for (const e of events) {
    if (e.kind !== "turn_diff") continue;
    const files = Array.isArray(e.payload.files)
      ? (e.payload.files as Array<{ path?: string; status?: string }>)
      : [];
    fileChanges += files.length;
    for (const f of files) {
      if (f.path) filePaths.add(f.path);
      // "??" is git porcelain for untracked — the turn is where the file
      // started existing, which is the only "created" this log can support.
      if (String(f.status ?? "").trim() === "??") filesCreated += 1;
    }
  }
  const tokensByAgent: Record<string, number> = {};
  const costByAgent: Record<string, number> = {};
  for (const a of cs.byAgent) {
    tokensByAgent[a.agentId] = a.tokensIn + a.tokensOut;
    costByAgent[a.agentId] = a.usd;
  }
  return {
    agentsSpawned: new Set(runs.map((e) => e.agentId).filter(Boolean)).size,
    turnsCompleted: cs.turns,
    avgReasoningTimeMs: cs.turns ? Math.round(cs.totalMs / cs.turns) : 0,
    filesTouched: filePaths.size,
    filesCreated,
    filesModified: fileChanges,
    decisionsRecorded: decisions.length,
    // null when no decision carries a measured confidence — see decisionStats.
    avgConfidence: stats.avgConfidence,
    confidenceSamples: stats.confidenceSamples,
    decisionsBySource: stats.bySource,
    totalCostUsd: cs.totalUsd,
    totalTokensIn: cs.tokensIn,
    totalTokensOut: cs.tokensOut,
    costByAgent,
    tokensByAgent,
    criticalPath: stats.criticalPath,
    retriesTotal: events.filter((e) => e.kind === "error" || e.kind === "route_failed").length,
    tokenSparkline: recent.map((e) => num(e.payload.inputTokens) + num(e.payload.outputTokens)),
    costSparkline: recent.map((e) => num(e.payload.costUsd)),
  };
}

/** A server entry from the wire, checked — a command is a thing we will run. */
export function parseServerConfig(raw: unknown): ServerConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = String(r.name ?? "").trim();
  const command = String(r.command ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`"${name}" isn't a usable server name`);
  if (!command) throw new Error(`server "${name}" has no command`);
  const port = Number(r.port);
  const url = typeof r.url === "string" && r.url.trim() ? r.url.trim() : undefined;
  if (url && !/^https?:\/\//.test(url)) throw new Error(`server "${name}" has a url that isn't http(s)`);
  return {
    name,
    command,
    ...(typeof r.cwd === "string" && r.cwd.trim() ? { cwd: r.cwd.trim() } : {}),
    ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
    ...(url ? { url } : {}),
    ...(r.env && typeof r.env === "object" ? { env: Object.fromEntries(Object.entries(r.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}),
  };
}

/** Resolve this machine's Tailscale IPv4 — the tailnet is the trust boundary. */
export function tailscaleIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tailscale", ["ip", "-4"], (err, stdout) => {
      if (err) {
        reject(
          new Error(
            "could not resolve a Tailscale IP (is tailscale installed and up?) — refusing to bind beyond localhost",
          ),
        );
        return;
      }
      const ip = stdout.trim().split("\n")[0];
      if (!ip) return void reject(new Error("tailscale returned no IPv4"));
      resolve(ip);
    });
  });
}

/**
 * One `tailscale status --json`, folded into the three facts the connect-a-phone
 * flow needs: is the CLI installed, is it signed in, and the tailnet IPv4. Lets
 * the UI tell "install Tailscale" apart from "sign in" — and offer to do the
 * latter from inside the app. Never rejects; a missing binary is `installed:false`.
 */
export function tailscaleState(): Promise<{
  installed: boolean;
  loggedIn: boolean;
  ip: string | null;
  dnsName: string | null;
  state: string | null;
}> {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return void resolve({ installed: false, loggedIn: false, ip: null, dnsName: null, state: null });
      }
      // `status --json` still prints the JSON on stdout even when it exits non-zero
      // (logged out), so parse regardless of the exit code; only ENOENT means "no CLI".
      try {
        const j = JSON.parse(stdout) as {
          BackendState?: string;
          TailscaleIPs?: string[] | null;
          Self?: { DNSName?: string };
        };
        const ip = (j.TailscaleIPs ?? []).find((a) => !a.includes(":")) ?? null;
        const dnsName = (j.Self?.DNSName ?? "").replace(/\.$/, "") || null;
        resolve({
          installed: true,
          loggedIn: j.BackendState === "Running",
          ip,
          dnsName,
          state: j.BackendState ?? null,
        });
      } catch {
        resolve({ installed: true, loggedIn: false, ip: null, dnsName: null, state: null });
      }
    });
  });
}

/**
 * Expose a local port to the public internet over Tailscale Funnel — how the
 * physical LoomPad reaches the voice backend from anywhere (a bare ESP32 can't
 * route to a 100.x tailnet address, but it can reach a Funnel's HTTPS URL).
 * `--bg` returns as soon as it's serving and prints the public URL.
 */
export function tailscaleFunnel(port: number): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    execFile("tailscale", ["funnel", "--bg", String(port)], (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      const m = out.match(/https:\/\/[^\s/]+\.ts\.net\S*/);
      if (m) return void resolve({ url: m[0].replace(/\/+$/, "") });
      const msg = out.trim().split("\n").slice(0, 3).join(" ").trim();
      reject(new Error(msg || (err ? String(err) : "Funnel did not return a URL")));
    });
  });
}

/**
 * Fallback ids for a codex too old to have `codex debug models`.
 *
 * Not the shipped set — a *previous* shipped set, which is exactly what a codex
 * without the subcommand would be running. The current one is asked of the CLI;
 * see codexModelCatalog. Anything served from here is reported as
 * `source: "builtin"`.
 */
export const CODEX_MODELS = [
  "gpt-5.5", "gpt-5.5-codex", "gpt-5.2-codex", "gpt-5.1-codex-max",
  "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5-codex", "o4-mini",
];

/**
 * Claude Code's model aliases. The only builtin list left, and it is builtin
 * because the CLI genuinely cannot answer the question.
 *
 * `claude --help` has no `models` subcommand and lists none: what it documents
 * is the shape of the argument — "Provide an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')".
 * And `claude models` is not an error, which is the trap: `models` is taken as a
 * *prompt*, so the "enumeration" is a billed turn of an LLM writing prose about
 * models, with whatever ids it believes today. A model list that costs money and
 * can hallucinate is not a model list.
 *
 * So: aliases only. They are what the CLI's own help names, they resolve to the
 * latest snapshot by definition, and they can't go stale the way a pinned
 * "claude-sonnet-5" did — an id that used to sit in this array and has never
 * been a model. Full ids belong in the picker's custom field, where they're your
 * claim rather than ours.
 */
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"];

/** Where a model list came from, so a caller can say which. */
export type ModelSource = "cli" | "builtin" | "api" | "none";

export type ModelList = { models: string[]; source: ModelSource };

export const MODEL_LIST_CACHE = new Map<string, { list: ModelList; ts: number }>();

/**
 * Whatever a CLI prints on stdout, or "" if it can't be run. Never throws.
 *
 * This is `spawn` and not `execFile` for a reason that cost an afternoon:
 * `execFile` calls back when the child's *streams* close, and `agy models`
 * leaves a language-server process holding stdout open after it exits, so
 * execFile waits out its whole timeout and hands back an empty string — the
 * Antigravity picker looked exactly like a CLI that reports no models, on a
 * machine where `agy models` prints eleven. Measured, repeatedly, one fresh
 * process per attempt: execFile 25s/0 lines, spawn 5.3s/11 lines.
 *
 * So: resolve on `exit`, with a short grace period for data still in the pipe,
 * and take `close` when it comes first (it does for every other CLI here).
 * stderr is drained and dropped — unread, a chatty CLI can fill its pipe and
 * block on the write.
 */
export function runCapture(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const MAX = 8 * 1024 * 1024;
    let out = "";
    let settled = false;
    let hard: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(drain);
      resolve(out);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return void resolve(""); // not a runnable path
    }
    hard = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < MAX) out += d.toString();
    });
    child.stderr.on("data", () => { });
    child.on("error", finish); // not installed
    child.on("close", finish); // streams closed — everything it wrote is here
    child.on("exit", () => {
      // ...unless something it spawned still holds the pipe. Give the buffered
      // bytes a moment to arrive, then take what we have.
      drain = setTimeout(finish, 300);
    });
  });
}

/** Model ids a CLI prints (one per line), ANSI stripped. Never throws. */
export function runModelList(cmd: string, args: string[]): Promise<string[]> {
  return runCapture(cmd, args).then((stdout) => {
    const models: string[] = [];
    for (const raw of stdout.split("\n")) {
      // strip ANSI + leading bullets, take the first token: grok prints
      // "  * grok-4.5 (default)", opencode a bare "provider/id" per line.
      // eslint-disable-next-line no-control-regex
      const cleaned = raw.replace(/\u001b?\[[0-9;]*m/g, "").replace(/^[\s>*+-]+/, "").trim();
      const tok = cleaned.split(/\s+/)[0] ?? "";
      if (
        /^[A-Za-z0-9][\w./:@+-]*$/.test(tok) &&
        tok.length < 120 &&
        !/^(you|default|available|logged|models?|none|error)$/i.test(tok)
      ) {
        models.push(tok);
      }
    }
    return [...new Set(models)];
  });
}

/**
 * codex's own model catalog, which it will print as JSON: `codex debug models`.
 *
 * Not a documented list command — it's under `debug` — but it is the CLI
 * answering about itself rather than us remembering, and it's the same catalog
 * the picker in codex's own TUI is built from. Each entry carries a `slug` (the
 * value `-m` takes) and a `visibility`; `hide` means internal (codex-auto-review
 * is one), and offering an agent a model its own UI won't is offering a
 * failure. ~65ms and 184KB on this machine — the base instructions for every
 * model ride along in that JSON, hence the buffer.
 *
 * Empty on any older codex that has no `debug models`, which is the caller's cue
 * to fall back and say so.
 */
export function codexModelCatalog(bin: string): Promise<string[]> {
  return runCapture(bin, ["debug", "models"]).then((stdout) => {
    try {
      const parsed = JSON.parse(stdout) as {
        models?: Array<{ slug?: unknown; visibility?: unknown }>;
      };
      const slugs = (parsed.models ?? [])
        .filter((m) => m.visibility !== "hide")
        .map((m) => String(m.slug ?? "").trim())
        .filter(Boolean);
      return [...new Set(slugs)];
    } catch {
      return []; // not JSON — an older codex, or one that errored
    }
  });
}

/**
 * The models an agent kind can run, and whether Loom asked or remembered.
 *
 * Four of the five adapters can be asked, each in its own dialect: `opencode
 * models` (~500 lines across every provider it has), `grok models`, `agy models`
 * (the Antigravity CLI — this branch was missing entirely, so its picker offered
 * "Default" and "Custom…" and nothing else), and `codex debug models`, which
 * prints a JSON catalog rather than lines. Claude Code cannot be asked at all —
 * see CLAUDE_MODELS.
 *
 * `source` is the point of the return shape. "cli" means the tool answered;
 * "builtin" means it couldn't and this is Loom's remembered list, which the UI
 * must be able to say out loud instead of implying a lookup that never
 * happened. An uninstalled CLI answers with nothing, and an empty answer from a
 * CLI is still "cli" — an empty picker for a tool you don't have is the honest
 * result, not a reason to serve it a remembered list behind its back. codex is
 * the one exception: an empty answer there can equally mean a codex too old to
 * have `debug models`, so it falls back — and "builtin" is the true label for
 * whichever of the two it was.
 *
 * Cached 60s per kind: the pickers reopen constantly and none of these change
 * between two clicks.
 */
export async function listModelsForKind(kind: string): Promise<ModelList> {
  const hit = MODEL_LIST_CACHE.get(kind);
  if (hit && Date.now() - hit.ts < 60_000) return hit.list;
  let list: ModelList = { models: [], source: "none" };
  if (kind === "opencode") {
    list = { models: await runModelList("opencode", ["models"]), source: "cli" };
  } else if (kind === "grok-code") {
    list = { models: await runModelList(grokBin() ?? "grok", ["models"]), source: "cli" };
  } else if (kind === "antigravity-cli") {
    list = { models: await runModelList(agyBin() ?? "agy", ["models"]), source: "cli" };
  } else if (kind === "codex") {
    const slugs = await codexModelCatalog(codexBin() ?? "codex");
    list = slugs.length ? { models: slugs, source: "cli" } : { models: CODEX_MODELS, source: "builtin" };
  } else if (kind === "claude-code") {
    list = { models: CLAUDE_MODELS, source: "builtin" };
  } else if (kind === "model") {
    // Not a CLI to ask and not a list to hardcode: the providers themselves
    // say what they have, and it changes under you (see #82).
    const { models } = await allModels();
    list = { models: models.map((m) => `${m.provider}/${m.id}`), source: "api" };
  }
  MODEL_LIST_CACHE.set(kind, { list, ts: Date.now() });
  return list;
}

/**
 * Bring Tailscale up from inside the app. Runs `tailscale up`; if the machine
 * needs to sign in, that prints a one-time login URL and then blocks until the
 * user authorizes — so we resolve with the URL as soon as we see it and leave
 * the process running (unref'd) to finish the handshake in the background. If it
 * was already signed in, `up` returns fast and we resolve with the tailnet IP.
 */
export function tailscaleUp(): Promise<{ loginUrl?: string; ip?: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("tailscale", ["up"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return void reject(err instanceof Error ? err : new Error(String(err)));
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const scan = (buf: Buffer) => {
      const m = buf.toString().match(/https:\/\/login\.tailscale\.com\/\S+/);
      if (m) settle(() => {
        child.unref(); // keep it running in the background to finish the login
        resolve({ loginUrl: m[0] });
      });
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", () => {
      // Exited before printing a URL: either it was already up, or it failed.
      if (settled) return;
      tailscaleIp().then(
        (ip) => settle(() => resolve({ ip })),
        () => settle(() => reject(new Error("tailscale up exited without a login URL"))),
      );
    });
    setTimeout(() => settle(() => reject(new Error("timed out waiting for Tailscale to start"))), 25_000);
  });
}

/**
 * This machine's LAN IPv4 — the address a phone on the same Wi-Fi uses. We skip
 * loopback, link-local (169.254), and Tailscale's own 100.64/10 CGNAT range so
 * "local network" and "tailnet" stay distinct choices. Returns null when the
 * only addresses are loopback (e.g. no network) — the caller says so honestly
 * rather than minting an unreachable QR.
 */
export function lanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // link-local, not routable
      if (a.address.startsWith("100.")) continue; // Tailscale CGNAT — that's the tailnet
      candidates.push(a.address);
    }
  }
  // Prefer the common private ranges (a real LAN) over anything exotic.
  const priv = candidates.find(
    (ip) => ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
  );
  return priv ?? candidates[0] ?? null;
}

/** Is this connection from the same machine? (127.0.0.1, ::1, or v4-mapped v6.) */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

/**
 * Is the request's `Host` header a loopback literal? The anti-DNS-rebinding
 * check: a rebinding attacker loads a page from their own domain, so the browser
 * sends `Host: attacker.example` even after the name rebinds to 127.0.0.1 — while
 * the genuine local console is always reached at `127.0.0.1`/`localhost`. Pairing
 * the socket check with this closes the "any website → localhost token oracle"
 * path. The port is ignored; only the host is checked.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) || []).length === 1) {
    host = host.slice(0, host.indexOf(":")); // strip the port off host:port
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
