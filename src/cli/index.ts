#!/usr/bin/env node
/**
 * loom — one CLI for all your coding agents.
 *
 * Weaves Claude Code, OpenCode (and bridges like Antigravity) into a single
 * shared thread per project: one conversation, one baton, shared memory.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import qrcode from "qrcode-terminal";
import type { LoomEvent, ProjectStatus } from "../types.js";
import {
  DaemonClient,
  DaemonError,
  daemonRunning,
  ensureDaemon,
  stopDaemon,
} from "../daemon/client.js";
import { LoomDaemon, DEFAULT_PORT } from "../daemon/server.js";
import { NoProjectError, currentProjectDir, resolveCurrentProject } from "./common.js";
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
        return;
      }
      if (opts.abort) {
        const { route } = await client.abortRoute(project.id);
        console.log(pc.yellow(`⊘ route stopped: ${route.reason ?? "aborted"}`));
        return;
      }
      if (!spec || !words.length) {
        fail(
          'usage: loom route <name|steps> "<task>"   e.g. loom route planner,executor "add dark mode"\n  (or: loom route --status / --abort)',
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
      console.log(`${pc.cyan(pc.bold(name))}  ${steps.join(" → ")}`);
    }
    console.log(pc.dim('\nrun one: loom route <name> "<task>" · ad-hoc: loom route a,b,c "<task>"'));
  });

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

program
  .command("doctor")
  .description("diagnose the environment, daemon, and current project")
  .action(async () => {
    const { envChecks, projectChecks } = await import("./doctor.js");
    const checks = await envChecks();
    const dir = currentProjectDir();
    if (dir) checks.push(...projectChecks(dir));
    else checks.push({ name: "project", status: "warn", detail: "not inside a Loom project (loom init)" });

    let failures = 0;
    for (const c of checks) {
      const icon =
        c.status === "ok" ? pc.green("✓") : c.status === "warn" ? pc.yellow("⚠") : pc.red("✗");
      if (c.status === "fail") failures++;
      console.log(` ${icon} ${pc.bold(c.name.padEnd(8))} ${c.status === "ok" ? pc.dim(c.detail) : c.detail}`);
    }
    if (failures) {
      console.log(pc.red(`\n${failures} problem${failures > 1 ? "s" : ""} found`));
      process.exit(1);
    }
    console.log(pc.green("\nall clear"));
  });

program
  .command("clients")
  .description("list paired devices, or revoke one")
  .option("--revoke <id>", "revoke a paired device's access")
  .action(async (opts: { revoke?: string }) => {
    const client = await ensureDaemon();
    if (opts.revoke) {
      await client.revokeClient(opts.revoke);
      console.log(pc.green(`✓ revoked ${opts.revoke}`));
      return;
    }
    const { clients } = await client.pairedClients();
    if (!clients.length) return void console.log(pc.dim("no paired devices — loom pair"));
    for (const c of clients) {
      console.log(
        ` ${pc.bold(c.name)} ${pc.dim(`(${c.id})`)} paired ${new Date(c.createdAt).toLocaleString()}`,
      );
    }
    console.log(pc.dim("\nrevoke one: loom clients --revoke <id>"));
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
