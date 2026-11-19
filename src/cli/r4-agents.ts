import { resolveCurrentProject } from "./common.js";
import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import type { ProjectStatus } from "../types.js";
import { readDaemonConfig } from "../core/registry.js";

export async function agentsRequest<T = any>(client: DaemonClient, route: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(result.error ?? `HTTP ${r.status}`);
  return result;
}
export function registerR4Agents(program: Command, daemon: () => Promise<DaemonClient>, project: (client: DaemonClient) => Promise<ProjectStatus>): void {
  const run = async (route: string, method = "GET", body?: unknown) => { const c = await daemon(); const p = await project(c); return agentsRequest(c, `/api/projects/${encodeURIComponent(p.id)}${route}`, method, body); };
  const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const profiles = program.command("profiles").description("save and reuse an agent's kind, model, effort, access and instructions");
  profiles.command("list").action(async () => show((await agentsRequest(await daemon(), "/api/profiles")).profiles));
  profiles.command("save <name>").option("--agent <id>", "copy an existing agent").option("--kind <kind>").option("--model <model>").option("--effort <effort>").option("--mode <mode>").option("--instructions <text>").action(async (name, opts) => {
    const c = await daemon(); let body = { ...opts };
    if (opts.agent || !opts.kind) {
      const p = await project(c), a = p.agents.find(a => a.id === (opts.agent ?? p.holder)) ?? (!opts.agent ? p.agents[0] : undefined);
      if (!a) throw new Error("unknown agent");
      const options = await c.agentOptions(p.id, a.id) as { effort?: string };
      body = { kind: a.kind, model: a.model, mode: a.permissions, instructions: a.instructions ?? "", effort: options.effort, ...opts };
    }
    show(await agentsRequest(c, "/api/profiles/" + encodeURIComponent(name), "PUT", body));
  });
  profiles.command("rm <name>").action(async name => show(await agentsRequest(await daemon(), "/api/profiles/" + encodeURIComponent(name), "DELETE")));
  const roster = program.commands.find(c => c.name() === "agents")!;
  roster.hook("postAction", async command => {
    if (command.opts().json) return;
    const c = await daemon(); const p = await resolveCurrentProject(c).catch(() => null);
    for (const a of p?.agents ?? []) if ((a as typeof a & { asleep?: boolean }).asleep) console.log(`${a.id}  Asleep`);
  });
  program.command("chat:archive <chat>").option("--restore").action(async (chat, opts) => show(await run(`/chats/${encodeURIComponent(chat)}`, "PATCH", { archived: !opts.restore })));
  program.command("chat:label <chat> [labels...]").description("replace chat labels; no labels clears them").action(async (chat, labels) => show(await run(`/chats/${encodeURIComponent(chat)}/labels`, "PUT", { labels })));
  program.command("agents:clone <id>").option("--count <n>", "copies (1–8)", "1").option("--model <model>").action(async (id, opts) => show(await run(`/agents/${encodeURIComponent(id)}/clone`, "POST", { count: Number(opts.count), ...(opts.model ? { model: opts.model } : {}) })));
  program.command("agents:limit <id>").option("--turn-minutes <n>").option("--sleep-minutes <n>").option("--retries <n>").option("--retry-wait <seconds>", "retry wait", "5").action(async (id, opts) => show(await run(`/agents/${encodeURIComponent(id)}/limits`, "PUT", { ...(opts.turnMinutes !== undefined ? { maxTurnMinutes: Number(opts.turnMinutes) } : {}), ...(opts.sleepMinutes !== undefined ? { idleSleepMinutes: Number(opts.sleepMinutes) } : {}), ...(opts.retries !== undefined ? { retries: { count: Number(opts.retries), waitSeconds: Number(opts.retryWait) } } : {}) })));
  program.command("agents:env <id> <action> [entry]").description("set KEY=VALUE, unset KEY, or list names (values never leave the daemon)").action(async (id, action, entry) => {
    const route = `/agents/${encodeURIComponent(id)}/env`;
    if (action === "list") return show(await run(route));
    if (action === "unset" && entry) return show(await run(route, "DELETE", { key: entry }));
    const at = String(entry ?? "").indexOf("=");
    if (action !== "set" || at < 1) throw new Error("use set KEY=VALUE, unset KEY, or list");
    show(await run(route, "PUT", { key: entry.slice(0, at), value: entry.slice(at + 1) }));
  });
  program.command("catchup [chat]").option("--since <event>").option("--model <provider/model>", "opt in to a helper model").option("--json").action(async (chat, opts) => {
    const result = await run(`/chats/${encodeURIComponent(chat ?? "main")}/catchup`, "POST", { ...(opts.since !== undefined ? { since: Number(opts.since) } : {}), ...(opts.model ? { model: opts.model } : {}) });
    if (opts.json) show(result); else console.log(result.summary);
  });
}

/** Profile dispatch is called by the public agents:add action. */
export async function addFromProfile(kind: string | undefined, opts: {
  profile: string; count: string; as?: string; model?: string; role?: string; account?: string;
  provider?: string; tools?: boolean; write?: boolean; run?: string; preset?: string; cmd?: string;
}, daemon: () => Promise<DaemonClient>, project: (client: DaemonClient) => Promise<ProjectStatus>): Promise<void> {
  const allowed = (opts.run ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if ((opts.write || allowed.length) && !opts.tools) throw new Error("--write and --run need --tools as well — they're the writing half of it");
  const c = await daemon(), p = await project(c);
  const result = await agentsRequest(c, `/api/projects/${encodeURIComponent(p.id)}/agents`, "POST", {
    ...(kind ? { kind } : {}), profile: opts.profile, count: Number(opts.count),
    ...(opts.as ? { id: opts.as } : {}), ...(opts.model ? { model: opts.model } : {}),
    ...(opts.role ? { role: opts.role } : {}), ...(opts.account ? { account: opts.account } : {}),
    options: { ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.tools ? { tools: true } : {}),
      ...(opts.write ? { write: true } : {}), ...(allowed.length ? { run: allowed } : {}),
      ...(opts.preset ? { preset: opts.preset } : {}), ...(opts.cmd ? { command: opts.cmd.trim().split(/\s+/) } : {}) },
  });
  console.log(JSON.stringify(result, null, 2));
}
