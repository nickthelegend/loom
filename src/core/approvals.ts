/**
 * Approvals — "always ask", made real for agents that can route a permission
 * prompt to a tool.
 *
 * A headless agent has no TTY to ask on. Claude Code can hand each permission
 * prompt to an MCP tool instead (`--permission-prompt-tool`), so Loom ships a
 * tiny MCP server (src/mcp/approve.ts) whose one tool forwards the request to
 * the daemon and waits. The daemon shows it in the thread; you allow or deny;
 * the answer flows back and the agent carries on or stops.
 *
 * This module is the shared seam: where the daemon's approval endpoint lives
 * (set once the daemon listens), and the MCP config an adapter hands its CLI.
 * The endpoint is guarded by a per-daemon secret rather than a client token —
 * the MCP child only ever needs to file requests, never to read the project.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ApprovalEndpoint {
  url: string; // http://127.0.0.1:<port>
  secret: string;
}

let endpoint: ApprovalEndpoint | null = null;

export function setApprovalEndpoint(url: string): ApprovalEndpoint {
  endpoint = { url, secret: endpoint?.secret ?? crypto.randomBytes(24).toString("hex") };
  return endpoint;
}

export function approvalEndpoint(): ApprovalEndpoint | null {
  return endpoint;
}

/** Where the compiled MCP approval server lives (dist/mcp/approve.js). */
export function approveServerPath(): string {
  return fileURLToPath(new URL("../mcp/approve.js", import.meta.url));
}

/**
 * Write an MCP config naming Loom's approval server, for one agent. Returns
 * null when there is no daemon to ask (a bare adapter in a script or test) —
 * the caller then falls back to the read-only behaviour rather than a turn
 * whose every tool call waits forever on nobody.
 */
export function writeApprovalMcpConfig(ctx: { project: string; agent: string }): string | null {
  const ep = approvalEndpoint();
  const server = approveServerPath();
  if (!ep || !fs.existsSync(server)) return null;
  const file = path.join(os.tmpdir(), `loom-approve-${crypto.randomBytes(6).toString("hex")}.json`);
  const cfg = {
    mcpServers: {
      loom: {
        command: process.execPath,
        args: [server],
        env: {
          LOOM_APPROVAL_URL: ep.url,
          LOOM_APPROVAL_SECRET: ep.secret,
          LOOM_APPROVAL_PROJECT: ctx.project,
          LOOM_APPROVAL_AGENT: ctx.agent,
        },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  return file;
}

export interface ApprovalDecision {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// ---------------------------------------------------------------------------
// Asking from inside the daemon
// ---------------------------------------------------------------------------
//
// The MCP path above exists because a CLI agent is a separate process: it has
// to reach the daemon over HTTP to ask anything. A model agent
// (adapters/model.ts) runs INSIDE the daemon, so it needs the same question
// answered by the same person in the same place — without the round trip.
//
// The daemon registers a broker when it starts listening. Until it does, and
// in a bare adapter with no daemon at all (a script, a test), there is nobody
// to ask — and the answer to "may I write this file" with nobody to ask is
// no. A tool that silently proceeds because the UI wasn't wired up would be
// the worst failure mode this file could have.

export interface ApprovalRequest {
  project: string;
  agent: string;
  tool: string;
  input: unknown;
  /** Shown in the card instead of raw JSON, when the tool can say it better. */
  summary?: string;
}

export type ApprovalBroker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

let broker: ApprovalBroker | null = null;

export function setApprovalBroker(fn: ApprovalBroker | null): void {
  broker = fn;
}

export function hasApprovalBroker(): boolean {
  return broker !== null;
}

/** Ask the human. Denies when there is no human to ask. */
export async function requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
  if (!broker) {
    return { behavior: "deny", message: "there's nobody to ask — no daemon is running this project" };
  }
  try {
    return await broker(req);
  } catch (err) {
    return { behavior: "deny", message: `the approval didn't complete: ${String((err as Error).message)}` };
  }
}
