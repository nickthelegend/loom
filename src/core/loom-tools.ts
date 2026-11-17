/** Credentials exist only while an agent turn is alive; they never enter daemon.json. */
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { McpServerConfig } from "../types.js";
import { writeMcpSession, type McpSession } from "./mcp.js";

export interface LoomToolScope { project: string; api: string; run?: string; task?: string }
const credentials = new Map<string, LoomToolScope>();
export function loomToolScope(token: string | undefined): LoomToolScope | undefined {
  return token ? credentials.get(token) : undefined;
}

/** Stdio carries credentials across every MCP-capable adapter, including those without HTTP headers. */
export function writeLoomMcpSession(mcps: McpServerConfig[] | undefined, scope?: LoomToolScope): McpSession | null {
  if (!scope) return writeMcpSession(mcps);
  if (!scope.api) throw new Error("Loom tools require a listening daemon");
  const token = randomBytes(32).toString("hex");
  credentials.set(token, scope);
  try {
    const session = writeMcpSession([
      { name: "loom", url: "", command: process.execPath,
        args: import.meta.url.endsWith(".ts")
          ? ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../cli/index.ts", import.meta.url)), "mcp-server"]
          : [fileURLToPath(new URL("../cli/index.js", import.meta.url)), "mcp-server"],
        env: { LOOM_MCP_API: scope.api, LOOM_MCP_TOKEN: token, LOOM_PROJECT_ID: scope.project,
          ...(scope.run ? { LOOM_RUN_ID: scope.run } : {}), ...(scope.task ? { LOOM_TASK_ID: scope.task } : {}) } },
      ...(mcps ?? []),
    ])!;
    const cleanup = session.cleanup;
    session.cleanup = () => { credentials.delete(token); cleanup(); };
    return session;
  } catch (error) {
    credentials.delete(token);
    throw error;
  }
}
