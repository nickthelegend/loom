import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { DaemonClient } from "../daemon/client.js";
import { mcpRequest, rpcError } from "../core/mcp-server.js";
import { readDaemonConfig } from "../core/registry.js";

/** stdout is exclusively newline-delimited JSON-RPC. Never autostart or restart a daemon. */
export async function serveMcp(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const api = process.env.LOOM_MCP_API, token = process.env.LOOM_MCP_TOKEN;
  if (Boolean(api) !== Boolean(token)) throw new Error("LOOM_MCP_API and LOOM_MCP_TOKEN must be supplied together");
  const url = api ? new URL(api) : undefined;
  if (url && (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)) throw new Error("LOOM_MCP_API must be a daemon HTTP origin");
  const cfg = url ? { host: url.hostname, port: Number(url.port || 80), adminToken: token!, clients: [] } : readDaemonConfig();
  if (!cfg) throw new Error("No Loom daemon configured. Start it with loom daemon first.");
  const client = new DaemonClient(cfg);
  const instructions = token ? `Use project ${process.env.LOOM_PROJECT_ID ?? "from loom_projects"}.` +
    (process.env.LOOM_RUN_ID ? ` For loom_report use run ${process.env.LOOM_RUN_ID} and task ${process.env.LOOM_TASK_ID}.` : "") : undefined;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    const work = (async () => {
      let request: unknown;
      try { if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("request too large"); request = JSON.parse(line); }
      catch { output.write(JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n"); return; }
      const reply = await mcpRequest(client, request, instructions);
      if (reply) output.write(JSON.stringify(reply) + "\n");
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
}
