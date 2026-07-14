#!/usr/bin/env node
/**
 * loom — one CLI for all your coding agents.
 *
 * Weaves Claude Code, OpenCode (and bridges like Antigravity) into a single
 * shared thread per project: one conversation, one baton, shared memory.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import qrcode from "qrcode-terminal";
import type { LoomEvent, ProjectStatus } from "../types.js";
import { findProject } from "../core/registry.js";
import {
  DaemonClient,
  DaemonError,
  daemonRunning,
  ensureDaemon,
  stopDaemon,
} from "../daemon/client.js";
import { LoomDaemon, DEFAULT_PORT } from "../daemon/server.js";
import { formatAgentRow, formatEvent, formatProjectRow } from "./ui.js";

const program = new Command();

program
  .name("loom")
  .description("one CLI for all your coding agents — shared thread, shared memory, one baton")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(pc.red(`✗ ${message}`));
  process.exit(1);
}

/** Walk up from cwd to the nearest directory containing .loom/config.json. */
function currentProjectDir(): string | null {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".loom", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function currentProject(client: DaemonClient): Promise<ProjectStatus> {
  const dir = currentProjectDir();
  if (!dir) fail("no Loom project here — run `loom init` in your project directory");
  let info = findProject(dir);
  if (!info) {
    // Directory has .loom but isn't registered (e.g. cloned repo) — register.
    await client.addProject(dir);
    info = findProject(dir);
  }
  if (!info) fail(`could not register project at ${dir}`);
  const { project } = await client.project(info.id);
  return project;
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
// daemon / up / down / status
// ---------------------------------------------------------------------------

program
  .command("daemon")
  .description("run the loom daemon in the foreground")
  .option("--port <port>", "port to listen on", String(DEFAULT_PORT))
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--tailnet", "bind to this machine's Tailscale IP (phone access)", false)
  .action(async (opts: { port: string; host: string; tailnet: boolean }) => {
    const daemon = new LoomDaemon({ host: opts.host, port: Number(opts.port) });
    const { host, port } = await daemon.listen({ tailnet: opts.tailnet });
    console.log(pc.green(`loom daemon listening on http://${host}:${port}`));
    if (opts.tailnet) {
      console.log(pc.dim("bound to the tailnet — pair your phone with `loom pair`"));
    }
    const shutdown = () => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("up")
  .description("start the loom daemon in the background")
  .option("--tailnet", "bind to this machine's Tailscale IP", false)
  .action(async (opts: { tailnet: boolean }) => {
    if (await daemonRunning()) {
      console.log(pc.dim("daemon already running"));
      return;
    }
    const self = fileURLToPath(import.meta.url);
    const args = [self, "daemon", ...(opts.tailnet ? ["--tailnet"] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
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
  .action(async () => {
    const client = await ensureDaemon();
    const { projects } = await client.listProjects();
    if (!projects.length) console.log(pc.dim("no projects yet — loom init"));
    for (const p of projects) console.log(formatProjectRow(p));
  });

program
  .command("agents")
  .description("agents in the current project")
  .action(async () => {
    const client = await ensureDaemon();
    const project = await currentProject(client);
    for (const a of project.agents) console.log(formatAgentRow(a));
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
// pair
// ---------------------------------------------------------------------------

program
  .command("pair")
  .description("pair a phone/device: QR with a short-lived, single-use token")
  .action(async () => {
    const client = await ensureDaemon();
    const cfg = await daemonRunning();
    if (cfg && cfg.host === "127.0.0.1") {
      console.log(
        pc.yellow(
          "note: daemon is bound to localhost — for phone access restart with `loom down && loom up --tailnet`",
        ),
      );
    }
    const { token, expiresAt, url } = await client.newPairingToken();
    const payload = JSON.stringify({ v: 1, kind: "loom-pair", url, token });
    qrcode.generate(payload, { small: true }, (qr) => console.log(qr));
    console.log(pc.dim(`payload: ${payload}`));
    console.log(
      pc.dim(
        `single use · expires ${new Date(expiresAt).toLocaleTimeString()} · claim: POST ${url}/api/pair/claim {"token":"…"}`,
      ),
    );
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
