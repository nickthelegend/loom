import type { Command } from "commander";
import { ensureDaemon } from "../daemon/client.js";
import { readDaemonConfig } from "../core/registry.js";
import { validateQuiet } from "../core/phone-r4/preferences.js";
export function registerPhoneCommands(program: Command): void {
  const phone = program.command("phone").description("Now, morning brief and notification preferences");
  async function request(path: string, method = "GET", body?: unknown, device?: string) {
    const client = await ensureDaemon(), config = readDaemonConfig()!;
    const paired = device ? config.clients.find(c => c.id === device) : undefined;
    if (device && !paired) throw new Error("unknown paired device");
    const response = await fetch(client.baseUrl + path, { method, headers: { authorization: `Bearer ${paired?.token ?? config.adminToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? response.status));
    return data;
  }
  phone.command("now").description("running turns, questions and approvals").action(async () => { console.log(JSON.stringify(await request("/api/phone/now"))); });
  phone.command("brief <project>").description("yesterday's finished turns, spend and waiting PRs").action(async (project: string) => {
    const end = new Date(); end.setHours(0, 0, 0, 0); const start = new Date(end); start.setDate(start.getDate() - 1);
    console.log(JSON.stringify(await request(`/api/projects/${encodeURIComponent(project)}/phone/brief?start=${+start}&end=${+end}`)));
  });
  phone.command("quiet").description("read or replace shared owner quiet hours (scoped devices stay isolated)")
    .requiredOption("--device <id>", "paired device id from loom clients")
    .option("--set <json>", "quiet hours: enabled,start,end,timeZone,allowApprovals,snoozeUntil")
    .action(async (opts: { device: string; set?: string }) => { console.log(JSON.stringify(await request("/api/push/quiet", opts.set ? "PUT" : "GET", opts.set ? validateQuiet(JSON.parse(opts.set)) : undefined, opts.device))); });
  phone.command("notify <project> <chat> <level>").description("all, needs-you or none (mute messages, approvals still notify) for one chat")
    .requiredOption("--device <id>", "paired device id")
    .action(async (project: string, chat: string, level: string, opts: { device: string }) => { console.log(JSON.stringify(await request(`/api/projects/${encodeURIComponent(project)}/chats/${encodeURIComponent(chat)}/notification-level`, "PUT", { level }, opts.device))); });
}
