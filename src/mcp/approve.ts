#!/usr/bin/env node
/**
 * Loom's permission-prompt MCP server — one tool, `approve`.
 *
 * Claude Code runs this as a child (via `--mcp-config` +
 * `--permission-prompt-tool mcp__loom__approve`) and calls the tool whenever
 * a tool use needs permission. We forward the request to the Loom daemon,
 * which shows it to you as an approval in the thread, and block until you
 * answer (or the wait runs out, which denies — silence is not consent).
 *
 * Minimal MCP over stdio: newline-delimited JSON-RPC 2.0, the three methods a
 * client needs (initialize, tools/list, tools/call). No SDK dependency, so it
 * starts in milliseconds and ships inside dist/ as-is.
 */

import readline from "node:readline";

const URL_BASE = process.env.LOOM_APPROVAL_URL ?? "";
const SECRET = process.env.LOOM_APPROVAL_SECRET ?? "";
const PROJECT = process.env.LOOM_APPROVAL_PROJECT ?? "";
const AGENT = process.env.LOOM_APPROVAL_AGENT ?? "";
const WAIT_MS = 30 * 60_000;

type Json = Record<string, unknown>;

function send(msg: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

const TOOL = {
  name: "approve",
  description:
    "Ask the human, through Loom, whether a tool use may proceed. Returns a JSON decision " +
    '{"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}.',
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

async function decide(args: Json): Promise<Json> {
  const input = (args.input ?? {}) as Json;
  if (!URL_BASE || !SECRET) {
    return { behavior: "deny", message: "Loom's approval endpoint is not configured — denied." };
  }
  try {
    const res = await fetch(`${URL_BASE}/api/approvals/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-approval": SECRET },
      body: JSON.stringify({ project: PROJECT, agent: AGENT, tool: String(args.tool_name ?? "tool"), input }),
      signal: AbortSignal.timeout(WAIT_MS),
    });
    const body = (await res.json()) as Json;
    if (!res.ok) return { behavior: "deny", message: String(body.error ?? `approval failed (${res.status})`) };
    if (body.behavior === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: String(body.message ?? "Denied in Loom.") };
  } catch (err) {
    return { behavior: "deny", message: `No answer from Loom (${(err as Error).message}) — denied.` };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: Json;
  try {
    msg = JSON.parse(line) as Json;
  } catch {
    return;
  }
  const id = msg.id as number | string | undefined;
  const method = String(msg.method ?? "");
  if (method === "initialize") {
    const params = (msg.params ?? {}) as Json;
    send({
      id,
      result: {
        protocolVersion: String(params.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "loom", version: "1" },
      },
    });
  } else if (method === "tools/list") {
    send({ id, result: { tools: [TOOL] } });
  } else if (method === "tools/call") {
    const params = (msg.params ?? {}) as Json;
    if (params.name !== "approve") {
      send({ id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } });
      return;
    }
    void decide((params.arguments ?? {}) as Json).then((decision) =>
      send({ id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } }),
    );
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
  // notifications (no id) are acknowledged by silence
});
