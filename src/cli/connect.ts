import { spawn } from "../core/process.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const agents = ["claude", "codex", "opencode", "grok"] as const;
export function connectCommand(agent: string): { command: string; args: string[]; note?: string } {
  const name = agent === "claude-code" ? "claude" : agent === "grok-code" ? "grok" : agent;
  if (!agents.includes(name as typeof agents[number])) throw new Error(`unknown agent: ${agent}; choose ${agents.join(", ")}`);
  // OpenCode's `mcp add` takes only a name and asks for the rest (checked against opencode 1.17).
  if (name === "opencode") return { command: name, args: ["mcp", "add", "loom"], note: "OpenCode asks next: choose a local server and enter the command: loom mcp-server" };
  return { command: name, args: ["mcp", "add", "loom", "--", "loom", "mcp-server"] };
}

export async function connectAgent(agent: string, dryRun = false): Promise<void> {
  const { command, args, note } = connectCommand(agent);
  console.log([command, ...args].join(" "));
  if (note) console.log(note);
  if (dryRun) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} mcp add exited ${code}`)));
  });
}

/** Ask the CLI so manually registered servers are included, without parsing private config formats. */
export async function listConnections(dryRun = false): Promise<void> {
  for (const agent of agents) {
    if (dryRun) { console.log(`${agent} mcp list`); continue; }
    try {
      const { stdout } = await promisify(execFile)(agent, ["mcp", "list"], { timeout: 15_000 });
      const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
      console.log(`${agent}: ${/\bloom\b/i.test(plain) ? "registered" : "not registered"}`);
    } catch { console.log(`${agent}: unavailable (CLI missing or mcp list failed)`); }
  }
}
