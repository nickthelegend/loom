import type { Command } from "commander";
import pc from "picocolors";
import type { DaemonClient } from "../daemon/client.js";
import type { Trigger } from "../core/triggers.js";

type Options = Record<string, string | boolean | undefined>;
export function triggerInput(prompt: string | undefined, opts: Options): Record<string, unknown> {
  const choices = [opts.onChange, opts.on, opts.onCommit, opts.watchUrl, opts.when, opts.cron, opts.webhook, !opts.watchUrl && opts.every].filter(Boolean);
  if (choices.length !== 1) throw new Error("say when: one of --on-change, --on, --on-commit, --watch-url, --when, --every, --cron or --webhook");
  const kind = opts.onChange ? "file" : opts.on ? "event" : opts.onCommit ? "branch" : opts.watchUrl ? "url" : opts.webhook ? "webhook" : "schedule";
  return { kind, prompt: prompt ?? "", ...Object.fromEntries(["onChange", "on", "onCommit", "watchUrl", "select", "when", "every", "cron", "name", "agent", "recipe", "orchestrate", "route", "githubCommand"].filter(k => opts[k] !== undefined).map(k => [k, opts[k]])),
    ...(opts.if ? { condition: opts.if } : {}), ...(opts.failureLimit ? { failureLimit: Number(opts.failureLimit) } : {}), ...(opts.minInterval ? { minIntervalSec: Number(opts.minInterval) } : {}) };
}

