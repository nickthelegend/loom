#!/usr/bin/env node
/**
 * loom — one CLI for all your coding agents.
 *
 * Weaves Claude Code, OpenCode (and bridges like Antigravity) into a single
 * shared thread per project: one conversation, one baton, shared memory.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import qrcode from "qrcode-terminal";
import type { LoomEvent, ProjectStatus } from "../types.js";
import type { QueueItem } from "../core/prompt-queue.js";
import {
  DaemonClient,
  DaemonError,
  daemonRunning,
  ensureDaemon,
  stopDaemon,
} from "../daemon/client.js";
import { installCrashGuards } from "../daemon/guards.js";
import { LoomDaemon, DEFAULT_PORT } from "../daemon/server.js";
import { ensureLoomHome, loomHome } from "../core/registry.js";
import { VERSION } from "../version.js";
import {
  allModels,
  fetchModels,
  forgetProvider,
  listProviders,
  resolveProvider,
  setProvider,
} from "../core/providers.js";
import { serviceFile, tokenFindings } from "../core/runner-setup.js";
import { readRunnerConfig, readRunnerToken, scrubEnv, writeRunnerToken } from "../daemon/runner.js";
import { NoProjectError, currentProjectDir, resolveCurrentProject } from "./common.js";
import { fmtUsd, formatAgentRosterRow, formatAgentRow, formatEvent, formatProjectRow } from "./ui.js";

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Where a background daemon's output goes: ~/.loom/daemon.log, appended.
 *
 * Rolled to .log.1 once it passes 5MB — one generation, because this is a
 * breadcrumb trail for "why did it die", not an archive. Without this the
 * daemon ran with stdio:"ignore" and a crash left nothing at all to read.
 */
function openDaemonLog(): number {
  const home = ensureLoomHome();
  const file = path.join(home, "daemon.log");
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + ".1");
  } catch {
    /* no log yet, or it vanished — either way, open a fresh one below */
  }
  return fs.openSync(file, "a");
}

const program = new Command();

program
  .name("loom")
  .description("one CLI for all your coding agents — shared thread, shared memory, one baton")
  .version(VERSION);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(pc.red(`✗ ${message}`));
  process.exit(1);
}

/** A hosted-hub session: a local browser (loopback), or --paste for machines without one (D74). */
async function hostedSession(supabaseUrl: string, publishableKey: string, paste: boolean): Promise<{ refreshToken: string }> {
  const { hostedSignIn, openInBrowser, pasteSignIn } = await import("../hub/supabase-client.js");
  if (paste) {
    return pasteSignIn({
      supabaseUrl,
      publishableKey,
      ask: async (url) => {
        console.log(`${pc.bold("sign in with GitHub")} — open this on any device:\n\n  ${url}\n`);
        console.log(pc.dim("you'll land on a page that won't load; copy its whole address and paste it here."));
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const line = await new Promise<string>((resolve) => rl.question("address: ", resolve));
        rl.close();
        return line;
      },
    });
  }
  console.log(pc.dim("signing in to the hosted Loom Team Hub with GitHub…"));
  return hostedSignIn({
    supabaseUrl,
    publishableKey,
    openBrowser: (url) => {
      console.log(`${pc.dim("  if your browser didn't open:")} ${url}`);
      openInBrowser(url);
    },
  });
}

async function currentProject(client: DaemonClient): Promise<ProjectStatus> {
  try {
    return await resolveCurrentProject(client);
  } catch (err) {
    if (err instanceof NoProjectError) fail(err.message);
    throw err;
  }
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} ${pc.dim("[y/N]")} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function printEvent(e: LoomEvent): void {
  const line = formatEvent(e);
  if (line) console.log(line);
}

// ---------------------------------------------------------------------------
// tui — the default face of loom (bare `loom` lands here)
// ---------------------------------------------------------------------------

program
  .command("tui", { isDefault: true })
  .description("full-screen TUI: one thread, tab shifts agents (default command)")
  .action(async () => {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      fail("the loom TUI needs a TTY — use `loom chat`, `loom send`, or `loom log` here");
    }
    const { runTui } = await import("./tui.js");
    await runTui();
  });

// ---------------------------------------------------------------------------
// daemon / up / down / status
// ---------------------------------------------------------------------------

program
  .command("daemon")
  .description("run the loom daemon in the foreground")
  .option("--port <port>", "port to listen on", String(DEFAULT_PORT))
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--tailnet", "bind to this machine's Tailscale IP (phone access)", false)
  .action(async (opts: { port: string; host: string; tailnet: boolean }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(pc.red(`✗ invalid --port "${opts.port}"`));
      process.exit(1);
    }
    // A runner box's agents don't inherit its secrets (Loom Teams D70).
    if (readRunnerConfig().enabled) {
      const { env, removed } = scrubEnv(process.env);
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      if (removed.length) console.log(pc.dim(`runner: kept ${removed.length} secret-looking variable${removed.length === 1 ? "" : "s"} away from agents`));
    }
    const token = readRunnerToken();
    if (readRunnerConfig().enabled && token && !process.env.GH_TOKEN) process.env.GH_TOKEN = token;
    const daemon = new LoomDaemon({ host: opts.host, port });
    let bound: { host: string; port: number };
    try {
      bound = await daemon.listen({ tailnet: opts.tailnet });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        console.error(
          pc.red(`✗ port ${port} is already in use`) +
            pc.dim(` — a daemon may already be running. Try \`loom up\`, or \`loom daemon --port <other>\`.`),
        );
      } else {
        console.error(pc.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exit(1);
    }
    console.log(pc.green(`loom daemon listening on http://${bound.host}:${bound.port}`));
    if (opts.tailnet) {
      console.log(pc.dim("bound to the tailnet — pair your phone with `loom pair`"));
    }
    const shutdown = () => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Survive the faults that would otherwise take every project down with
    // them; they land in ~/.loom/daemon.log. See daemon/guards.ts.
    installCrashGuards();
  });

program
  .command("up")
  .description("start the loom daemon in the background")
  .option("--tailnet", "bind to this machine's Tailscale IP", false)
  .option("--restart", "restart even if a daemon is already running", false)
  .action(async (opts: { tailnet: boolean; restart: boolean }) => {
    const running = await daemonRunning();
    if (running) {
      const { BUILD_REV } = await import("../daemon/server.js");
      const health = (await fetch(`http://${running.host}:${running.port}/api/health`)
        .then((r) => r.json())
        .catch(() => ({}))) as { rev?: string };
      const stale = health.rev !== BUILD_REV;
      if (!opts.restart && !stale) {
        console.log(pc.dim("daemon already running (loom up --restart to bounce it)"));
        return;
      }
      console.log(pc.dim(stale ? "daemon is running an older build — restarting" : "restarting daemon"));
      await stopDaemon();
      const gone = Date.now() + 6000;
      while (Date.now() < gone && (await daemonRunning())) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const self = fileURLToPath(import.meta.url);
    const args = [self, "daemon", ...(opts.tailnet ? ["--tailnet"] : [])];
    // Keep the daemon's output. It used to be stdio:"ignore", which meant a
    // background daemon threw away every byte it ever wrote — a crash left you
    // with nothing to read. Appended, and rolled once it gets big, so it can't
    // quietly eat the disk either.
    const log = openDaemonLog();
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const cfg = await daemonRunning();
      if (cfg) {
        console.log(pc.green(`✓ daemon up on http://${cfg.host}:${cfg.port}`));
        return;
      }
    }
    fail("daemon did not become healthy — try `loom daemon` in the foreground");
  });

program
  .command("down")
  .description("stop the background daemon")
  .action(async () => {
    if (await stopDaemon()) console.log(pc.green("✓ daemon stopped"));
    else console.log(pc.dim("no running daemon found"));
  });

program
  .command("status")
  .description("daemon health and project board")
  .action(async () => {
    const cfg = await daemonRunning();
    if (!cfg) {
      console.log(pc.dim("daemon: not running (loom up)"));
      return;
    }
    console.log(pc.green(`daemon: http://${cfg.host}:${cfg.port}`));
    const client = new DaemonClient(cfg);
    const { projects } = await client.listProjects();
    if (!projects.length) console.log(pc.dim("no projects yet — loom init"));
    for (const p of projects) console.log(formatProjectRow(p));
  });

// ---------------------------------------------------------------------------
// init / projects / agents
// ---------------------------------------------------------------------------

program
  .command("init")
  .description("make the current directory a Loom project")
  .option("--name <name>", "project name (default: directory name)")
  .action(async (opts: { name?: string }) => {
    const client = await ensureDaemon();
    const dir = process.cwd();
    const res = await client.addProject(dir, opts.name);
    const { project } = await client.project(res.project.id);
    console.log(pc.green(`✓ project "${project.name}" (${project.id})`));
    for (const a of project.agents) console.log(formatAgentRow(a));
    console.log(pc.dim("\nedit .loom/config.json to add/remove agents or change roles"));
    console.log(pc.dim("then: loom chat"));
  });

program
  .command("projects")
  .description("board of all projects")
  .option("--forget <idOrName>", "stop tracking a project (its .loom/ stays on disk)")
  .action(async (opts: { forget?: string }) => {
    const client = await ensureDaemon();
    if (opts.forget) {
      const { projects } = await client.listProjects();
      const hit = projects.find((p) => p.id === opts.forget || p.name === opts.forget);
      if (!hit) {
        console.error(pc.red(`no project "${opts.forget}"`));
        process.exitCode = 1;
        return;
      }
      const r = await client.forgetProject(hit.id);
      console.log(`forgot ${pc.bold(hit.name)} — ${pc.dim(hit.dir)}`);
      // Say what was kept. "Removed" against a tool that also owns your event
      // log reads as "deleted", and someone who believes that will not go
      // looking for the history that is still sitting there.
      console.log(pc.dim(`its ${r.keptOnDisk} is untouched — add the directory again to restore it`));
      return;
    }
    const { projects } = await client.listProjects();
    if (!projects.length) console.log(pc.dim("no projects yet — loom init"));
    for (const p of projects) console.log(formatProjectRow(p));
  });

