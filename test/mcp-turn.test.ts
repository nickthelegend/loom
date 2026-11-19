import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { expect, it } from "vitest";
import { loomToolScope, writeLoomMcpSession } from "../src/core/loom-tools.js";
import { tmpDir, waitUntil } from "./helpers.js";

it("forwards the turn credential, drains requests at EOF and rejects it after revocation", async () => {
  const received: Array<{ path: string; accept: string | undefined; body: any }> = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const scope = loomToolScope(req.headers.authorization?.replace(/^Bearer /, ""));
    if (!scope) { res.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    received.push({ path: req.url!, accept: req.headers.accept, body: request });
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    // Deliberately finish responses out of order, including after stdin closes.
    if (request.method === "resources/list") await new Promise(resolve => setTimeout(resolve, 50));
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
      ? { capabilities: { tools: {}, resources: {}, prompts: {} } }
      : { project: scope.project, method: request.method, params: request.params } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const session = writeLoomMcpSession([], { project: "p", api: `http://127.0.0.1:${address.port}`, agent: "worker", chat: "main", run: "r", task: "t" })!;
  const entry = session.servers.find(s => s.key === "loom")!.entry as { command: string; args: string[]; env: Record<string, string> };
  const child = spawn(entry.command, entry.args, { cwd: tmpDir("mcp-turn-cwd"), env: { ...process.env, ...entry.env }, stdio: "pipe" });
  const closed = once(child, "close");
  const replies: any[] = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => replies.push(JSON.parse(line)));
  const send = (id: number | undefined, method: string, params?: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    send(0, "initialize");
    send(undefined, "notifications/initialized");
    send(1, "tools/call", { name: "loom_projects", arguments: {} });
    send(2, "resources/list");
    send(3, "prompts/list");
    child.stdin.write("not json\n");
    await waitUntil(() => replies.length === 5);
    expect(replies.find(r => r.id === 0).result).toEqual({ capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: "Use project p. For loom_report use run r and task t." });
    expect(replies.find(r => r.id === 1).result).toEqual({ project: "p", method: "tools/call", params: { name: "loom_projects", arguments: {} } });
    expect(replies.find(r => r.id === null).error.code).toBe(-32700);
    expect(received).toHaveLength(5);
    expect(received.every(r => r.path === "/mcp" && r.accept === "application/json, text/event-stream")).toBe(true);

    session.cleanup();
    send(4, "tools/call", { name: "loom_projects", arguments: {} });
    send(undefined, "notifications/initialized");
    child.stdin.end();
    expect((await closed)[0], stderr).toBe(0);
    expect(replies).toHaveLength(6);
    expect(replies.find(r => r.id === 4)).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32603, message: "unauthorized" } });
    expect(received).toHaveLength(5);
  } finally {
    session.cleanup();
    child.kill();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
