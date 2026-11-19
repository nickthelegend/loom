import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import type { ProjectStatus } from "../types.js";

type Client = DaemonClient & { teamsR4: (id: string, route: string, body?: Record<string, unknown>) => Promise<Record<string, any>> };
/** Extend existing commands without changing their actions or output for existing invocations. */
export function registerTeamsR4Cli(program: Command, ensure: () => Promise<DaemonClient>, current: (client: DaemonClient) => Promise<ProjectStatus>): void {
  const request = async (route: string, body?: Record<string, unknown>) => {
    const client = await ensure() as Client, project = await current(client);
    return client.teamsR4(project.id, route, body);
  };
  const shared = program.command("shared").description("templates and Orchestra recipes stored in this repo");
  for (const kind of ["templates", "recipes"]) {
    const command = shared.command(kind);
    command.command("list").action(async () => console.log(JSON.stringify(await request(`/library/${kind}`), null, 2)));
    command.command("publish <name>").action(async (name: string) => {
      const out = await request(`/library/${kind}/${encodeURIComponent(name)}/publish`, {});
      console.log(`${out.path}\nCommit this file (git add -f if .loom is ignored) and share it through your repo.`);
    });
    if (kind === "recipes") command.command("run <name>").action(async (name: string) => console.log(JSON.stringify(await request(`/library/recipes/${encodeURIComponent(name)}/run`, {}))));
    else command.command("render <name>").option("--values <json>", "template variable values as JSON", "{}").action(async (name: string, opts: { values: string }) => console.log((await request(`/library/templates/${encodeURIComponent(name)}/render`, { values: JSON.parse(opts.values) })).text));
  }
  program.command("pass <login>").description("pass a chat to a teammate through the existing team mention")
    .option("--chat <id>", "chat to pass", "main").option("--note <text>", "hand-off note")
    .option("--expiry <preset>", "1h, 1d or 7d", "1d").option("--passcode <code>", "protect the link").option("--json", "print JSON")
    .action(async (login: string, opts: Record<string, any>) => {
      const out = await request("/shares", { pass: login, chat: opts.chat, note: opts.note, preset: opts.expiry, passcode: opts.passcode });
      console.log(opts.json ? JSON.stringify(out) : `Passed to ${login}\n${out.url}${out.warning ? "\n" + out.warning : ""}`);
    });
  // Commander keeps the installed action as a processed-argument callback. Wrapping it preserves
  // legacy options, chat lookup and output while giving this batch its own implementation file.
  type ActionCommand = Command & { _actionHandler: (args: unknown[]) => Promise<void> };
  const share = program.commands.find(c => c.name() === "share")! as ActionCommand;
  const previousShare = share._actionHandler;
  share.option("--changes", "share a snapshot of the working-tree changes").option("--review <login>", "request a teammate review")
    .option("--chat <id>", "chat to share").option("--passcode <code>", "protect a read-only link").option("--notify-first-open", "notify when the link is first opened");
  share._actionHandler = async args => {
    const o = share.opts();
    if (!o.changes && !o.review && !o.chat && !o.passcode && !o.notifyFirstOpen) return previousShare(args);
    if (o.live || o.list || o.revoke) throw new Error("these sharing options apply to read-only chat or changes links");
    const out = await request("/shares", { chat: o.chat || args[0] || "main", run: o.run, changes: o.changes, review: o.review, passcode: o.passcode, notifyFirstOpen: o.notifyFirstOpen, ...(o.expiry ? { preset: o.expiry } : o.hours ? { hours: Number(o.hours) } : {}) });
    console.log(o.json ? JSON.stringify(out) : `${out.url}\nExpires ${new Date(out.expiresAt).toLocaleString()}${out.warning ? "\n" + out.warning : ""}`);
  };
  const team = program.commands.find(c => c.name() === "team")! as ActionCommand;
  const previousTeam = team._actionHandler;
  team.option("--since <duration>", "standup window, e.g. 1d", "1d").option("--post <platform>", "post standup through the configured slack or discord bridge");
  team._actionHandler = async args => {
    if (args[0] !== "standup") return previousTeam(args);
    const o = team.opts(), report = await request("/standup", { since: o.since, post: o.post });
    console.log(report.markdown + (report.posted ? `\nPosted to ${report.posted}` : ""));
  };
}