program
  .command("agents")
  .description("list agent ids, kinds, roles, models, and baton eligibility")
  .option("--json", "print the agent roster as JSON")
  .action(async (opts: { json: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    if (opts.json) {
      console.log(JSON.stringify(project.agents));
      return;
    }
    if (!project.agents.length) {
      console.log(pc.dim("no agents configured — edit .loom/config.json or run loom init"));
      return;
    }
    for (const a of project.agents) console.log(formatAgentRosterRow(a));
  });

program
  .command("providers")
  .description("where model agents send their turns, and whether each has a key")
  .action(() => {
    const rows = listProviders();
    for (const p of rows) {
      const mark = p.configured ? pc.green("\u2713") : pc.dim("\u00b7");
      const key = p.configured ? pc.dim(p.hint ? `${p.hint} (${p.source})` : "no key needed") : pc.dim("not configured");
      console.log(`${mark} ${pc.bold(p.id.padEnd(13))} ${pc.dim(p.baseUrl.padEnd(34))} ${key}`);
      if (p.note) console.log(pc.dim(`    ${p.note}`));
    }
    console.log(
      pc.dim("\nkeys live in ~/.loom/providers.json (0600) or the environment \u2014 never in a project"),
    );
  });

program
  .command("providers:set <id>")
  .description("set a provider's key, base URL or headers (a key is never printed back)")
  .option("--key <key>", "the API key; prefer the environment on a shared machine")
  .option("--base-url <url>", "for a custom provider, or to override a known one")
  .option("--label <label>", "what to call it")
  .option("--header <kv...>", "extra header, as name=value")
  .action((id: string, opts: { key?: string; baseUrl?: string; label?: string; header?: string[] }) => {
    const headers: Record<string, string> = {};
    for (const kv of opts.header ?? []) {
      const at = kv.indexOf("=");
      if (at < 1) fail(`--header wants name=value, not "${kv}"`);
      headers[kv.slice(0, at).trim()] = kv.slice(at + 1).trim();
    }
    try {
      setProvider(id, {
        ...(opts.key ? { key: opts.key } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.label ? { label: opts.label } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    const row = listProviders().find((p) => p.id === id.toLowerCase());
    console.log(`${pc.green("\u2713")} ${id}: ${row?.baseUrl ?? ""} ${pc.dim(row?.hint ?? "")}`);
  });

program
  .command("providers:rm <id>")
  .description("forget a provider's key and settings")
  .action((id: string) => {
    console.log(forgetProvider(id) ? `${pc.red("-")} ${id} forgotten` : pc.dim(`nothing stored for ${id}`));
  });

program
  .command("routes:save <name> <steps...>")
  .description(
    'define a named route, e.g. loom routes:save ship planner executor reviewer\n' +
      "  a step may carry a condition on the previous turn: 'reviewer?lines>200'\n" +
      "  (changed>N, changed<N, lines>N, lines<N, touched:<glob>, !touched:<glob>)",
  )
  .action(async (name: string, steps: string[]) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      await client.saveRoute(project.id, name, steps);
      console.log(`${pc.green("✓")} ${name}: ${steps.join(" → ")}`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("routes:rm <name>")
  .description("remove a named route")
  .action(async (name: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      await client.deleteRoute(project.id, name);
      console.log(`${pc.red("-")} ${name} removed`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("retry <agentId>")
  .description("re-run the last failed turn on a different agent, failure attached as context")
  .action(async (agentId: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      const { retried } = await client.retryTurn(project.id, agentId);
      console.log(`${pc.green("↻")} ${pc.bold(agentId)} retrying: ${pc.dim(retried.slice(0, 80))}`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("version")
  .description("CLI build vs the daemon's — the mismatch loom up --restart fixes")
  .action(async () => {
    const { BUILD_REV } = await import("../daemon/server.js");
    console.log(`cli     ${BUILD_REV}`);
    try {
      const client = await ensureDaemon();
      const v = await client.version();
      const stale = v.rev !== BUILD_REV;
      console.log(`daemon  ${v.rev}  ${pc.dim(`node ${v.node} · up ${Math.round(v.uptimeSec / 60)}m`)}`);
      if (stale) console.log(pc.yellow("daemon is running an older build — loom up --restart"));
    } catch {
      console.log(pc.dim("daemon  not running"));
    }
  });

program
  .command("brain:forget <memoryId>")
  .description("forget one memory unit (its history stays in the log)")
  .action(async (memoryId: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      await client.forgetMemory(project.id, memoryId);
      console.log(`${pc.red("-")} ${memoryId} forgotten`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("open")
  .description("open this machine's Loom app in the browser")
  .action(async () => {
    const client = await ensureDaemon();
    const url = `${client.baseUrl}/app`;
    console.log(url);
    const { spawn: sp } = await import("node:child_process");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    sp(opener, [url], { detached: true, stdio: "ignore" }).unref();
  });

program
  .command("rename <name...>")
  .description("rename this project (the id never moves, so nothing orphans)")
  .action(async (words: string[]) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const name = words.join(" ");
    await client.renameProject(project.id, name);
    console.log(`${pc.green("✓")} ${project.name} → ${pc.bold(name)}`);
  });

program
  .command("find <query...>")
  .description("search this project's thread — messages, decisions, questions")
  .action(async (words: string[]) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { hits } = await client.searchEvents(project.id, words.join(" "));
    if (!hits.length) return void console.log(pc.dim("nothing matches"));
    for (const e of hits) {
      const t = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
      const who = e.agentId ? pc.cyan(e.agentId) : pc.dim("you");
      console.log(`${pc.dim(t)} ${who}  ${String(e.payload.text ?? e.payload.question ?? "").slice(0, 110)}`);
    }
  });

program
  .command("specs")
  .description("the project's Playwright specs, and whether one is running")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { specs, running } = await client.listSpecs(project.id);
    if (!specs.length) return void console.log(pc.dim("no *.spec.* / *.e2e.* files here"));
    for (const s of specs) {
      const live = running?.file === s.path ? pc.green("  ← running") : "";
      console.log(`${s.path}${live}`);
    }
  });

program
  .command("specs:run <file>")
  .description("run one Playwright spec through the daemon")
  .option("--wait", "block until the verdict lands, and exit 1 on failure")
  .action(async (file: string, opts: { wait?: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      const { run } = await client.runSpec(project.id, file);
      if (!opts.wait) {
        console.log(`${pc.cyan("▶")} ${run.file} ${pc.dim(`run ${run.id} — reporter streams to the app; result lands in the Console`)}`);
        return;
      }
      // Poll the runner state; the verdict is in the Console either way, but
      // --wait exists so scripts and CI get an exit code, not a suggestion.
      console.log(`${pc.cyan("▶")} ${run.file} ${pc.dim("waiting for the verdict…")}`);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const { running } = await client.listSpecs(project.id);
        if (!running || running.id !== run.id) break;
      }
      const { logs } = await client.logs({ level: undefined });
      const verdict = [...logs].reverse().find(
        (l) => l.scope === "specs" && l.message.includes(run.file),
      );
      if (verdict?.message.includes("passed")) {
        console.log(`${pc.green("✓")} ${verdict.message}`);
      } else {
        console.error(pc.red(`✗ ${verdict?.message ?? "no verdict recorded"}`));
        if (verdict?.detail) console.error(pc.dim(verdict.detail.split("\n").slice(-12).join("\n")));
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("stale")
  .description("sessions that look hung — busy far longer than any plausible turn")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { stale } = await client.staleSessions(project.id);
    if (!stale.length) return void console.log(pc.dim("nothing looks hung"));
    for (const s of stale) {
      console.log(`${pc.red(s.agentId)}  busy ${Math.round(s.busyMs / 60000)}m  ${pc.dim(`— loom reap ${s.agentId}`)}`);
    }
  });

program
  .command("reap <agentId>")
  .description("put a hung session out of its misery and respawn it fresh")
  .action(async (agentId: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      await client.reapSession(project.id, agentId);
      console.log(`${pc.green("✓")} ${agentId} respawned — baton released if it held it`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("brain:search <query...>")
  .description("retrieval, exactly as a briefing would see it — scores and all")
  .option("--explain", "show the arithmetic per hit (bm25, entity, fuzzy, dense, recency)")
  .action(async (words: string[], opts: { explain?: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { hits } = await client.searchBrain(project.id, words.join(" "), {
      explain: Boolean(opts.explain),
    });
    if (!hits.length) return void console.log(pc.dim("nothing retrieved — the briefing would carry no memories for this"));
    for (const h of hits) {
      console.log(
        `${pc.bold((h.score.toFixed(2)))} ${pc.magenta(h.memory.kind.padEnd(10))} ${h.memory.text.slice(0, 100)}`,
      );
      if (opts.explain && h.detail) console.log(pc.dim(`      ${JSON.stringify(h.detail)}`));
    }
  });

program
  .command("brain:conflicts")
  .description("units that likely contradict each other, for you to resolve")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { conflicts } = await client.brainConflicts(project.id);
    if (!conflicts.length) return void console.log(pc.dim("no likely contradictions"));
    for (const c of conflicts) {
      console.log(`${pc.yellow(c.signal)} ${pc.dim(`(${Math.round(c.similarity * 100)}% same topic)`)}`);
      console.log(`  A: ${c.a.text.slice(0, 90)}`);
      console.log(`  B: ${c.b.text.slice(0, 90)}`);
    }
  });

program
  .command("mcp:health")
  .description("each MCP server's live state, from the background poll")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { health } = await client.mcpHealth(project.id);
    const rows = Object.entries(health);
    if (!rows.length) return void console.log(pc.dim("no MCP servers configured (or none probed yet)"));
    for (const [name, h] of rows) {
      const age = Math.round((Date.now() - h.probedAt) / 1000);
      console.log(
        `${name.padEnd(20)} ${h.up ? pc.green("up") : pc.red(`down ×${h.failures}`)}  ${pc.dim(`${age}s ago`)}`,
      );
    }
  });

program
  .command("snapshot [file]")
  .description("checkpoint this project's brain + board + config to a file")
  .action(async (file: string | undefined) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const doc = await client.snapshot(project.id);
    const out = file ?? `loom-snapshot-${project.name}.json`;
    const fs = await import("node:fs");
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
    const mems = ((doc.brain as { memories?: unknown[] })?.memories ?? []).length;
    const tasks = ((doc.tasks as unknown[]) ?? []).length;
    console.log(`${pc.green("✓")} ${out} ${pc.dim(`· ${mems} memories · ${tasks} cards`)}`);
  });

program
  .command("restore <file>")
  .description("bring a snapshot back — board and config replace, the brain merges")
  .action(async (file: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const fs = await import("node:fs");
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.error(pc.red(`could not read ${file}: ${err instanceof Error ? err.message : err}`));
      process.exitCode = 1;
      return;
    }
    try {
      const out = await client.restore(project.id, doc);
      console.log(
        `${pc.green("✓")} restored ${pc.dim(`· brain +${out.brain.added} (${out.brain.known} known) · ${out.tasks} cards`)}`,
      );
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("task <title...>")
  .description("put a card on the board")
  .option("--agent <id>", "who it's for")
  .option("--column <col>", "working | needs-you | in-review | ready", "needs-you")
  .option("--blocked-by <ids>", "comma-separated task ids this one waits on")
  .action(async (words: string[], opts: { agent?: string; column: string; blockedBy?: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { task } = await client.createTask(project.id, words.join(" "), {
      column: opts.column,
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.blockedBy ? { blockedBy: opts.blockedBy.split(",").map((s) => s.trim()) } : {}),
    });
    console.log(`${pc.green("+")} ${task.id} ${pc.dim(task.column)}  ${task.title}`);
  });

program
  .command("tasks")
  .description("the cards you wrote, by column")
  .option("--json", "print as JSON")
  .action(async (opts: { json?: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { tasks } = await client.listTasks(project.id);
    if (opts.json) return void console.log(JSON.stringify(tasks, null, 2));
    if (!tasks.length) return void console.log(pc.dim("no cards — loom task <title> makes one"));
    for (const t of tasks) {
      const blocked = t.blockedBy?.length ? pc.red(` ⛔${t.blockedBy.join(",")}`) : "";
      console.log(`${t.id}  ${t.column.padEnd(9)} ${t.agent ? pc.cyan(t.agent.padEnd(14)) : "".padEnd(14)} ${t.title}${blocked}`);
    }
  });

program
  .command("budgets")
  .description("each agent's daily USD cap and today's real spend against it")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { status } = await client.budgets(project.id);
    const rows = Object.entries(status);
    if (!rows.length) {
      console.log(pc.dim("no caps set — loom budget <agentId> <usd> to add one"));
      return;
    }
    for (const [agentId, s] of rows) {
      const bar = s.over ? pc.red("OVER — paused") : pc.dim(`${Math.round((s.spentTodayUsd / s.budgetUsd) * 100)}%`);
      console.log(
        `${agentId.padEnd(18)} $${s.spentTodayUsd.toFixed(2)} / $${s.budgetUsd.toFixed(2)}  ${bar}`,
      );
    }
  });

program
  .command("budget <agentId> [usd]")
  .description("cap an agent's daily spend in USD — agentId 'all' caps every adapter (0 clears)")
  .action(async (agentId: string, usd: string | undefined) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const value = usd === undefined ? 0 : Number(usd);
    if (Number.isNaN(value) || value < 0) {
      console.error(pc.red(`"${usd}" is not a dollar amount`));
      process.exitCode = 1;
      return;
    }
    if (agentId === "all") {
      const adapters = project.agents.filter((a) => a.tier === "adapter");
      for (const a of adapters) await client.setBudget(project.id, a.id, value);
      console.log(
        value > 0
          ? `${pc.green("✓")} ${adapters.length} adapters capped at $${value.toFixed(2)}/day each`
          : `${pc.green("✓")} ${adapters.length} adapters uncapped`,
      );
      return;
    }
    await client.setBudget(project.id, agentId, value);
    console.log(
      value > 0
        ? `${pc.green("✓")} ${agentId} capped at $${value.toFixed(2)}/day — over the cap it pauses, hard`
        : `${pc.green("✓")} ${agentId} uncapped`,
    );
  });

program
  .command("watch")
  .description("tail this project's events live — turns, handoffs, memory, subtasks")
  .option("--all", "watch every project, prefixed with the project id")
  .option("--json", "one JSON event per line, for piping")
  .action(async (opts: { all?: boolean; json?: boolean }) => {
    const client = await ensureDaemon();
    const project = opts.all ? null : await currentProject(client);

    /**
     * One line per event, shaped for a human at a terminal. Everything else in
     * the log still flows — this names the kinds worth a glance and lets the
     * rest pass as a dim one-liner rather than pretending they don't exist.
     */
    const line = (e: import("../types.js").LoomEvent): string => {
      const t = new Date(e.ts).toTimeString().slice(0, 8);
      const who = e.agentId ? pc.cyan(e.agentId) : pc.dim("you");
      const p = e.payload as Record<string, unknown>;
      switch (e.kind) {
        case "message":
          return `${t} ${who} ${String(p.text ?? "").slice(0, 100)}`;
        case "handoff":
          return `${t} ${pc.yellow("baton")} ${String(p.from ?? "—")} → ${String(p.to ?? "—")}`;
        case "run_complete":
          return `${t} ${who} ${pc.green("turn done")}`;
        case "needs_input":
          return `${t} ${who} ${pc.red("needs you")}: ${String(p.question ?? "").slice(0, 80)}`;
        case "decision":
          return `${t} ${who} ${pc.magenta("decision")} ${String(p.text ?? "").slice(0, 90)}`;
        case "memory_add":
          return `${t} ${who} ${pc.magenta("learned")} ${String((p.memory as Record<string, unknown> | undefined)?.text ?? "").slice(0, 90)}`;
        case "subtask_started":
          return `${t} ${who} ${pc.cyan("subtask")} for ${String(p.parent)}: ${String(p.task ?? "").slice(0, 70)}`;
        case "subtask_done":
          return `${t} ${who} ${pc.green("subtask done")}`;
        case "subtask_failed":
          return `${t} ${who} ${pc.red("subtask failed")}: ${String(p.message ?? "").slice(0, 80)}`;
        case "error":
          return `${t} ${who} ${pc.red("error")} ${String(p.message ?? "").slice(0, 90)}`;
        case "route_started":
        case "route_step":
        case "route_completed":
        case "route_failed":
          return `${t} ${pc.yellow(e.kind.replace("route_", "route "))} ${String(p.route ?? p.name ?? "")}`;
        default:
          return pc.dim(`${t} ${e.kind}`);
      }
    };

    console.log(
      pc.dim(
        project
          ? `watching ${project.name} — ^C to stop`
          : "watching every project — ^C to stop",
      ),
    );
    const close = client.subscribe((pid, e) => {
      if (opts.json) {
        console.log(JSON.stringify(opts.all ? { project: pid, ...e } : e));
        return;
      }
      const prefix = opts.all ? pc.dim(`[${pid.slice(0, 8)}] `) : "";
      console.log(prefix + line(e));
    }, project?.id);

    // Keep the process alive until ^C; close the socket on the way out so the
    // daemon isn't left holding a dead subscriber.
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        close();
        console.log();
        resolve();
      });
    });
  });

program
  .command("brain:export [file]")
  .description("write this project's brain to a file (or stdout) so it can travel")
  .action(async (file: string | undefined) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const doc = await client.exportBrain(project.id);
    const json = JSON.stringify(doc, null, 2);
    if (file) {
      const fs = await import("node:fs");
      fs.writeFileSync(file, json + "\n");
      const n = (doc as { memories?: unknown[] }).memories?.length ?? 0;
      console.log(`${pc.green("✓")} ${n} memor${n === 1 ? "y" : "ies"} → ${file}`);
    } else {
      console.log(json);
    }
  });

program
  .command("brain:import <file>")
  .description("bring an exported brain into this project (dedupes what's already known)")
  .action(async (file: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const fs = await import("node:fs");
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.error(pc.red(`could not read ${file}: ${err instanceof Error ? err.message : err}`));
      process.exitCode = 1;
      return;
    }
    try {
      const { added, known } = await client.importBrain(project.id, doc);
      console.log(
        `${pc.green("✓")} ${added} learned${known ? pc.dim(` · ${known} already known`) : ""}`,
      );
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("spawn <task>")
  .description("fan a subtask out to a child agent — the parent keeps the baton")
  .option("--agent <id>", "which agent runs the subtask")
  .option("--parent <id>", "the agent asking (default: whoever holds the baton)")
  .action(async (task: string, opts: { agent?: string; parent?: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const parent = opts.parent ?? project.holder ?? project.agents[0]?.id;
    if (!parent) {
      console.error(pc.red("this project has no agents to parent a subtask"));
      process.exitCode = 1;
      return;
    }
    // Default the child to an agent that isn't the parent — the whole point is
    // another pair of hands, so borrowing the parent's own would just be a turn.
    const child =
      opts.agent ??
      project.agents.find((a) => a.id !== parent && a.tier === "adapter" && a.enabled !== false)?.id;
    if (!child) {
      console.error(pc.red("no other adapter available to run the subtask — add one, or pass --agent"));
      process.exitCode = 1;
      return;
    }
    try {
      const out = await client.spawnSubtask(project.id, parent, child, task);
      console.log(
        `${pc.cyan("↳")} ${pc.bold(out.agentId)} ${pc.dim(`subtask ${out.id}`)}\n` +
          pc.dim(`  ${parent} keeps the baton; the result lands in the thread under its turn`),
      );
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

// ── orchestra: one orchestrator, many parallel workers (core/orchestra.ts) ──

const RUN_DONE = new Set(["completed", "failed", "aborted", "waiting_human"]);
const TASK_COLOR: Record<string, (s: string) => string> = {
  done: pc.green,
  running: pc.cyan,
  pending: pc.dim,
  failed: pc.red,
  conflict: pc.yellow,
  needs_input: pc.yellow,
  cancelled: pc.dim,
};

function printRun(run: import("../core/orchestra.js").OrchestraRun): void {
  const done = run.tasks.filter((t) => t.status === "done").length;
  console.log(
    `${pc.magenta("🎼")} ${pc.bold(run.id)} ${pc.dim(run.status)}  ${done}/${run.tasks.length} tasks · ` +
      `round ${run.round}/${run.maxRounds} · ${fmtUsd(run.costUsd)} · ${pc.dim(run.branch)}`,
  );
  console.log(`   ${pc.dim("goal")} ${run.goal}`);
  console.log(`   ${pc.dim("orchestrator")} ${run.orchestrator.agent}  ${pc.dim("workers")} ${run.workers.join(", ")}`);
  for (const t of run.tasks) {
    const color = TASK_COLOR[t.status] ?? ((x: string) => x);
    const deps = t.dependsOn.length ? pc.dim(` after ${t.dependsOn.join(",")}`) : "";
    const files = t.files?.length ? pc.dim(` · ${t.files.length} file${t.files.length === 1 ? "" : "s"}`) : "";
    console.log(`   ${color(t.status.padEnd(11))} ${pc.bold(t.id)} ${t.title} ${pc.dim(`→ ${t.agent}`)}${deps}${files}`);
    if (t.hold) console.log(`               ${pc.yellow(`held (${t.hold.kind}):`)} ${t.hold.reason.slice(0, 200)}`);
    if (t.error) console.log(`               ${pc.red(t.error.split("\n")[0]!.slice(0, 160))}`);
  }
  if (run.question) console.log(`   ${pc.yellow("asks:")} ${run.question}  ${pc.dim(`(loom orchestra:reply ${run.id} "…")`)}`);
  if (run.summary) console.log(`   ${pc.green("summary:")} ${run.summary}`);
  if (run.error) console.log(`   ${pc.red("error:")} ${run.error}`);
  if (run.status === "completed" && !run.applied) console.log(pc.dim(`   apply it: loom orchestra:apply ${run.id}`));
}

async function watchRun(client: Awaited<ReturnType<typeof ensureDaemon>>, projectId: string, runId: string): Promise<void> {
  let last = "";
  for (;;) {
    const { run } = await client.orchestraRun(projectId, runId);
    const line = `${run.status}|${run.tasks.map((t) => `${t.id}:${t.status}`).join(",")}`;
    if (line !== last) {
      last = line;
      const stamp = new Date().toLocaleTimeString();
      console.log(
        pc.dim(stamp) + " " + pc.bold(run.status) + "  " +
          run.tasks.map((t) => (TASK_COLOR[t.status] ?? ((x: string) => x))(`${t.id}[${t.agent}]`)).join(" "),
      );
    }
    if (RUN_DONE.has(run.status)) {
      console.log("");
      printRun(run);
      if (run.status === "failed" || run.status === "aborted") process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

program
  .command("orchestrate <goal>")
  .description("one orchestrator plans the goal; many worker agents build it in parallel, each in its own worktree")
  .option("-o, --orchestrator <agent>", "who plans and reviews (default: claude-code if present)")
  .option("-w, --workers <agents>", "comma-separated worker agents (default: every agent in the project)")
  .option("-p, --parallel <n>", "tasks running at once (1-12, default 4)")
  .option("--rounds <n>", "orchestrator review rounds before giving up (default 10)")
  .option("--plan", "plan mode: write the plan as markdown specs under plans/<run>/ that any agent can pick up")
  .option("--max-usd <n>", "stop this goal when it has spent this much, and say so")
  .option("--no-watch", "start it and return instead of following it to the end")
  .action(async (goal: string, opts: { orchestrator?: string; workers?: string; parallel?: string; rounds?: string; plan?: boolean; maxUsd?: string; watch: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      const { run } = await client.startOrchestra(project.id, {
        goal,
        ...(opts.orchestrator ? { orchestrator: opts.orchestrator } : {}),
        ...(opts.workers ? { workers: opts.workers.split(",").map((w) => w.trim()).filter(Boolean) } : {}),
        ...(opts.parallel ? { maxParallel: Number(opts.parallel) } : {}),
        ...(opts.rounds ? { maxRounds: Number(opts.rounds) } : {}),
        ...(opts.plan ? { plan: true } : {}),
        ...(opts.maxUsd ? { maxUsd: Number(opts.maxUsd) } : {}),
      });
      console.log(
        `${pc.magenta("🎼")} ${pc.bold(run.id)} started — ${pc.bold(run.orchestrator.agent)} orchestrating ` +
          `${run.workers.join(", ")} (${run.maxParallel} in parallel) on ${pc.dim(run.branch)}`,
      );
      if (opts.watch) await watchRun(client, project.id, run.id);
      else console.log(pc.dim(`  follow it: loom orchestra ${run.id} --watch`));
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("orchestra [runId]")
  .description("orchestra runs in this project — or one run in detail")
  .option("--watch", "follow the run until it finishes")
  .action(async (runId: string | undefined, opts: { watch?: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      if (runId) {
        if (opts.watch) return void (await watchRun(client, project.id, runId));
        return void printRun((await client.orchestraRun(project.id, runId)).run);
      }
      const { runs } = await client.orchestraRuns(project.id);
      if (!runs.length) return void console.log(pc.dim('no orchestra runs yet — loom orchestrate "<goal>"'));
      for (const r of runs.slice(0, 15)) {
        const done = r.tasks.filter((t) => t.status === "done").length;
        console.log(
          `${pc.bold(r.id)}  ${r.status.padEnd(13)} ${String(done).padStart(2)}/${String(r.tasks.length).padEnd(2)} ` +
            `${pc.dim(new Date(r.createdAt).toLocaleString())}  ${r.goal.slice(0, 70)}`,
        );
      }
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

for (const action of ["abort", "apply", "cleanup"] as const) {
  const blurb = {
    abort: "stop a run — every worker is interrupted",
    apply: "merge a run's integration branch into your current branch",
    cleanup: "remove a finished run's worktrees (its branch stays)",
  }[action];
  program
    .command(`orchestra:${action} <runId>`)
    .description(blurb)
    .action(async (runId: string) => {
      const client = await ensureDaemon();
      const project = await currentProject(client);
      try {
        const out = await client.orchestraAction(project.id, runId, action);
        if (action === "apply") console.log(`${pc.green("✓")} merged ${pc.bold(String(out.merged))} into ${pc.bold(String(out.into))}`);
        else console.log(`${pc.green("✓")} ${action} ${runId}`);
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });
}

program
  .command("orchestra:reply <runId> <text>")
  .description("answer the orchestrator's question, or steer a running orchestra")
  .action(async (runId: string, text: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      await client.orchestraAction(project.id, runId, "reply", { text });
      console.log(`${pc.green("✓")} sent to the orchestrator`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

// ── Loom Teams (docs/teams-architecture.md, daemon/team.ts) ──

program
  .command("hub")
  .description("run a self-hosted Team Hub for your team (no Supabase needed)")
  .option("--port <n>", "port", "7430")
  .option("--host <ip>", "interface to bind (use your LAN/tailnet IP so teammates can reach it)", "127.0.0.1")
  .option("--secret <s>", "join secret every member must present (or LOOM_HUB_SECRET)")
  .action(async (opts: { port: string; host: string; secret?: string }) => {
    const secret = opts.secret || process.env.LOOM_HUB_SECRET;
    const loopback = opts.host === "127.0.0.1" || opts.host === "localhost";
    if (!loopback && !secret) {
      console.error(pc.red("a hub reachable by others needs a join secret: --secret <s> (or LOOM_HUB_SECRET)"));
      process.exitCode = 1;
      return;
    }
    const { startHubServer } = await import("../hub/server.js");
    const hub = await startHubServer({ port: Number(opts.port), host: opts.host, ...(secret ? { secret } : {}) });
    console.log(`${pc.green("●")} Loom Team Hub on ${pc.bold(hub.url)}`);
    console.log(pc.dim(`  members sign in with: loom team signin ${hub.url}${secret ? " --secret <secret>" : ""}`));
    console.log(pc.dim("  state is in memory: members' daemons re-join on their own after a restart"));
    const stop = async () => {
      await hub.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

function printTeam(t: Record<string, unknown>): void {
  if (!t.signedIn) {
    console.log(pc.dim("not on a team hub — `loom team signin <hub-url>`, or join with an invite link"));
    return;
  }
  console.log(`${pc.bold(String(t.github))} on ${pc.dim(String(t.hub))}`);
  const teams = (t.teams as Array<Record<string, unknown>>) ?? [];
  if (!teams.length) console.log(pc.dim("  no teams yet — `loom team create <name>` or `loom team join <link>`"));
  for (const tm of teams) {
    const members = (tm.members as Array<{ github: string; role: string }>) ?? [];
    console.log(`\n${pc.magenta("◆")} ${pc.bold(String(tm.name))} ${pc.dim(`(${String(tm.role)} · key v${String(tm.keyVersion)})`)}`);
    console.log(`  members  ${members.map((m) => (m.role === "owner" ? `${m.github}★` : m.github)).join(", ")}`);
    console.log(`  repos    ${((tm.repos as string[]) ?? []).join(", ") || pc.dim("none shared yet — `loom team share` in a project")}`);
    const presence = (tm.presence as Array<Record<string, unknown>>) ?? [];
    if (presence.length) console.log("  live");
    for (const p of presence) {
      const intent = (p.intent ?? {}) as Record<string, string>;
      const what = intent.task ? `${intent.task} ${pc.dim(`(${intent.goal ?? ""})`)}` : intent.goal ?? intent.thread ?? "";
      const touches = (p.touches as string[]) ?? [];
      console.log(
        `    ${pc.cyan(String(p.github).padEnd(12))} ${String(p.agent).padEnd(22)} ${String(p.state).padEnd(10)} ${what}` +
          (touches.length ? pc.dim(`  ${touches.slice(0, 3).join(" ")}`) : ""),
      );
    }
    const leases = ((tm.leases as Array<Record<string, unknown>>) ?? []).filter((l) => !l.stale);
    if (leases.length) console.log("  leases");
    for (const l of leases) {
      const intent = (l.intent ?? {}) as Record<string, string>;
      const globs = ((l.globs as string[]) ?? []).slice(0, 3).join(" ");
      console.log(
        `    ${pc.cyan(String(l.github).padEnd(12))} ${String(l.runId)}/${String(l.taskId)} ${pc.dim(String(l.state).padEnd(8))} ${globs}` +
          (intent.task ? pc.dim(`  ${intent.task}`) : ""),
      );
    }
    const feed = ((tm.feed as Array<Record<string, unknown>>) ?? []).slice(-8);
    if (feed.length) console.log("  recent");
    for (const e of feed) {
      const c = (e.content ?? {}) as Record<string, string>;
      const meta = (e.meta ?? {}) as Record<string, unknown>;
      const label = c.goal ?? c.title ?? (meta.number ? `#${String(meta.number)}` : "");
      const detail = label || String(meta.repo ?? (meta.version ? `v${String(meta.version)}` : ""));
      // membership events are posted by the hub itself; the person is in meta
      const who = String(e.github ?? meta.github ?? (String(e.type).startsWith("pr_") || String(e.type).startsWith("check_") ? "github" : "team"));
      console.log(`    ${pc.dim(new Date(Number(e.ts)).toLocaleTimeString())} ${who.padEnd(10)} ${String(e.type).padEnd(14)} ${detail}`);
    }
  }
}

program
  .command("team [action] [args...]")
  .description("Loom Teams: status | signin [hub] | create <name> | invite | join <link> | share | unshare | brain [inbox|promote|resolve|correct|trust|private] | landing | doctor [fix] | adopt <pr> | deploys | release-notes <since> | webhook [--repo r] [--install] | remove <github> | leave")
  .option("--github <login>", "your GitHub login (defaults to the gh CLI's)")
  .option("--repo <owner/name>", "webhook: which repo (defaults to this project's)")
  .option("--install", "webhook: create it on the repo with gh (needs repo admin)")
  .option("--rotate", "webhook: replace the secret (update the repo's webhook after)")
  .option("--secret <s>", "the hub's join secret")
  .option("--team <id>", "which team, when you're in several")
  .option("--paste", "hosted sign-in without a local browser: open the link anywhere, paste back where you land")
  .action(async (action: string | undefined, args: string[] | undefined, opts: { github?: string; secret?: string; team?: string; paste?: boolean; repo?: string; install?: boolean; rotate?: boolean }) => {
    const client = await ensureDaemon();
    const a = (action ?? "status").toLowerCase();
    const arg = args?.[0];
    const extra = { ...(opts.github ? { github: opts.github } : {}), ...(opts.secret ? { secret: opts.secret } : {}), ...(opts.team ? { teamId: opts.team } : {}) };
    try {
      if (a === "status") return void printTeam(await client.team());
      if (a === "signin") {
        const { hostedHubUrl, hostedSupabaseUrl, publishableKeyFor } = await import("../core/hosted.js");
        const supabaseUrl = hostedSupabaseUrl(arg);
        if (supabaseUrl !== null) {
          // The hosted hub: GitHub sign-in in the browser, run here (it can take
          // minutes); the daemon only receives the resulting session.
          const session = await hostedSession(supabaseUrl, publishableKeyFor(supabaseUrl), Boolean(opts.paste));
          const out = await client.teamAction("signin", { hub: hostedHubUrl(supabaseUrl), token: session.refreshToken, ...extra });
          return void printTeam(out.team);
        }
        const out = await client.teamAction("signin", { hub: arg, ...extra });
        return void printTeam(out.team);
      }
      if (a === "create") {
        if (!arg) throw new Error("name it: loom team create <name>");
        const out = await client.teamAction("create", { name: arg });
        console.log(`${pc.green("✓")} created ${pc.bold(String((out.result as { name: string }).name))} — you're its owner`);
        console.log(pc.dim("  invite teammates: loom team invite · share this project: loom team share"));
        return;
      }
      if (a === "invite") {
        const out = await client.teamAction("invite", extra);
        const { link, expiresAt } = out.result as { link: string; expiresAt: number };
        console.log(`${pc.bold("invite link")} ${pc.dim(`(single use, until ${new Date(expiresAt).toLocaleString()})`)}\n\n  ${link}\n`);
        console.log(pc.yellow("  it carries the team key — send it like a password"));
        qrcode.generate(link, { small: true });
        return;
      }
      if (a === "join") {
        if (!arg) throw new Error("paste the invite: loom team join '<link>'");
        const out = await client.teamAction("join", { link: arg, ...extra });
        console.log(`${pc.green("✓")} joined ${pc.bold(String((out.result as { name: string }).name))}`);
        return void printTeam(out.team);
      }
      if (a === "share" || a === "unshare") {
        const project = await currentProject(client);
        if (a === "share") {
          const out = await client.shareProject(project.id, opts.team);
          console.log(`${pc.green("✓")} ${pc.bold(out.repo)} is shared — teammates see this project's agents and goals`);
        } else {
          await client.unshareProject(project.id);
          console.log(`${pc.green("✓")} ${project.name} is private — nothing from it reaches the team`);
        }
        return;
      }
      if (a === "remove") {
        if (!arg) throw new Error("who? loom team remove <github-login>");
        const st = await client.team();
        const teams = (st.teams as Array<{ id: string; members: Array<{ id: string; github: string }> }>) ?? [];
        const team = opts.team ? teams.find((t) => t.id === opts.team) : teams[0];
        const m = team?.members.find((x) => x.github === arg.toLowerCase());
        if (!team || !m) throw new Error(`no member "${arg}"`);
        const out = await client.teamAction("remove", { userId: m.id, teamId: team.id });
        console.log(`${pc.green("✓")} removed ${arg}; team key rotated to v${String((out.result as { keyVersion: number }).keyVersion)}`);
        return;
      }
      if (a === "brain") {
        // loom team brain [inbox|sync|promote <id,id>|resolve <winner> --loser <id>|trust <id>|private <id>]
        const project = await currentProject(client);
        const sub = (arg ?? "").toLowerCase();
        const rest = (args ?? []).slice(1);
        let view;
        if (!sub || sub === "inbox" || sub === "status") view = await client.teamBrain(project.id, { sync: true });
        else if (sub === "sync") view = await client.teamBrainAction(project.id, "sync");
        else if (sub === "promote") {
          if (!rest[0]) throw new Error("which memories? loom team brain promote <id>[,<id>…]");
          const out = await client.teamBrainAction(project.id, "promote", { ids: rest[0].split(",") });
          const r = out.result as { prUrl: string | null; added: number; note?: string; branch: string };
          console.log(`${pc.green("✓")} ${r.added ? `proposed ${r.added} as canon on ${r.branch}` : "already canon"}${r.prUrl ? ` — ${r.prUrl}` : ""}`);
          if (r.note) console.log(pc.yellow(`  ${r.note}`));
          return;
        } else if (sub === "resolve" || sub === "merge") {
          if (!rest[0] || !rest[1]) throw new Error(`loom team brain ${sub} <keep-id> <drop-id> [reason]`);
          view = await client.teamBrainAction(project.id, "resolve", { winner: rest[0], loser: rest[1], reason: rest.slice(2).join(" ") || sub });
        } else if (sub === "correct") {
          if (!rest[0] || !rest[1]) throw new Error("loom team brain correct <id> <the corrected sentence>");
          view = await client.teamBrainAction(project.id, "correct", { id: rest[0], text: rest.slice(1).join(" ") });
        } else if (sub === "trust" || sub === "private") {
          if (!rest[0]) throw new Error(`loom team brain ${sub} <id>`);
          view = await client.teamBrainAction(project.id, sub, { id: rest[0] });
        } else throw new Error(`unknown brain action "${sub}" — inbox, sync, promote, resolve, merge, correct, trust, private`);
        const st = view.status;
        if (!st.shared) return void console.log(pc.dim("this project isn't shared with a team — `loom team share`"));
        console.log(`${pc.bold("team brain")}  ${String(st.repo)}  ${pc.dim(`${String(st.canon)} canon · ${String(st.team)} team · ${String(st.confirmed)} confirmed · ${String(st.mine)} yours`)}`);
        if (st.lastError) console.log(pc.red(`  ${String(st.lastError)}`));
        const tag: Record<string, string> = { canon: pc.green("canon"), confirmed: pc.cyan("confirmed"), own: pc.dim("yours"), proposed: pc.yellow("proposed") };
        for (const m of view.memories.slice(0, 40)) {
          console.log(`  ${(tag[m.tier] ?? m.tier).padEnd(20)} ${m.text}${m.author && !m.mine ? pc.dim(`  — ${m.author}`) : ""}  ${pc.dim(m.id)}`);
        }
        if (view.inbox.length) {
          console.log(`\n${pc.bold("inbox")} ${pc.dim(`(${view.inbox.length})`)}`);
          for (const i of view.inbox) {
            console.log(`  ${pc.magenta(i.type.padEnd(13))} ${i.detail}`);
            console.log(`    ${pc.dim(i.a.id)} ${i.a.text}`);
            if (i.b) console.log(`    ${pc.dim(i.b.id)} ${i.b.text}`);
          }
        }
        return;
      }
      if (a === "release-notes" || a === "deploys") {
        const project = await currentProject(client);
        if (a === "release-notes") {
          if (!arg) throw new Error("since which tag? loom team release-notes v1.2.0");
          process.stdout.write((await client.releaseNotes(project.id, arg)).markdown);
          return;
        }
        const { deployments } = await client.deploys(project.id);
        if (!deployments.length) return void console.log(pc.dim("no deployments on this repo"));
        for (const d of deployments) {
          const st = String(d.state);
          const col = st === "success" ? pc.green : st === "failure" || st === "error" ? pc.red : pc.yellow;
          console.log(`  ${col(st.padEnd(12))} ${String(d.environment).padEnd(14)} ${String(d.sha).slice(0, 8)}  ${pc.dim(String(d.url ?? ""))}`);
        }
        return;
      }
      if (a === "landing" || a === "doctor" || a === "adopt") {
        const project = await currentProject(client);
        if (a === "doctor") {
          if ((args ?? []).includes("--fix") || arg === "fix") {
            const out = await client.teamDoctorFix(project.id);
            console.log(out.prUrl ? `${pc.green("✓")} opened ${out.prUrl} (${out.files.join(", ")})` : pc.dim("nothing to fix in the workflows"));
            return;
          }
          const d = await client.teamDoctor(project.id);
          console.log(`${pc.bold("landing doctor")}  ${d.repo ?? pc.dim("(no GitHub repo)")} · ${d.branch}`);
          const icon: Record<string, string> = { ok: pc.green("✓"), warn: pc.yellow("!"), error: pc.red("✗") };
          for (const f of d.findings) {
            console.log(`  ${icon[f.level] ?? "·"} ${f.what}`);
            if (f.fix) console.log(pc.dim(`      ${f.fix}`));
          }
          if (d.fixable.length) console.log(pc.dim(`\n  loom team doctor fix — opens a PR adding merge_group to ${d.fixable.join(", ")}`));
          return;
        }
        if (a === "adopt") {
          const pr = Number(String(arg ?? "").replace(/^#/, ""));
          if (!pr) throw new Error("which PR? loom team adopt <number>");
          const out = await client.landingAction(project.id, "adopt", { pr });
          console.log(`${pc.green("✓")} adopted PR #${pr} — goal ${String((out.result as { id: string }).id)} is making it green; it's handed back when it is`);
          return;
        }
        const v = await client.landing(project.id, { poll: true });
        if (!v.goals.length && !v.adoptable.length) return void console.log(pc.dim("no goal PRs in flight"));
        for (const g of v.goals) {
          const l = g.landing as { pr: number; state: string; fixAttempts: number; reason?: string; review?: { state: string; high: number } ; checks?: { failing: string[]; pending: string[] } };
          const col = l.state === "green" || l.state === "merged" ? pc.green : l.state === "needs_human" || l.state === "failing" ? pc.red : pc.yellow;
          console.log(`  ${col(l.state.padEnd(12))} #${l.pr}  ${String(g.goal)}  ${pc.dim(`${String(g.runId)} · fixes ${l.fixAttempts} · $${Number(g.costUsd ?? 0).toFixed(2)}`)}`);
          if (l.checks?.failing.length) console.log(pc.red(`      failing: ${l.checks.failing.join(", ")}`));
          if (l.review) console.log(pc.dim(`      review: ${l.review.state}${l.review.high ? ` (${l.review.high} high)` : ""}`));
          if (l.reason) console.log(pc.yellow(`      ${l.reason}`));
        }
        if (v.adoptable.length) {
          console.log(`\n${pc.bold("needs someone")}`);
          for (const p of v.adoptable) console.log(`  #${String(p.pr)} ${String(p.owner)} — ${String(p.reason)}  ${pc.dim(`loom team adopt ${String(p.pr)}`)}`);
        }
        return;
      }
      if (a === "webhook") {
        // Phase 6 (D83): GitHub events pushed to the hub instead of polled
        const project = await currentProject(client).catch(() => null);
        const out = await client.teamAction("webhook", {
          ...extra,
          ...(opts.repo ? { repo: opts.repo } : {}),
          ...(project ? { projectId: project.id } : {}),
          ...(opts.install ? { install: "1" } : {}),
          ...(opts.rotate ? { rotate: "1" } : {}),
        });
        const w = out.result as { url: string; secret: string; repo: string | null; events: string[]; installed?: { id: number | null; repo: string }; warning?: string };
        console.log(`${pc.bold("payload URL")}   ${w.url}`);
        console.log(`${pc.bold("secret")}        ${w.secret}  ${pc.yellow("(treat it like a password)")}`);
        console.log(`${pc.bold("content type")}  application/json`);
        console.log(`${pc.bold("events")}        ${w.events.join(", ")}`);
        if (w.warning) console.log(pc.yellow(`  ${w.warning}`));
        if (w.installed) console.log(`${pc.green("✓")} webhook created on ${w.installed.repo}${w.installed.id ? pc.dim(` (id ${w.installed.id})`) : ""}`);
        else console.log(pc.dim(`\n  install it: loom team webhook --install${w.repo ? ` --repo ${w.repo}` : " --repo owner/name"}  (or GitHub → Settings → Webhooks)`));
        return;
      }
      if (a === "leave") {
        await client.teamAction("leave", extra);
        console.log(`${pc.green("✓")} left the team`);
        return;
      }
      throw new Error(`unknown action "${a}"`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("runner [action] [args...]")
  .description("Loom runners: status | pair | join <link> | start | stop | token <PAT> | doctor | install | revoke <device> | goal \"<goal>\" | move <runId> | back <runId> | jobs | exec")
  .option("--github <login>", "your GitHub login (self-hosted hub)")
  .option("--secret <s>", "the self-hosted hub's join secret")
  .option("--token <refresh>", "hosted hub: a session refresh token (from the paste-the-URL sign-in)")
  .option("--shared", "take teammates' goals too (when their repo's policy allows)")
  .option("--runner <id>", "which runner (device id or label)")
  .option("--job <id>", "exec: the claimed job to run")
  .option("--team <id>", "exec: the job's team")
  .option("--browser", "join: sign in with a local browser instead of pasting the address back")
  .action(async (action: string | undefined, args: string[] | undefined, opts: { github?: string; secret?: string; token?: string; shared?: boolean; runner?: string; job?: string; team?: string; browser?: boolean }) => {
    const a = (action ?? "status").toLowerCase();
    const arg = args?.[0];
    try {
      if (a === "install") {
        const loomBin = fileURLToPath(new URL("./index.js", import.meta.url));
        const f = serviceFile({ platform: process.platform, home: process.env.HOME ?? "", node: process.execPath, loom: loomBin, ...(process.env.LOOM_HOME ? { loomHome: process.env.LOOM_HOME } : {}) });
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, f.content);
        console.log(`${pc.green("✓")} wrote ${f.path}`);
        for (const cmd of f.enable) {
          await new Promise<void>((resolve) => spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit" }).on("exit", () => resolve()));
        }
        console.log(pc.dim("  the daemon now starts at login and restarts if it stops; `loom runner status` to check"));
        return;
      }
      if (a === "token") {
        if (!arg) throw new Error("paste a fine-grained PAT: loom runner token github_pat_…");
        writeRunnerToken(arg);
        console.log(`${pc.green("✓")} saved (0600, ${path.join(loomHome(), "runner-token")}) — it never goes through the hub. Check it: loom runner doctor`);
        return;
      }
      if (a === "exec") {
        // Inside a runner's container: run one claimed job, then exit (D70).
        if (!opts.job || !opts.team) throw new Error("runner exec needs --job and --team");
        const daemon = new LoomDaemon({ host: "127.0.0.1", port: 0, runnerExec: { teamId: opts.team, jobId: opts.job, done: (ok) => process.exit(ok ? 0 : 1) } });
        await daemon.listen();
        return;
      }
      const client = await ensureDaemon();
      if (a === "status") {
        const s = await client.runner();
        const c = s.config as { enabled?: boolean; shared?: boolean; capacity?: number; isolation?: string };
        console.log(`runner  ${s.running ? pc.green("running") : c?.enabled ? pc.yellow("enabled, not running") : pc.dim("off")}${c ? pc.dim(`  · ${c.shared ? "shared" : "personal"} · ${c.capacity ?? 1} at a time · isolation ${c.isolation ?? "auto"}`) : ""}`);
        for (const j of (s.active as Array<Record<string, unknown>> | undefined) ?? []) console.log(`  ${String(j.kind).padEnd(9)} ${String(j.repo)}  ${pc.dim(`${String(j.owner)} · job ${String(j.jobId)}${j.runId ? ` · goal ${String(j.runId)}` : ""}`)}`);
        if (!s.token) console.log(pc.dim("  no runner token — `loom runner token <PAT>` (see `loom runner doctor`)"));
        if (s.lastError) console.log(pc.red(`  ${String(s.lastError)}`));
        return;
      }
      if (a === "pair") {
        const out = await client.runnerAction("pair");
        const { link } = out.result as { link: string };
        console.log(`${pc.bold("runner pairing link")} — on the box: ${pc.cyan("loom runner join '<link>'")}\n\n  ${link}\n`);
        console.log(pc.yellow("  it carries your team keys — send it like a password, to a machine you control"));
        return;
      }
      if (a === "join") {
        if (!arg) throw new Error("paste the link from `loom runner pair`");
        let token = opts.token;
        if (!token && !opts.secret) {
          // A hosted hub: sign in as yourself here (a runner box usually has no browser — D74).
          const hubUrl = (() => {
            try {
              return String((JSON.parse(Buffer.from(arg.replace(/^loom-runner:/, ""), "base64url").toString("utf8")) as { hub?: string }).hub ?? "");
            } catch {
              return "";
            }
          })();
          const { hostedSupabaseUrl, publishableKeyFor } = await import("../core/hosted.js");
          const sbUrl = hostedSupabaseUrl(hubUrl);
          if (sbUrl !== null) token = (await hostedSession(sbUrl, publishableKeyFor(sbUrl), !opts.browser)).refreshToken;
        }
        const out = await client.runnerAction("join", { link: arg, ...(opts.github ? { github: opts.github } : {}), ...(opts.secret ? { secret: opts.secret } : {}), ...(token ? { token } : {}), ...(opts.shared ? { shared: true } : {}) });
        console.log(`${pc.green("✓")} this machine is now a runner`, pc.dim(JSON.stringify((out.result as { registered?: unknown }).registered ?? {})));
        console.log(pc.dim("  keep it running: loom runner install · check it: loom runner doctor"));
        return;
      }
      if (a === "start" || a === "stop") {
        await client.runnerAction(a, a === "start" && opts.shared ? { shared: true } : {});
        console.log(`${pc.green("✓")} runner ${a === "start" ? "started" : "stopped"}`);
        return;
      }
      if (a === "revoke") {
        if (!arg) throw new Error("which runner device? see `loom runner jobs`");
        await client.runnerAction("revoke", { deviceId: arg });
        console.log(`${pc.green("✓")} revoked ${arg}; team keys rotated`);
        return;
      }
      if (a === "doctor") {
        const token = readRunnerToken();
        const repos: Record<string, Record<string, boolean> | null> = {};
        let scopes: string[] = [];
        if (token) {
          const env = { ...process.env, GH_TOKEN: token };
          const run = (argv: string[]) => new Promise<string>((resolve) => {
            const p = spawn("gh", argv, { env });
            let out = "";
            p.stdout.on("data", (d) => (out += String(d)));
            p.on("exit", () => resolve(out));
            p.on("error", () => resolve(""));
          });
          const head = await run(["api", "-i", "user"]);
          scopes = (/^x-oauth-scopes:\s*(.*)$/im.exec(head)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          const team = await client.team();
          for (const t of (team.teams as Array<{ repos: string[] }>) ?? []) {
            for (const r of t.repos) {
              try {
                repos[r] = (JSON.parse(await run(["api", `repos/${r}`])) as { permissions?: Record<string, boolean> }).permissions ?? null;
              } catch {
                repos[r] = null;
              }
            }
          }
        }
        const s = await client.runner();
        const items = [
          ...(s.running ? [{ level: "ok", what: "runner is running" }] : [{ level: "warn", what: "runner isn't running", fix: "loom runner start" }]),
          ...tokenFindings({ present: Boolean(token), scopes, repos }),
        ];
        const icon: Record<string, string> = { ok: pc.green("✓"), warn: pc.yellow("!"), error: pc.red("✗") };
        for (const f of items) {
          console.log(`  ${icon[f.level]} ${f.what}`);
          if ("fix" in f && f.fix) console.log(pc.dim(`      ${f.fix}`));
        }
        return;
      }
      const project = await currentProject(client);
      if (a === "goal") {
        const goal = (args ?? []).join(" ").trim();
        if (!goal) throw new Error('what\'s the goal? loom runner goal "Add rate limiting"');
        const out = await client.runnersAction(project.id, "start", { goal, ...(opts.runner ? { runner: opts.runner } : {}) });
        console.log(`${pc.green("✓")} queued for your runner — job ${String((out.result as { jobId: string }).jobId)}; watch it: loom runner jobs`);
        return;
      }
      if (a === "move" || a === "back") {
        if (!arg) throw new Error(`which goal? loom runner ${a} <runId>`);
        const out = await client.runnersAction(project.id, a === "move" ? "continue" : "bring-back", { runId: arg, ...(opts.runner ? { runner: opts.runner } : {}) });
        console.log(`${pc.green("✓")} ${a === "move" ? "moving the goal to your runner" : "asked the runner to hand it back"} — job ${String((out.result as { jobId: string }).jobId)}`);
        return;
      }
      if (a === "jobs") {
        const v = await client.runners(project.id);
        for (const r of v.runners) console.log(`  ${r.online ? pc.green("●") : pc.dim("○")} ${String(r.label)}  ${pc.dim(`${String(r.github)} · ${(r.kinds as string[]).join(", ")}${r.shared ? " · shared" : ""} · ${String(r.deviceId)}`)}`);
        if (!v.runners.length) console.log(pc.dim("  no runners — `loom runner pair`, then `loom runner join <link>` on an always-on box"));
        for (const j of v.jobs.slice(-15)) {
          const p = j.progress as { status?: string; tasks?: unknown[]; costUsd?: number } | null;
          console.log(`  ${String(j.state).padEnd(9)} ${String(j.kind).padEnd(8)} ${String(j.goal || j.runId || "")}  ${pc.dim(`${p?.status ?? ""}${p?.tasks ? ` · ${p.tasks.length} tasks` : ""}${p?.costUsd ? ` · $${p.costUsd}` : ""}${j.error ? ` · ${String(j.error)}` : ""}`)}`);
        }
        return;
      }
      throw new Error(`unknown runner action "${a}"`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("land [runId]")
  .description("land a goal's PR: fresh main in, fast tests, push, merge when GitHub's rules pass (Loom Teams D56)")
  .action(async (runId: string | undefined) => {
    const client = await ensureDaemon();
    try {
      const project = await currentProject(client);
      let id = runId;
      if (!id) {
        const v = await client.landing(project.id);
        const ready = v.goals.filter((g) => !["merged", "closed"].includes(String((g.landing as { state: string }).state)));
        if (ready.length !== 1) throw new Error(ready.length ? `several goals have PRs — say which: ${ready.map((g) => String(g.runId)).join(", ")}` : "no goal PR to land");
        id = String(ready[0]!.runId);
      }
      const out = await client.landingAction(project.id, "land", { runId: id });
      const l = out.result as { pr: number; state: string; reason?: string };
      console.log(l.state === "landing" ? `${pc.green("✓")} PR #${l.pr} will merge when its checks and approvals pass` : `PR #${l.pr}: ${l.state}${l.reason ? ` — ${l.reason}` : ""}`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

// ── Loom Cloud: reach this daemon from any network (daemon/relay.ts) ──

program
  .command("cloud [action]")
  .description("Loom Cloud relay: status | enable | disable | rotate — reach your agents from anywhere, end-to-end encrypted")
  .option("--url <supabaseUrl>", "Supabase project URL (or LOOM_SUPABASE_URL)")
  .option("--key <anonKey>", "Supabase anon key (or LOOM_SUPABASE_ANON_KEY)")
  .action(async (action: string | undefined, opts: { url?: string; key?: string }) => {
    const client = await ensureDaemon();
    try {
      const a = (action ?? "status").toLowerCase();
      let s: Record<string, unknown>;
      if (a === "status") s = await client.cloud();
      else if (a === "enable" || a === "disable" || a === "rotate") {
        s = await client.cloudAction(a, {
          ...(opts.url ? { supabaseUrl: opts.url } : {}),
          ...(opts.key ? { anonKey: opts.key } : {}),
        });
      } else throw new Error(`unknown action "${a}" — status, enable, disable or rotate`);
      const on = s.connected ? pc.green("connected") : s.enabled ? pc.yellow("enabled, not connected") : pc.dim("off");
      console.log(`Loom Cloud  ${on}${s.supabaseUrl ? pc.dim(`  via ${String(s.supabaseUrl)}`) : ""}`);
      if (s.connected) console.log(pc.dim(`  ${String(s.clients)} phone(s) on the relay · end-to-end encrypted — Supabase relays ciphertext only`));
      if (s.error) console.log(pc.red(`  ${String(s.error)}`));
      if (!s.configured) console.log(pc.dim("  set a Supabase project: loom cloud enable --url https://<ref>.supabase.co --key <anon key>"));
      if (a === "enable" && s.connected) console.log(pc.dim("  pair a phone with `loom pair` — its QR now works from any network"));
      if (a === "rotate") console.log(pc.dim("  new key minted — phones paired through the cloud must pair again"));
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("subtasks")
  .description("subtasks running right now")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { subtasks } = await client.subtasks(project.id);
    if (!subtasks.length) return void console.log(pc.dim("nothing running"));
    for (const s of subtasks) {
      console.log(`${pc.cyan(s.agentId)} ${pc.dim("for " + s.parent)}  ${s.task.slice(0, 60)}`);
    }
  });

program
  .command("agents:add <kind>")
  .description("add an agent session to this project (repeat for a second session of the same kind)")
  .option("--as <name>", "name this instance (default: the kind, then kind-2, kind-3…)")
  .option("--role <role>", "what this instance is for, e.g. planner or reviewer")
  .action(async (kind: string, opts: { as?: string; role?: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      const added = await client.addAgent(project.id, kind, opts);
      const siblings = project.agents.filter((a) => a.kind === kind).length;
      console.log(
        `${pc.green("+")} ${pc.bold(added.id)} ${pc.dim(`(${added.kind} · ${added.role})`)}` +
          (siblings ? pc.dim(`  — session ${siblings + 1} of ${kind}, sharing this project's brain`) : ""),
      );
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("agents:rm <agentId>")
  .description("remove an agent session from this project")
  .action(async (agentId: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    try {
      await client.removeAgent(project.id, agentId);
      console.log(`${pc.red("-")} ${agentId} removed`);
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("agents:available")
  .description("which agents this machine can drive, and how many sessions are here")
  .option("--json", "print as JSON")
  .action(async (opts: { json: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { ades } = await client.availableAgents(project.id);
    if (opts.json) return void console.log(JSON.stringify(ades, null, 2));
    for (const a of ades) {
      const state =
        a.installed === false
          ? pc.dim("not installed")
          : a.instances
            ? pc.green(`${a.instances} session${a.instances === 1 ? "" : "s"} here`)
            : pc.dim("available");
      console.log(`${a.kind.padEnd(18)} ${a.label.padEnd(20)} ${state}`);
    }
  });

program
  .command("models [agentId]")
  .description("with an agent: the models it reports. Without: what every configured provider has")
  .option("--provider <id>", "just this provider")
  .option("--refresh", "ask again instead of trusting the cache")
  .option("--free", "only the ones that cost nothing")
  .action(async (agentId: string | undefined, opts: { provider?: string; refresh?: boolean; free?: boolean }) => {
    // An agent named means "what can THIS agent run" — a CLI reports its own.
    if (agentId) {
      const client = await ensureDaemon();
      const project = await currentProject(client);
      const { kind, models } = await client.models(project.id, agentId);
      if (!models.length) {
        console.log(pc.dim(`${agentId} (${kind}) reports no selectable models`));
        return;
      }
      console.log(pc.bold(`${agentId} (${kind}) · ${models.length} model${models.length === 1 ? "" : "s"}`));
      for (const model of models) console.log(model);
      return;
    }
    // No agent: the provider catalogue, which needs no daemon and no project.
    const refresh = Boolean(opts.refresh);
    let models;
    let errors: Array<{ provider: string; error: string }> = [];
    if (opts.provider) {
      const p = resolveProvider(opts.provider);
      if (!p) fail(`no provider "${opts.provider}" — loom providers`);
      const got = await fetchModels(p!, refresh ? { refresh: true } : {});
      models = got.models;
      if (got.error) errors = [{ provider: p!.id, error: got.error }];
    } else {
      const got = await allModels(refresh ? { refresh: true } : {});
      models = got.models;
      errors = got.errors;
    }
    const shown = opts.free ? models.filter((m) => m.free) : models;
    if (!shown.length) console.log(pc.dim("no models — configure a provider with loom providers:set"));
    for (const m of shown) {
      console.log(
        `${pc.bold(m.id)} ${pc.dim(m.provider)}${m.free ? " " + pc.green("free") : ""}` +
          (m.endpoints ? pc.dim(`  [${m.endpoints.join(", ")}]`) : ""),
      );
    }
    for (const e of errors) console.log(pc.yellow(`⚠ ${e.provider}: ${e.error}`));
  });

// ---------------------------------------------------------------------------
// send / chat / handoff / interrupt / decision / log
// ---------------------------------------------------------------------------

async function sendWithHandoffConfirm(
  client: DaemonClient,
  projectId: string,
  text: string,
  agentId?: string,
  interactive = true,
): Promise<{ agentId: string } | null> {
  try {
    return await client.send(projectId, text, agentId);
  } catch (err) {
    if (err instanceof DaemonError && err.status === 409 && agentId) {
      const holder = String(err.body?.holder ?? "another agent");
      if (!interactive) fail(`${agentId} doesn't hold the baton (holder: ${holder}) — loom handoff ${agentId}`);
      const yes = await confirm(
        pc.yellow(`⟶ ${holder} holds the baton. Hand off to ${agentId} (interrupts current work)?`),
      );
      if (!yes) return null;
      await client.handoff(projectId, agentId);
      return await client.send(projectId, text, agentId);
    }
    throw err;
  }
}

program
  .command("send <text...>")
  .description("send one message into the shared thread")
  .option("-a, --agent <id>", "address a specific agent (may require a handoff)")
  .action(async (words: string[], opts: { agent?: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const result = await sendWithHandoffConfirm(client, project.id, words.join(" "), opts.agent);
    if (result) console.log(pc.dim(`→ sent to ${result.agentId} (loom log --follow to watch)`));
  });

program
  .command("chat")
  .description("interactive shared thread (all agents, one conversation)")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    console.log(pc.bold(`\n${project.name}`) + pc.dim(` — shared thread. /help for commands.`));
    for (const a of project.agents) console.log(formatAgentRow(a));
    console.log();

    // Replay a little recent history, then go live.
    const { events } = await client.events(project.id, undefined, 15);
    for (const e of events) printEvent(e);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: pc.bold("you> "),
    });
    const lastSeen = { id: events[events.length - 1]?.id ?? 0 };
    const unsubscribe = client.subscribe((pid, e) => {
      if (pid !== project.id || e.id <= lastSeen.id) return;
      lastSeen.id = e.id;
      // Don't re-echo what the user just typed.
      if (e.kind === "message" && !e.agentId) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      printEvent(e);
      rl.prompt(true);
    }, project.id);

    const close = () => {
      unsubscribe();
      rl.close();
      process.exit(0);
    };

    rl.on("line", (line) => {
      void (async () => {
        const text = line.trim();
        if (!text) return rl.prompt();
        try {
          if (text === "/quit" || text === "/exit") return close();
          if (text === "/help") {
            console.log(
              pc.dim(
                "/agents — list agents · /handoff <id> — pass the baton · /interrupt — stop current turn\n" +
                  "/decision <text> — record a shared decision · @<agent> <msg> — address an agent · /quit",
              ),
            );
          } else if (text === "/agents") {
            const { project: fresh } = await client.project(project.id);
            for (const a of fresh.agents) console.log(formatAgentRow(a));
          } else if (text.startsWith("/handoff ")) {
            const to = text.slice(9).trim();
            const yes = await confirm(pc.yellow(`Hand the baton to ${to}?`));
            if (yes) await client.handoff(project.id, to);
          } else if (text === "/interrupt") {
            const { interrupted } = await client.interrupt(project.id);
            console.log(pc.dim(interrupted ? `interrupted ${interrupted}` : "nothing running"));
          } else if (text.startsWith("/decision ")) {
            await client.decision(project.id, text.slice(10).trim());
          } else if (text.startsWith("@")) {
            const m = text.match(/^@(\S+)\s+([\s\S]+)$/);
            if (!m) console.log(pc.dim("usage: @<agent> <message>"));
            else await sendWithHandoffConfirm(client, project.id, m[2]!, m[1]!);
          } else {
            await sendWithHandoffConfirm(client, project.id, text);
          }
        } catch (err) {
          console.error(pc.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        }
        rl.prompt();
      })();
    });
    rl.on("close", close);
    rl.prompt();
  });

program
  .command("handoff <agent>")
  .description("pass the baton (write lock) to another agent")
  .option("-y, --yes", "skip confirmation", false)
  .action(async (agent: string, opts: { yes: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    if (!opts.yes) {
      const holder = project.holder ?? "nobody";
      const ok = await confirm(
        pc.yellow(`Baton: ${holder} → ${agent}. Interrupts in-flight work and projects shared memory. Continue?`),
      );
      if (!ok) return;
    }
    const { from } = await client.handoff(project.id, agent);
    console.log(pc.magenta(`⟶ baton: ${from ?? "—"} → ${agent}`));
    console.log(pc.dim(`shared context written to .loom/memory/${agent}.md`));
  });

program
  .command("interrupt")
  .description("interrupt the agent holding the baton")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { interrupted } = await client.interrupt(project.id);
    console.log(pc.dim(interrupted ? `interrupted ${interrupted}` : "nothing running"));
  });

program
  .command("digest")
  .description("what happened in this project while you were away")
  .option("--since <hours>", "how far back to look, in hours", "12")
  .action(async (opts: { since: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const hours = Math.max(0.1, Number(opts.since) || 12);
    const d = await client.digest(project.id, Date.now() - hours * 3_600_000);
    if (!d.lines.length) {
      console.log(pc.dim(`nothing in the last ${hours} hour${hours === 1 ? "" : "s"}`));
      return;
    }
    const paint: Record<string, (s: string) => string> = {
      question: pc.yellow,
      failed: pc.red,
      landed: pc.green,
      goal: pc.cyan,
      server: pc.red,
      cost: pc.dim,
      turn: pc.dim,
    };
    for (const line of d.lines) {
      const when = new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      console.log(`${pc.dim(when)}  ${(paint[line.kind] ?? ((x: string) => x))(line.text)}`);
    }
    if (d.waiting.length) console.log(pc.yellow(`\nwaiting on you: ${d.waiting.join(", ")}`));
  });

/**
 * The project's dev servers — the thing the Browser tab previews.
 *
 * `loom servers` says what each one is doing, and "running" means a port
 * answered rather than a process existing. Starting and stopping are explicit:
 * nothing here runs a command because it guessed you wanted it.
 */
const serversCmd = program
  .command("servers")
  .description("this project's dev servers: what they are and what they're doing")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { servers, suggested } = await client.servers(project.id);
    if (!servers.length) {
      console.log(pc.dim("no servers configured for this project"));
      if (suggested.length) {
        console.log(pc.dim("package.json suggests:"));
        for (const s of suggested) console.log(`  ${pc.cyan(s.name.padEnd(10))} ${s.command}${s.port ? pc.dim(`  :${s.port}`) : ""}`);
        console.log(pc.dim('add them under "servers" in .loom/config.json'));
      }
      return;
    }
    const paint = (s: { state: string }) =>
      s.state === "running" ? pc.green("running") : s.state === "starting" ? pc.yellow("starting") : s.state === "crashed" ? pc.red("crashed") : pc.dim("stopped");
    for (const s of servers) {
      const up = s.startedAt ? pc.dim(` up ${Math.max(1, Math.round((Date.now() - s.startedAt) / 1000))}s`) : "";
      const why = s.state === "crashed" && s.exitCode !== null ? pc.dim(` (exit ${s.exitCode})`) : "";
      console.log(`${pc.cyan(s.name.padEnd(12))} ${paint(s).padEnd(18)} ${s.port ? pc.dim(":" + s.port) : ""}${up}${why}`);
      console.log(`${" ".repeat(13)}${pc.dim(s.command)}`);
    }
  });

for (const action of ["start", "stop", "restart"] as const) {
  serversCmd
    .command(`${action} <name>`)
    .description(`${action} a dev server`)
    .action(async (name: string) => {
      const client = await ensureDaemon();
      const project = await currentProject(client);
      const { server } = await client.serverAction(project.id, name, action);
      console.log(pc.dim(`${server.name}: ${server.state}${server.port ? ` on :${server.port}` : ""}`));
    });
}

serversCmd
  .command("logs <name>")
  .description("a dev server's recent output")
  .option("-n, --lines <n>", "how many lines", "80")
  .action(async (name: string, opts: { lines: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { lines } = await client.serverLog(project.id, name, Math.max(1, Number(opts.lines) || 80));
    for (const l of lines) {
      const mark = l.stream === "err" ? pc.red("!") : l.stream === "loom" ? pc.dim("\u00b7") : " ";
      console.log(`${mark} ${l.text}`);
    }
    if (!lines.length) console.log(pc.dim("nothing yet"));
  });

/**
 * Is there a newer Loom, and fetch it.
 *
 * `--check` only looks. Without it, the update runs the same commands the
 * daemon would print: a checkout pulls and rebuilds, a global install
 * reinstalls itself, and anything else is told where the release is rather
 * than having a command guessed at and run over it.
 */
program
  .command("update")
  .description("check for a newer Loom and install it")
  .option("--check", "only say whether an update exists")
  .option("--yes", "don't ask before updating")
  .action(async (opts: { check?: boolean; yes?: boolean }) => {
    const client = await ensureDaemon();
    const u = await client.updates(true);
    console.log(`installed ${u.version}${u.latest ? `   latest ${u.latest}` : ""}   ${pc.dim(u.install)}`);
    if (!u.behindRelease) {
      console.log(pc.dim(u.latest ? "up to date" : "no published release to compare with"));
      if (u.git?.behind) console.log(pc.yellow(`the checkout is ${u.git.behind} commit(s) behind ${u.git.branch}`));
      return;
    }
    console.log(pc.yellow(`Loom ${u.latest} is out`) + (u.release?.url ? pc.dim(`  ${u.release.url}`) : ""));
    if (opts.check) return;
    if (!u.canApply) {
      console.log(pc.dim(u.refusal ?? "this install can't update itself"));
      return;
    }
    console.log("this will run:");
    for (const step of u.steps) console.log(`  ${pc.cyan(step)}`);
    if (!opts.yes) {
      const ok = await confirm("update now?");
      if (!ok) return console.log(pc.dim("left as it is"));
    }
    await client.applyUpdate();
    console.log(pc.dim("updating — the daemon restarts on the new build when it finishes (loom log -f to watch)"));
  });

/**
 * The prompt queue: what you've lined up for this project, run one at a time.
 *
 * `loom queue` shows it; `loom queue add` puts one at the back; the rest edit
 * what's waiting. Positions are what you see in the list (1 is next to run), so
 * `loom queue rm 2` removes the one printed as 2 — ids work too.
 */
const queueCmd = program
  .command("queue")
  .description("prompts lined up for this project — see, edit, reorder, pause")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const view = await client.queue(project.id);
    if (!view.queue.length) {
      console.log(pc.dim("nothing queued — loom queue add \"…\" puts one in line"));
      return;
    }
    const where = (t: QueueItem["target"]) =>
      t.kind === "orchestra" ? "orchestrate" : t.kind === "auto" ? "auto" : t.agentId;
    view.queue.forEach((item, i) => {
      const head = `${pc.dim(String(i + 1).padStart(2))} ${pc.cyan(where(item.target).padEnd(12))}`;
      const lines = item.text.split("\n");
      console.log(`${head} ${lines[0]}${lines.length > 1 ? pc.dim(` +${lines.length - 1} more lines`) : ""}`);
      console.log(`${" ".repeat(15)}${pc.dim(item.id + (item.editedAt ? " · edited" : "") + (item.plan ? " · plan mode" : ""))}`);
    });
    const note = view.paused ? pc.yellow(view.reason ?? "paused") : view.waitingFor ? pc.dim(view.waitingFor) : pc.dim("next one goes as soon as it can");
    console.log(`\n${view.queue.length} queued${view.paused ? pc.yellow(" · paused") : ""} · ${note}`);
  });

/** "15:00", "2026-09-21T03:00", "+90m" — the ways a person says when. */
function readWhen(when: string): number {
  const rel = /^\+(\d+)\s*([smhd])$/i.exec(when.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
    return Date.now() + n * unit;
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(when.trim());
  if (clock) {
    const d = new Date();
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    // a time already past today means tomorrow — nobody queues for the past
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const parsed = Date.parse(when);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`I can't read "${when}" as a time — try 15:00, +90m, or 2026-09-21T03:00`);
}

/** The item you meant: a position from the printed list, or an id. */
async function queueItemId(client: DaemonClient, projectId: string, which: string): Promise<string> {
  const { queue } = await client.queue(projectId);
  const n = Number(which);
  if (Number.isInteger(n) && n >= 1 && n <= queue.length) return queue[n - 1]!.id;
  const hit = queue.find((i) => i.id === which);
  if (!hit) throw new Error(`no queued prompt "${which}" — loom queue lists them`);
  return hit.id;
}

queueCmd
  .command("add <text...>")
  .description("line a prompt up behind whatever is running")
  .option("--to <target>", 'who takes it: an agent id, "orchestrate" for a new goal, or "auto"', "auto")
  .option("--plan", "queue it in plan mode")
  .action(async (text: string[], opts: { to: string; plan?: boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const target = opts.to === "orchestrate" ? "orchestra" : opts.to;
    const res = await client.queueAdd(project.id, { text: text.join(" "), target, ...(opts.plan ? { plan: true } : {}) });
    console.log(pc.dim(`queued ${res.item.id} · ${res.queue.length} waiting`));
  });

queueCmd
  .command("edit <which> <text...>")
  .description("rewrite a queued prompt (by position or id)")
  .action(async (which: string, text: string[]) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const id = await queueItemId(client, project.id, which);
    await client.queueEdit(project.id, id, { text: text.join(" ") });
    console.log(pc.dim(`edited ${id}`));
  });

queueCmd
  .command("to <which> <target>")
  .description('send a waiting prompt somewhere else: an agent id, "orchestrate" or "auto"')
  .action(async (which: string, target: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const id = await queueItemId(client, project.id, which);
    await client.queueEdit(project.id, id, { target: target === "orchestrate" ? "orchestra" : target });
    console.log(pc.dim(`${id} → ${target}`));
  });

queueCmd
  .command("move <which> <position>")
  .description("move a queued prompt (1 is next to run)")
  .action(async (which: string, position: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const id = await queueItemId(client, project.id, which);
    await client.queueEdit(project.id, id, { to: Math.max(0, Number(position) - 1) });
    console.log(pc.dim(`moved ${id} to ${position}`));
  });

queueCmd
  .command("rm <which>")
  .description("drop a queued prompt before it runs")
  .action(async (which: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const id = await queueItemId(client, project.id, which);
    const res = await client.queueRemove(project.id, id);
    console.log(pc.dim(`removed ${id} · ${res.queue.length} waiting`));
  });

queueCmd
  .command("at <when> <text...>")
  .description('queue a prompt for later — "15:00", "2026-09-21T03:00", or "+90m"')
  .option("--to <target>", 'who takes it: an agent id, "orchestrate" or "auto"', "auto")
  .action(async (when: string, text: string[], opts: { to: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const at = readWhen(when);
    const res = await client.queueAdd(project.id, {
      text: text.join(" "),
      target: opts.to === "orchestrate" ? "orchestra" : opts.to,
      when: { kind: "at", at },
    });
    console.log(pc.dim(`queued ${res.item.id} for ${new Date(at).toLocaleString()}`));
  });

queueCmd
  .command("after <what> <text...>")
  .description('queue a prompt until a goal lands or its checks go green: "landed:<runId>" or "green:<runId>"')
  .option("--to <target>", "who takes it", "auto")
  .action(async (what: string, text: string[], opts: { to: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const [kind, runId] = what.split(":");
    if (!runId || (kind !== "landed" && kind !== "green")) {
      throw new Error('say landed:<runId> or green:<runId> — loom orchestra lists the runs');
    }
    const res = await client.queueAdd(project.id, {
      text: text.join(" "),
      target: opts.to === "orchestrate" ? "orchestra" : opts.to,
      when: { kind: kind === "landed" ? "landed" : "checks-green", runId },
    });
    console.log(pc.dim(`queued ${res.item.id}, waiting for ${runId}`));
  });

queueCmd
  .command("save <name>")
  .description("save what's queued as a recipe you can run anywhere")
  .action(async (name: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { recipe } = await client.saveQueueRecipe(project.id, name);
    console.log(pc.dim(`saved "${recipe.name}" — ${recipe.steps.length} step(s)`));
  });

queueCmd
  .command("run <name>")
  .description("queue a saved recipe on this project")
  .action(async (name: string) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const res = await client.runQueueRecipe(project.id, name);
    console.log(pc.dim(`queued ${res.added} step(s) — ${res.queue.length} waiting`));
  });

queueCmd
  .command("recipes")
  .description("the recipes saved on this machine")
  .action(async () => {
    const client = await ensureDaemon();
    const { recipes } = await client.recipes();
    if (!recipes.length) return console.log(pc.dim("none saved — loom queue save <name>"));
    for (const r of recipes) {
      console.log(`${pc.cyan(r.name)} ${pc.dim(`${r.steps.length} step(s)${r.fromProject ? ` · from ${r.fromProject}` : ""}`)}`);
      for (const s of r.steps) console.log(`  ${pc.dim(s.to.padEnd(12))} ${s.text.split("\n")[0]!.slice(0, 80)}`);
    }
  });

queueCmd
  .command("clear")
  .description("drop everything that's waiting")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const res = await client.queueClear(project.id);
    console.log(pc.dim(`dropped ${res.dropped}`));
  });

queueCmd
  .command("pause")
  .description("hold the queue where it is")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    await client.queuePause(project.id, true);
    console.log(pc.dim("paused — loom queue resume lets it run"));
  });

queueCmd
  .command("resume")
  .description("let the queue run again")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const view = await client.queuePause(project.id, false);
    console.log(pc.dim(`running · ${view.queue.length} waiting`));
  });

const memoryCmd = program
  .command("memory")
  .description("the unified brain — one memory across every connected ADE")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { memory } = await client.memory(project.id);
    console.log(memory.document);
    console.log(
      pc.dim(
        `\n${memory.sources.length} ADE memory source(s), ${memory.decisions.length} decision(s)` +
          (memory.sources.length ? " · " + memory.sources.map((s) => s.file).join(", ") : ""),
      ),
    );
  });

memoryCmd
  .command("import")
  .description("pull each connected ADE's native memory into the shared brain")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { imported, sources } = await client.importMemory(project.id);
    console.log(
      imported
        ? pc.green(`✓ imported ${imported} memory source(s): ${sources.join(", ")}`)
        : pc.dim("shared brain already current — nothing new to import"),
    );
  });

program
  .command("costs")
  .description("what this project has spent, per agent")
  .option("--series [days]", "daily breakdown instead of totals (default 14 days)")
  .action(async (opts: { series?: string | boolean }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    if (opts.series) {
      const days = typeof opts.series === "string" ? Number(opts.series) || 14 : 14;
      const { series } = await client.costSeries(project.id, days);
      if (!series.length) return void console.log(pc.dim("no spend in this window"));
      for (const d of series) {
        const agents = Object.entries(d.byAgent)
          .map(([id, a]) => `${id} ${fmtUsd(a.usd)}`)
          .join("  ");
        console.log(`${d.day}  ${fmtUsd(d.usd).padStart(9)}  ${String(d.turns).padStart(4)} turns  ${pc.dim(agents)}`);
      }
      return;
    }
    const { costs } = await client.costs(project.id);
    console.log(
      pc.bold(`${project.name}`) +
        pc.dim(
          `  total ${fmtUsd(costs.totalUsd)} · ${costs.turns} turns · ${(costs.totalMs / 1000).toFixed(0)}s agent time`,
        ),
    );
    for (const a of costs.byAgent) {
      console.log(
        `  ${pc.bold(a.agentId.padEnd(14))} ${fmtUsd(a.usd).padStart(9)}  ${String(a.turns).padStart(4)} turns  ${(a.ms / 1000).toFixed(0).padStart(5)}s`,
      );
    }
    if (!costs.byAgent.length) console.log(pc.dim("  no turns recorded yet"));
    console.log(pc.dim("\n(costs come from agents that report them — claude-code and opencode do)"));
  });

program
  .command("decision <text...>")
  .description("record a decision into shared memory (projected on every handoff)")
  .action(async (words: string[]) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    await client.decision(project.id, words.join(" "));
    console.log(pc.blue("★ recorded"));
  });

program
  .command("log")
  .description("show the project event log")
  .option("-f, --follow", "stream live events", false)
  .option("-n, --limit <n>", "how many recent events", "40")
  .action(async (opts: { follow: boolean; limit: string }) => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    const { events } = await client.events(project.id, undefined, Number(opts.limit));
    for (const e of events) printEvent(e);
    if (opts.follow) {
      const lastSeen = { id: events[events.length - 1]?.id ?? 0 };
      client.subscribe((pid, e) => {
        if (pid !== project.id || e.id <= lastSeen.id) return;
        lastSeen.id = e.id;
        printEvent(e);
      }, project.id);
      await new Promise(() => {}); // stream until Ctrl-C
    }
  });

// ---------------------------------------------------------------------------
// route — automated multi-hop pipelines
// ---------------------------------------------------------------------------

program
  .command("route [spec] [task...]")
  .description(
    "run a task through agents — spec: \"auto\" (LLM picks each hop), a route name, or ids/roles like planner,executor",
  )
  .option("--status", "show the current/last route", false)
  .option("--abort", "abort the active route", false)
  .option("-d, --detach", "don't follow — notifications will tell you when it's done", false)
  .option("--router <kind>", "for auto: llm (default) or rules")
  .option("--max-hops <n>", "for auto: hop budget (default 8)")
  .action(
    async (
      spec: string | undefined,
      words: string[],
      opts: {
        status: boolean;
        abort: boolean;
        detach: boolean;
        router?: "rules" | "llm";
        maxHops?: string;
      },
    ) => {
      const client = await ensureDaemon();
      const project = await currentProject(client);

      if (opts.status) {
        const { route } = await client.routeState(project.id);
        if (!route) return void console.log(pc.dim("no route has run in this project"));
        const flow = route.steps
          .map((s, i) => (i === route.current ? pc.bold(s) : s))
          .join(" → ");
        console.log(
          `${pc.cyan(route.name ?? "route")} [${route.status}] ${flow}` +
            pc.dim(`  task: ${route.task.slice(0, 80)}`),
        );
        if (route.pendingQuestion) console.log(pc.yellow(`  ⏸ asks: ${route.pendingQuestion}`));
        if (route.reason) console.log(pc.dim(`  reason: ${route.reason}`));
        if (route.costUsd && route.costUsd > 0) console.log(pc.dim(`  cost: ${fmtUsd(route.costUsd)}`));
        return;
      }
      if (opts.abort) {
        const { route } = await client.abortRoute(project.id);
        console.log(pc.yellow(`⊘ route stopped: ${route.reason ?? "aborted"}`));
        return;
      }
      if (!spec || !words.length) {
        fail(
          'usage: loom route <name|steps> "<task>"   e.g. loom route planner,executor "add dark mode"\n' +
          "  a step runs only if the previous turn meets its condition: 'planner,executor,reviewer?lines>200'\n" +
          "  (or: loom route --status / --abort)",
        );
      }

      const { route } = await client.startRoute(project.id, words.join(" "), spec, {
        ...(opts.router ? { router: opts.router } : {}),
        ...(opts.maxHops ? { maxHops: Number(opts.maxHops) } : {}),
      });
      console.log(
        pc.cyan(
          route.mode === "dynamic"
            ? `➤ route "auto" (${route.router} picks each hop, budget ${route.maxHops}): started with ${route.steps.join(" → ")}`
            : `➤ route${route.name ? ` "${route.name}"` : ""}: ${route.steps.join(" → ")}`,
        ),
      );
      if (opts.detach) {
        console.log(pc.dim("running in the background — you'll be notified at each pause/finish"));
        return;
      }

      console.log(pc.dim("following — Ctrl-C detaches, the route keeps running\n"));
      const lastSeen = { id: 0 };
      await new Promise<void>((resolve) => {
        client.subscribe((pid, e) => {
          if (pid !== project.id || e.id <= lastSeen.id) return;
          lastSeen.id = e.id;
          printEvent(e);
          if (e.kind === "route_completed" || e.kind === "route_failed") resolve();
        }, project.id);
      });
      const { route: finalState } = await client.routeState(project.id);
      process.exit(finalState?.status === "completed" ? 0 : 1);
    },
  );

program
  .command("routes")
  .description("named routes defined for the current project")
  .action(async () => {
    const client = await ensureDaemon();
    await currentProject(client); // validates we're in a project
    const dir = currentProjectDir()!;
    const { readProjectConfig } = await import("../core/registry.js");
    const cfg = readProjectConfig(dir);
    const routes = cfg?.routes ?? {};
    if (!Object.keys(routes).length) {
      console.log(pc.dim('no named routes — add {"routes":{"ship":["planner","executor"]}} to .loom/config.json'));
      return;
    }
    for (const [name, steps] of Object.entries(routes)) {
      const rendered = steps
        .map((s) =>
          typeof s === "string" ? s : `${s.step}${s.instruction ? pc.dim(` ("${s.instruction}")`) : ""}`,
        )
        .join(" → ");
      console.log(`${pc.cyan(pc.bold(name))}  ${rendered}`);
    }
    console.log(pc.dim('\nrun one: loom route <name> "<task>" · ad-hoc: loom route a,b,c "<task>"'));
  });

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

program
  .command("doctor")
  .description("diagnose the environment, daemon, and current project")
  .option("--json", "print machine-readable diagnostic results")
  .option("--fix", "repair what has exactly one safe repair; report the rest")
  .action(async (opts: { json: boolean; fix?: boolean }) => {
    const { doctorReport, envChecks, projectChecks, fixProject } = await import("./doctor.js");
    const dir = currentProjectDir();
    if (opts.fix) {
      if (!dir) {
        console.error(pc.red("not inside a Loom project — nothing to fix"));
        process.exitCode = 1;
        return;
      }
      const { fixed, unfixable } = fixProject(dir);
      for (const f of fixed) console.log(` ${pc.green("✓")} ${f}`);
      for (const u of unfixable) console.log(` ${pc.yellow("⚠")} ${u}`);
      if (!fixed.length && !unfixable.length) console.log(pc.dim("nothing needed fixing"));
      // fall through to a fresh diagnosis, so the report reflects the repairs
    }
    const checks = await envChecks();
    if (dir) checks.push(...projectChecks(dir));
    else checks.push({ name: "project", status: "warn", detail: "not inside a Loom project (loom init)" });

    const report = doctorReport(checks);
    if (opts.json) {
      console.log(JSON.stringify(report));
      if (report.summary.failures) process.exitCode = 1;
      return;
    }

    for (const c of checks) {
      const icon =
        c.status === "ok" ? pc.green("✓") : c.status === "warn" ? pc.yellow("⚠") : pc.red("✗");
      console.log(` ${icon} ${pc.bold(c.name.padEnd(11))} ${c.status === "ok" ? pc.dim(c.detail) : c.detail}`);
    }
    if (report.summary.failures) {
      console.log(pc.red(`\n${report.summary.failures} problem${report.summary.failures > 1 ? "s" : ""} found`));
      process.exit(1);
    }
    // "all clear" over a screen of warnings is a lie, and it's the lie that
    // teaches people to stop reading this command. Nothing is broken; several
    // things aren't set up. Those are different sentences.
    if (report.summary.warnings) {
      console.log(
        pc.yellow(
          `\nnothing broken · ${report.summary.warnings} thing${report.summary.warnings > 1 ? "s" : ""} not set up (see above)`,
        ),
      );
      return;
    }
    console.log(pc.green("\nall clear"));
  });

program
  .command("clients")
  .description("list paired devices, revoke one, or ping them with a test push")
  .option("--revoke <id>", "revoke a paired device's access")
  .option("--ping", "send a test push notification to all registered devices", false)
  .action(async (opts: { revoke?: string; ping: boolean }) => {
    const client = await ensureDaemon();
    if (opts.revoke) {
      await client.revokeClient(opts.revoke);
      console.log(pc.green(`✓ revoked ${opts.revoke}`));
      return;
    }
    if (opts.ping) {
      const { sent } = await client.pushTest();
      console.log(
        sent
          ? pc.green(`✓ test push sent to ${sent} device${sent === 1 ? "" : "s"}`)
          : pc.dim("no devices registered for push — open the Loom app once after pairing"),
      );
      return;
    }
    const { clients } = await client.pairedClients();
    if (!clients.length) return void console.log(pc.dim("no paired devices — loom pair"));
    for (const c of clients) {
      console.log(
        ` ${pc.bold(c.name)} ${pc.dim(`(${c.id})`)} paired ${new Date(c.createdAt).toLocaleString()}` +
          (c.push ? pc.green("  ·push✓") : pc.dim("  ·no push")),
      );
    }
    console.log(pc.dim("\nrevoke: loom clients --revoke <id> · test push: loom clients --ping"));
  });

program
  .command("pair")
  .description("pair a phone/device: QR with a short-lived, single-use token")
  .option("--allow-local", "mint a localhost QR anyway (same-machine testing)", false)
  .action(async (opts: { allowLocal: boolean }) => {
    const client = await ensureDaemon();
    const cfg = await daemonRunning();
    const loopback = cfg && ["127.0.0.1", "localhost", "::1"].includes(cfg.host);
    if (loopback && !opts.allowLocal) {
      // A localhost QR is unreachable from a phone — the #1 "failed to
      // fetch" cause. Refuse and say exactly what to run instead.
      console.error(pc.red("✗ daemon is bound to localhost — your phone cannot reach 127.0.0.1"));
      console.error(pc.bold("\n  fix:"));
      console.error(pc.bold("    loom up --restart --tailnet"));
      console.error(pc.bold("    loom pair"));
      console.error(
        pc.dim(
          "\n  needs Tailscale on this machine (`tailscale up`) and on your phone (same tailnet).\n" +
            "  testing on this machine only? loom pair --allow-local",
        ),
      );
      process.exit(1);
    }
    const { token, expiresAt, url } = await client.newPairingToken();
    // Deep link: scanning with any camera opens the phone app, which claims
    // the (single-use, 10-min) token from the URL fragment and pairs itself.
    const link = `${url}/app#pair=${token}`;
    qrcode.generate(link, { small: true }, (qr) => console.log(qr));
    console.log(pc.bold(`  ${link}`));
    console.log(
      pc.dim(
        `  scan with your phone camera · single use · expires ${new Date(expiresAt).toLocaleTimeString()}`,
      ),
    );
    console.log(pc.dim(`  (manual claim: POST ${url}/api/pair/claim {"token":"${token.slice(0, 6)}…"})`));
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
