/**
 * MCP servers, end to end: what gets into the generated config, what the CLIs
 * are actually told, and whether "connected" means anything.
 *
 * The claim under test is the one that was false before: a project's configured
 * MCP servers reach the agent. So the adapters are driven with fake binaries
 * that record their argv — the same instrument the adapter tests use — because
 * the question is what Loom PUTS on the command line, and a real CLI would
 * only answer it slowly and at a price.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { codexMcpArgs, mcpKey, probeMcpServer, resolveMcpServers, writeMcpSession } from "../src/core/mcp.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import type { McpServerConfig, McpTurnConfig } from "../src/types.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

/**
 * A stand-in CLI that records its argv, snapshots any --mcp-config file it was
 * handed, and exits cleanly.
 *
 * The snapshot is the point: the config lives for exactly one turn and is
 * deleted afterwards, so the only honest place to read it is from inside the
 * process that was given it — which is also the only place that proves the file
 * was really there when the CLI ran.
 */
function fakeBin(name: string, stdout: string[] = []): string {
  const dir = tmpDir(`fake-${name}`);
  const bin = path.join(dir, name);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(argv));
const i = argv.indexOf("--mcp-config");
if (i >= 0 && argv[i + 1]) fs.copyFileSync(argv[i + 1], ${JSON.stringify(path.join(dir, "mcp-seen.json"))});
${stdout.map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}
`,
    { mode: 0o755 },
  );
  return bin;
}

const argvOf = (bin: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "argv.json"), "utf8")) as string[];

/** The MCP document the fake CLI actually received, as it saw it. */
const mcpSeenBy = (bin: string): { mcpServers: Record<string, unknown> } =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "mcp-seen.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };

/** The stream-json a fake `claude` needs to print for a turn to complete. */
const CLAUDE_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
  JSON.stringify({ type: "result", total_cost_usd: 0 }),
];
/** …and the JSONL a fake `codex` needs. */
const CODEX_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "ok" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
];

const CONFIGURED: McpServerConfig[] = [
  { name: "SigNoz", url: "http://127.0.0.1:8080/mcp", description: "traces" },
  { name: "GitHub", url: "", description: "not connected yet" }, // a built-in suggestion row
  { name: "Slack", url: "https://slack.example/mcp", enabledForSession: false },
  { name: "Local Files", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
];

const sessions: Array<{ cleanup: () => void }> = [];
afterAll(() => sessions.forEach((s) => s.cleanup()));

describe("selecting servers", () => {
  it("takes the ones with somewhere to connect to, and leaves the placeholders out", () => {
    const names = resolveMcpServers(CONFIGURED).map((s) => s.name);
    expect(names).toContain("SigNoz");
    expect(names).toContain("Local Files"); // a command is a destination too
    // An empty url is the built-in suggestion row: a name and an icon, nothing
    // to talk to. Handing it to a CLI would advertise a tool that isn't there.
    expect(names).not.toContain("GitHub");
    // Switched off for the session is switched off.
    expect(names).not.toContain("Slack");
  });

  it("keys servers safely for a TOML dotted path", () => {
    expect(mcpKey("Local Files")).toBe("local_files");
    expect(mcpKey("My Server / prod")).toBe("my_server_prod");
    expect(mcpKey("!!!")).toBe("server");
  });

  it("reads an /sse endpoint as SSE and everything else as http", () => {
    const [http1, sse] = resolveMcpServers([
      { name: "a", url: "https://x.example/mcp" },
      { name: "b", url: "https://x.example/sse" },
    ]);
    expect(http1!.entry).toMatchObject({ type: "http" });
    expect(sse!.entry).toMatchObject({ type: "sse" });
  });
});

describe("the generated config file", () => {
  it("writes the standard {mcpServers} document with only the real servers in it", () => {
    const session = writeMcpSession(CONFIGURED)!;
    sessions.push(session);
    expect(session).not.toBeNull();
    const doc = JSON.parse(fs.readFileSync(session.configPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["local_files", "signoz"]);
    expect(doc.mcpServers.signoz).toEqual({ type: "http", url: "http://127.0.0.1:8080/mcp" });
    expect(doc.mcpServers.local_files).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    expect(doc.mcpServers.github).toBeUndefined();
  });

  /**
   * null, not an empty document. With `--strict-mcp-config` an empty file would
   * SUPPRESS the servers the user configured in their own CLI, so "nothing to
   * add" has to be distinguishable from "add nothing".
   */
  it("returns null when nothing is configured", () => {
    expect(writeMcpSession([])).toBeNull();
    expect(writeMcpSession(undefined)).toBeNull();
    expect(writeMcpSession([{ name: "GitHub", url: "" }])).toBeNull();
  });

  it("cleans up after itself", () => {
    const session = writeMcpSession(CONFIGURED)!;
    expect(fs.existsSync(session.configPath)).toBe(true);
    session.cleanup();
    expect(fs.existsSync(session.configPath)).toBe(false);
    expect(() => session.cleanup()).not.toThrow(); // idempotent
  });
});

describe("codex config overrides", () => {
  it("renders one -c mcp_servers.<key>=<toml> per server", () => {
    const args = codexMcpArgs(resolveMcpServers(CONFIGURED));
    expect(args).toEqual([
      "-c", 'mcp_servers.signoz={url="http://127.0.0.1:8080/mcp"}',
      "-c", 'mcp_servers.local_files={command="npx",args=["-y","@modelcontextprotocol/server-filesystem","/tmp"]}',
    ]);
  });

  it("escapes quotes and backslashes so a URL can't break out of the TOML", () => {
    const args = codexMcpArgs(resolveMcpServers([{ name: "x", url: 'https://e.example/a"b\\c' }]));
    expect(args[1]).toBe('mcp_servers.x={url="https://e.example/a\\"b\\\\c"}');
  });
});

describe("what the adapters put on the command line", () => {
  const mcpFor = (mcps: McpServerConfig[]): McpTurnConfig => {
    const session = writeMcpSession(mcps)!;
    sessions.push(session);
    return { configPath: session.configPath, servers: session.servers };
  };

  it("claude-code passes --mcp-config when there are servers", async () => {
    const bin = fakeBin("claude", CLAUDE_STREAM);
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "mcp" }), { bin });
    const mcp = mcpFor(CONFIGURED);
    await agent.send({ text: "go", mcp });
    const argv = argvOf(bin);
    expect(argv).toContain("--mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(mcp.configPath);
  });

  it("claude-code passes no MCP flag when the project has none", async () => {
    const bin = fakeBin("claude", CLAUDE_STREAM);
    const agent = new ClaudeCodeAdapter("claude-code", makeProjectDir({ name: "mcp" }), { bin });
    await agent.send({ text: "go" });
    expect(argvOf(bin)).not.toContain("--mcp-config");
  });

  it("codex passes -c mcp_servers overrides when there are servers", async () => {
    const bin = fakeBin("codex", CODEX_STREAM);
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "mcp" }), { bin });
    await agent.send({ text: "go", mcp: mcpFor(CONFIGURED) });
    const argv = argvOf(bin);
    expect(argv).toContain('mcp_servers.signoz={url="http://127.0.0.1:8080/mcp"}');
    // and the prompt is still the last argument, where codex exec wants it
    expect(argv[argv.length - 1]).toBe("go");
  });

  it("codex passes no overrides when the project has none", async () => {
    const bin = fakeBin("codex", CODEX_STREAM);
    const agent = new CodexAdapter("codex", makeProjectDir({ name: "mcp" }), { bin });
    await agent.send({ text: "go" });
    expect(argvOf(bin).some((a) => a.startsWith("mcp_servers."))).toBe(false);
  });
});

describe("through the runtime", () => {
  /**
   * The whole point: a server typed into the composer reaches the CLI. This
   * drives the real dispatch path — config → session → adapter → argv — with a
   * fake `claude` standing in for the one that costs money.
   */
  it("hands a configured server to an adapter whose CLI takes one", async () => {
    const bin = fakeBin("claude", CLAUDE_STREAM);
    const dir = makeProjectDir({
      name: "wired",
      agents: [{ id: "cc", kind: "claude-code", role: "builder", options: { bin } }],
      mcps: [{ name: "SigNoz", url: "http://127.0.0.1:8080/mcp" }],
    });
    const rt = await ProjectRuntime.open({ id: "wired", name: "wired", dir });
    try {
      await rt.sendMessage("go", "cc");
      await waitUntil(() => fs.existsSync(path.join(path.dirname(bin), "argv.json")));
      await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length > 0);
      expect(argvOf(bin)).toContain("--mcp-config");
      expect(mcpSeenBy(bin).mcpServers.signoz).toEqual({ type: "http", url: "http://127.0.0.1:8080/mcp" });
      // The config was a temp file for that turn and nothing else: it's gone.
      const argv = argvOf(bin);
      expect(fs.existsSync(argv[argv.indexOf("--mcp-config") + 1]!)).toBe(false);
      // …and it's announced in the thread, so "which servers did that turn get"
      // is answerable after the fact rather than a claim on a settings screen.
      const attached = rt.log.list({ kinds: ["status"] }).find((e) => e.payload.state === "mcp_attached");
      expect(attached!.payload.servers).toEqual(["SigNoz"]);
    } finally {
      await rt.close();
    }
  });

  /**
   * An adapter whose CLI has no MCP flag must not be told it got servers.
   * Announcing an attachment that the adapter drops on the floor is the same
   * lie in a new place.
   */
  it("says nothing about MCP for an adapter whose CLI has no flag for it", async () => {
    const dir = makeProjectDir({
      name: "unwired",
      agents: [{ id: "echobot", kind: "echo", role: "builder" }],
      mcps: [{ name: "SigNoz", url: "http://127.0.0.1:8080/mcp" }],
    });
    const rt = await ProjectRuntime.open({ id: "unwired", name: "unwired", dir });
    try {
      await rt.sendMessage("go", "echobot");
      await waitUntil(() => rt.log.list({ kinds: ["run_complete"] }).length > 0);
      expect(rt.log.list({ kinds: ["status"] }).some((e) => e.payload.state === "mcp_attached")).toBe(false);
    } finally {
      await rt.close();
    }
  });
});

describe("reachability", () => {
  it("reports a server that answers as reachable, and one that refuses as not", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probeMcpServer(`http://127.0.0.1:${port}/mcp`)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // Same URL, nothing listening now: connection refused is not connected.
    expect(await probeMcpServer(`http://127.0.0.1:${port}/mcp`, 1_000)).toBe(false);
  });

  /**
   * A 405 is a server saying "not that method", which is still a server. The
   * probe measures whether something is there, not whether it likes HEAD.
   */
  it("counts an error status as reachable", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 405;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await probeMcpServer(`http://127.0.0.1:${port}/mcp`)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("never calls a row with no url reachable", async () => {
    expect(await probeMcpServer("")).toBe(false);
    expect(await probeMcpServer("not a url")).toBe(false);
  });
});