// Intentionally overrides the legacy triggers and triggers:add actions. The r4-auto-core
// SHA-256 guards require parallel edits to those handlers to be ported here.
export function registerAutomationCli(program: Command, ensureDaemon: () => Promise<DaemonClient>, currentProject: (client: DaemonClient) => Promise<{ id: string }>): void {
  program.commands.find(c => c.name() === "triggers")!.action(async (opts: { json?: boolean }) => {
    const client = await ensureDaemon(), project = await currentProject(client);
    const { triggers, runs } = await client.triggers(project.id);
    if (opts.json) return void console.log(JSON.stringify({ triggers, runs }));
    if (!triggers.length) return void console.log(pc.dim('no triggers — loom triggers:add "<prompt>" --every 1h | --cron "0 9 * * 1-5" | --webhook'));
    for (const t of triggers) {
      const when = t.kind === "file" ? `changes in ${t.onChange}` : t.kind === "event" ? `on ${t.on}` : t.kind === "branch" ? `commits on ${t.onCommit}` : t.kind === "url" ? `watch ${t.watchUrl}` : t.kind === "webhook" ? `webhook ${pc.dim(`${client.baseUrl}/api/webhooks/trigger/${t.id}`)}` : t.cron ? `cron ${t.cron}` : `every ${t.everyMin}m`;
      const next = t.nextAt ? pc.dim(` · next ${new Date(t.nextAt).toLocaleString()}`) : "";
      console.log(`${t.enabled ? pc.green("●") : pc.dim("○")} ${pc.bold(t.id)} ${t.name} — ${when}${next}${t.agent ? pc.dim(` → ${t.agent}`) : ""}`);
      console.log(pc.dim(`    ${String(t.prompt).split("\n")[0]!.slice(0, 100)}`));
      for (const r of runs.filter(x => x.trigger === t.id).slice(0, 3)) console.log(`    ${r.ok ? pc.green("✓") : pc.yellow("·")} ${pc.dim(new Date(r.at).toLocaleString())} ${r.note}`);
    }
  });
  const add = program.commands.find(c => c.name() === "triggers:add")!;
  add.registeredArguments[0]!.required = false;
  add.option("--on-change <glob>", "watch project files after edits settle")
    .option("--on <event>", "turn_failed, pr_merged, ci_failed, run_completed or approval_expired")
    .option("--on-commit <branch>", "watch a local or remote-tracking branch")
    .option("--when <schedule>", "plain-language schedule; preview the next five runs before saving")
    .option("--if <condition>", "clean, dirty, file:<glob>, hours:9-18, or cmd:<command>")
    .option("--recipe <name>", "start an Orchestra recipe")
    .option("--orchestrate", "start an Orchestra goal")
    .option("--route <name>", "start a saved route")
    .option("--watch-url <url>", "watch a public page or JSON response")
    .option("--select <path>", "watch only this JSON dot path")
    .option("--failure-limit <runs>", "pause after this many consecutive failures (default 3)")
    .action(async (prompt: string | undefined, opts: Options) => {
      const advanced = ["onChange", "on", "onCommit", "when", "if", "recipe", "orchestrate", "route", "watchUrl", "failureLimit"].some(k => opts[k] !== undefined);
      if (!advanced && [opts.every, opts.cron, opts.webhook].filter(Boolean).length !== 1) throw new Error("say when: one of --every, --cron or --webhook");
      const input = triggerInput(prompt, opts), client = await ensureDaemon(), project = await currentProject(client);
      const base = `/api/projects/${encodeURIComponent(project.id)}`;
      if (opts.when) {
        const preview = await client.automation<{ cron: string; next: number[] }>(base + "/automation/preview", "POST", { when: opts.when });
        console.log(`Cron: ${preview.cron} (daemon local time)`);
        preview.next.forEach(at => console.log(`  ${new Date(at).toLocaleString()}`));
      }
      const out = await client.automation<{ trigger: Trigger & { nextAt?: number }; secret?: string; path?: string }>(base + (advanced ? "/automation/triggers" : "/triggers"), "POST", input);
      console.log(`${pc.green("✓")} ${pc.bold(out.trigger.id)} ${out.trigger.name}${out.trigger.nextAt ? pc.dim(` — first run ${new Date(out.trigger.nextAt).toLocaleString()}`) : ""}`);
      if (out.secret) {
        console.log(`\n  URL     ${client.baseUrl}${out.path}`);
        console.log(`  secret  ${out.secret}  ${pc.yellow("(shown once)")}`);
        console.log(pc.dim("\n  sign the body: X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body> (GitHub does this when you give it the secret),"));
        console.log(pc.dim("  or send the secret as X-Loom-Secret. To reach it from the internet: tailscale funnel, or loom up --tailnet."));
      }
    });
  program.command("quiet <range>").description("hold automation during local quiet hours, or off")
    .option("--days <days>", "days on which quiet hours start, e.g. mon-fri")
    .action(async (range: string, opts: { days?: string }) => {
      console.log(JSON.stringify(await (await ensureDaemon()).automation("/api/automation", "PUT", { quiet: range, ...(opts.days ? { days: opts.days } : {}) })));
    });
  program.command("triggers:pause").description("hold all automation until resumed, optionally for a duration")
    .option("--for <duration>", "automatically resume after e.g. 2h")
    .action(async (opts: { for?: string }) => { console.log(JSON.stringify(await (await ensureDaemon()).automation("/api/automation", "PUT", { paused: true, ...(opts.for ? { for: opts.for } : {}) }))); });
  program.command("triggers:resume").description("release the global automation pause")
    .action(async () => { console.log(JSON.stringify(await (await ensureDaemon()).automation("/api/automation", "PUT", { paused: false }))); });
  const hooks = program.command("webhooks").description("outgoing signed project webhooks");
  hooks.command("add <url>").requiredOption("--events <events>", "comma-separated event names")
    .action(async (url: string, opts: { events: string }) => {
      const client = await ensureDaemon(), project = await currentProject(client);
      console.log(JSON.stringify(await client.automation(`/api/projects/${encodeURIComponent(project.id)}/automation/webhooks`, "POST", { url, events: opts.events.split(",").map(s => s.trim()) })));
    });
  hooks.command("list").action(async () => {
    const client = await ensureDaemon(), project = await currentProject(client);
    const data = await client.automation(`/api/projects/${encodeURIComponent(project.id)}/automation`);
    console.log(JSON.stringify({ webhooks: data.webhooks, deliveries: data.deliveries }));
  });
  hooks.command("remove <id>").action(async (id: string) => {
    const client = await ensureDaemon(), project = await currentProject(client);
    console.log(JSON.stringify(await client.automation(`/api/projects/${encodeURIComponent(project.id)}/automation/webhooks/${encodeURIComponent(id)}`, "DELETE")));
  });
}
