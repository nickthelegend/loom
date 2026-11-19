import fs from "node:fs";
import type { Command } from "commander";
import { DaemonClient, DaemonError, ensureDaemon } from "../daemon/client.js";
import { resolveCurrentProject } from "./common.js";
import { lintSkill } from "../core/agentic-r4/skills.js";
import { waitForTarget } from "../core/agentic-r4/wait.js";

export function apiPath(route: string, project?: string) {
  if (!route.startsWith("/") || route.startsWith("//") || /[\\#]/.test(route)) throw new Error("path must be a daemon API path");
  const result = project ? `/api/projects/${encodeURIComponent(project)}${route}` : route;
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(decodeURIComponent(result.split("?")[0]!))) throw new Error("invalid API path");
  return result;
}
export function apiData(data?: string): unknown {
  if (data === undefined) return undefined;
  const parsed: unknown = JSON.parse(data.startsWith("@") ? fs.readFileSync(data.slice(1), "utf8") : data);
  return parsed;
}
const client = () => ensureDaemon();
const print = (value: unknown) => console.log(JSON.stringify(value));
async function project(c: DaemonClient, name?: string) { return name ? (await c.project(name)).project.id : (await resolveCurrentProject(c)).id; }

export function registerAgenticCli(program: Command) {
  program.command("api <method> <path>").description("call an authenticated daemon API; --project prefixes a project-relative path")
    .option("--data <json|@file>").option("--project <project>")
    .action(async (method: string, route: string, opts: { data?: string; project?: string }) => {
      method = method.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) throw new Error("unsupported HTTP method");
      const c = await client();
      try { print(await c.api(method, apiPath(route, opts.project), apiData(opts.data))); }
      catch (error) { if (error instanceof DaemonError) { print(error.body); process.exitCode = 1; } else throw error; }
    });
  program.command("mcp:log").description("show who called project Loom tools").option("--project <project>").option("--limit <count>", "last calls", "100")
    .action(async (opts: { project?: string; limit: string }) => { const c = await client(); print(await c.api("GET", `/api/projects/${encodeURIComponent(await project(c, opts.project))}/r4/log?limit=${encodeURIComponent(opts.limit)}`)); });
  const hooks = program.command("hooks").description("manage executable project hooks (off until enabled by owner)");
  for (const action of ["list", "enable", "disable", "test"]) {
    const cmd = hooks.command(action).option("--project <project>");
    if (action === "test") cmd.argument("<event>");
    cmd.action(async (...args: unknown[]) => {
      const opts = args[action === "test" ? 1 : 0] as { project?: string };
      const c = await client(), p = await project(c, opts.project), base = `/api/projects/${encodeURIComponent(p)}/r4/hooks`;
      const result = await c.api<{ code?: number; timedOut?: boolean }>(action === "list" ? "GET" : action === "test" ? "POST" : "PUT", base + (action === "test" ? "/test" : ""), action === "list" ? undefined : action === "test" ? { event: args[0] } : { enabled: action === "enable" });
      print(result);
      if (action === "test" && result.code !== 0) process.exitCode = result.timedOut ? 124 : 1;
    });
  }
  program.command("skill:from-chat <chat> <name>").description("draft an editable, disabled SKILL.md from a finished chat").option("--project <project>")
    .action(async (chat: string, name: string, opts: { project?: string }) => { const c = await client(); print(await c.api("POST", `/api/projects/${encodeURIComponent(await project(c, opts.project))}/r4/skills/from-chat`, { chat, name })); });
  program.command("skill:lint <dir>").description("check SKILL.md front matter").action((dir: string) => { const result = lintSkill(dir); print(result); if (!result.valid) process.exitCode = 1; });
  program.command("wait <chat|run>").description("wait until a chat is idle or a run finishes; exit 0 success, 1 failure, 2 needs you, 124 timeout")
    .option("--project <project>").option("--timeout <seconds>", "maximum wait", "300").option("--json")
    .action(async (target: string, opts: { project?: string; timeout: string; json?: boolean }) => {
      try {
        const c = await client(), result = await waitForTarget(c, await project(c, opts.project), target, Number(opts.timeout) * 1000);
        if (opts.json) print(result); else console.log(`${result.kind} ${result.target}: ${result.status}`);
        process.exitCode = result.exitCode;
      } catch (error) {
        if (!opts.json) throw error;
        print({ target, status: "error", error: error instanceof Error ? error.message : String(error), exitCode: 1, timedOut: false });
        process.exitCode = 1;
      }
    });
}
