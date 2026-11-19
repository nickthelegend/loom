import type { Command } from "commander";
import type { DaemonClient } from "../daemon/client.js";
import { readDaemonConfig } from "../core/registry.js";
import { resolveCurrentProject } from "./common.js";

export function registerCostCommands(program: Command, ensureDaemon: () => Promise<DaemonClient>): void {
  const request = async (route: string, method = "GET", body?: unknown) => {
    const client = await ensureDaemon(), cfg = readDaemonConfig()!;
    const r = await fetch(client.baseUrl + route, { method, headers: { authorization: `Bearer ${cfg.adminToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text(); if (!r.ok) throw new Error(text);
    return r.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  };
  const base = async () => `/api/projects/${encodeURIComponent((await resolveCurrentProject(await ensureDaemon())).id)}`;
  const print = (v: unknown) => console.log(typeof v === "string" ? v.trimEnd() : JSON.stringify(v, null, 2));
  program.command("prices [action] [model]").option("--in <usd/M>").option("--out <usd/M>").option("--cache <usd/M>").action(async (action = "list", model, opts) => {
    const result = await request("/api/prices");
    if (action === "list") return print(result);
    if (!model || !["set", "rm"].includes(action)) throw new Error("use prices set <model> --in <usd/M> --out <usd/M> or prices rm <model>");
    const { modelKey } = await import("../core/prices.js"), key = modelKey(model);
    if (action === "rm") delete result.overrides[key];
    else result.overrides[key] = { in: Number(opts.in), out: Number(opts.out), ...(opts.cache === undefined ? {} : { cacheRead: Number(opts.cache) }) };
    print(await request("/api/prices", "PUT", { overrides: result.overrides }));
  });
  // Extend the existing command without changing its default output or --series contract.
  const costs = program.commands.find(c => c.name() === "costs")!;
  costs.option("--by <group>", "agent, model, chat or day").option("--since <date>").option("--csv").option("--json").option("--cache");
  costs.hook("preAction", async (_command, action) => {
    const o = action.opts();
    if (!o.by && !o.since && !o.csv && !o.json && !o.cache) return;
    if (o.csv && o.json) throw new Error("choose --csv or --json");
    const q = new URLSearchParams({ by: o.cache ? "model" : o.by ?? "agent", format: o.csv ? "csv" : "json", ...(o.since ? { since: o.since } : {}) });
    const result = await request(await base() + "/costs/export?" + q);
    print(o.cache && !o.csv ? { ...result, rows: result.rows.map((r: Record<string, unknown>) => ({ model: r.model, tokensIn: r.tokensIn, cachedIn: r.cachedIn, cacheShare: r.cacheShare, cacheSavedUsd: r.cacheSavedUsd })) } : result);
    // Commander invokes the existing action after hooks; install a no-op for this invocation only.
    action.action(() => {});
  });
  program.command("chat:budget <chat> <usd>").action(async (chat, usd) => print(await request(await base() + `/chats/${encodeURIComponent(chat)}/budget`, "PUT", { usd: Number(usd) })));
  program.command("budget:month <usd>").action(async usd => print(await request(await base() + "/costs/settings", "PUT", { monthlyUsd: Number(usd) })));
  program.command("budget:alerts [channels]").description("comma-separated slack,discord,email,push; none disables").action(async channels => print(await request(await base() + "/costs/settings", channels === undefined ? "GET" : "PUT", channels === undefined ? undefined : { alerts: channels === "none" ? [] : channels.split(",") })));
  program.command("budget:saver [alias]").option("--share <fraction>", "share of cap", "0.8").option("--period <period>", "day or month", "month").option("--daily <usd>").action(async (alias, o) => print(await request(await base() + "/costs/settings", alias ? "PUT" : "GET", alias ? { saver: alias === "off" ? null : { alias, share: Number(o.share), period: o.period }, ...(o.daily === undefined ? {} : { dailyUsd: Number(o.daily) }) } : undefined)));
  program.command("costs:whatif").requiredOption("--model <id>").option("--chat <chat>").option("--since <date>").action(async o => print(await request(await base() + "/costs/whatif?" + new URLSearchParams(o))));
  program.command("models:compare <models...>").action(async models => print(await request("/api/models/compare?" + new URLSearchParams({ models: models.join(",") }))));
  program.command("fleets:suggest <goal>").option("--budget <usd>").option("--size <n>").action(async (goal, o) => print(await request("/api/fleets/suggest", "POST", { goal, ...(o.budget === undefined ? {} : { budget: Number(o.budget) }), ...(o.size === undefined ? {} : { size: Number(o.size) }) })));
}
