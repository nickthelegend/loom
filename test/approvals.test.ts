/**
 * "Always ask", end to end minus the model: an MCP client (standing in for
 * Claude Code) talks to Loom's approval server over stdio, the server files
 * the request with a real daemon, the request shows up in the project as an
 * `approval` event and in GET /approvals, a human answers over REST, and the
 * answer comes back through MCP as the decision Claude expects.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalEndpoint } from "../src/core/approvals.js";
import { permissionFor, permissionMenu } from "../src/core/permissions.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

let daemon: LoomDaemon;
let base: string;
let token: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-approvals");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { port } = await daemon.listen();
  base = `http://127.0.0.1:${port}`;
  const cfg = readDaemonConfig()!;
  token = cfg.adminToken;
  projectId = (await new DaemonClient(cfg).addProject(makeProjectDir({ name: "asky" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(base + p, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

/** A tiny MCP client over the approval server's stdio. */
function mcp(): { call: (method: string, params?: unknown) => Promise<Record<string, unknown>>; child: ChildProcess } {
  const ep = approvalEndpoint()!;
  const child = spawn(tsx, [path.join(root, "src", "mcp", "approve.ts")], {
    env: {
      ...process.env,
      LOOM_APPROVAL_URL: ep.url,
      LOOM_APPROVAL_SECRET: ep.secret,
      LOOM_APPROVAL_PROJECT: projectId,
      LOOM_APPROVAL_AGENT: "plannerbot",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    const msg = JSON.parse(line) as { id: number };
    waiting.get(msg.id)?.(msg as unknown as Record<string, unknown>);
  });
  let next = 1;
  return {
    child,
    call: (method, params) =>
      new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
  };
}

const decisionOf = (r: Record<string, unknown>) =>
  JSON.parse(((r.result as { content: Array<{ text: string }> }).content[0]!).text) as { behavior: string; message?: string };

describe("permission modes", () => {
  it("defaults each agent to today's behaviour and offers three modes", () => {
    expect(permissionFor("claude-code")).toBe("auto");
    expect(permissionFor("antigravity-cli")).toBe("bypass");
    expect(permissionFor("codex", { permissions: "ask" })).toBe("ask");
    expect(permissionFor("codex", { permissions: "nonsense" })).toBe("auto");
    expect(permissionMenu("claude-code")!.map((m) => m.mode)).toEqual(["bypass", "auto", "ask"]);
    expect(permissionMenu("claude-code")![2]!.ask).toBe("approvals");
    expect(permissionMenu("codex")![2]!.ask).toBe("read-only");
    expect(permissionMenu("echo")).toBeNull();
    // measured-broken cells are marked, and never selected
    expect(permissionMenu("opencode")![2]!.unsupported).toBeTruthy();
    expect(permissionMenu("antigravity-cli")![1]!.unsupported).toBeTruthy();
    expect(permissionFor("opencode", { permissions: "ask" })).toBe("auto");
  });

  it("sets an agent's mode, persists it, and shows it in status", async () => {
    const r = await api(`/api/projects/${projectId}/agents/execbot/permissions`, {
      method: "POST",
      body: JSON.stringify({ permissions: "ask" }),
    });
    expect(r.status).toBe(200);
    const bad = await api(`/api/projects/${projectId}/agents/execbot/permissions`, {
      method: "POST",
      body: JSON.stringify({ permissions: "yolo" }),
    });
    expect(bad.status).toBe(400);
    const st = await api(`/api/projects/${projectId}`);
    const agents = (st.body.project as { agents: Array<{ id: string; permissions: string }> }).agents;
    expect(agents.find((a) => a.id === "execbot")!.permissions).toBe("ask");
    const profiles = await api("/api/permissions");
    expect(Object.keys(profiles.body.profiles as object)).toContain("antigravity-cli");
  });
});

describe("approvals over MCP", () => {
  it("speaks MCP: initialize and list the approve tool", async () => {
    const c = mcp();
    const init = await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("loom");
    const tools = await c.call("tools/list");
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["approve"]);
    c.child.kill();
  });

  it("a request waits for a human, and allow flows back to the agent", async () => {
    const c = mcp();
    await c.call("initialize", {});
    const pending = c.call("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "npm test" } } });

    let approvalId = "";
    await waitUntil(async () => {
      const r = await api(`/api/projects/${projectId}/approvals`);
      const list = r.body.approvals as Array<{ id: string; tool: string; agent: string }>;
      if (list[0]) approvalId = list[0].id;
      return list.length === 1 && list[0]!.tool === "Bash" && list[0]!.agent === "plannerbot";
    });
    const ev = await api(`/api/projects/${projectId}/events?limit=50`);
    const requested = (ev.body.events as Array<{ kind: string; payload: { phase: string; input: string } }>).find(
      (e) => e.kind === "approval" && e.payload.phase === "requested",
    );
    expect(requested!.payload.input).toContain("npm test");

    expect((await api(`/api/projects/${projectId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision: "allow" }) })).status).toBe(200);
    expect(decisionOf(await pending)).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    // answered once is answered
    expect((await api(`/api/projects/${projectId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision: "deny" }) })).status).toBe(404);
    c.child.kill();
  });

  it("deny carries the human's reason back", async () => {
    const c = mcp();
    const pending = c.call("tools/call", { name: "approve", arguments: { tool_name: "Write", input: { file_path: "x" } } });
    let id = "";
    await waitUntil(async () => {
      const list = (await api(`/api/projects/${projectId}/approvals`)).body.approvals as Array<{ id: string }>;
      id = list[0]?.id ?? "";
      return Boolean(id);
    });
    await api(`/api/projects/${projectId}/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "deny", message: "not that file" }) });
    expect(decisionOf(await pending)).toEqual({ behavior: "deny", message: "not that file" });
    c.child.kill();
  });

  it("refuses requests without the daemon's approval secret", async () => {
    const r = await fetch(`${base}/api/approvals/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-approval": "wrong" },
      body: JSON.stringify({ project: projectId, tool: "Bash", input: {} }),
    });
    expect(r.status).toBe(403);
  });
});
