/**
 * Ask the Observatory — a question about this fleet, answered from its own
 * telemetry.
 *
 * The shape is the one that makes an observability assistant worth having: a
 * model that can go and query traces, metrics and logs itself rather than being
 * handed a pre-chewed summary and asked to sound confident about it. So when the
 * project has MCP servers configured (see src/core/mcp.ts) they are passed to
 * the CLI for the turn — if one of them fronts the telemetry store, the model
 * can call it directly. None of that is required: with no MCP server at all the
 * evidence block below is still real, and the answer is still grounded.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not require its own API key. The project already drives real
 *     coding CLIs headlessly, so the cheapest available one answers. On a
 *     machine with none, the endpoint says so instead of returning a
 *     plausible-sounding paragraph assembled locally.
 *   - It does not invent telemetry. The context block below is rendered from
 *     the same numbers the Observatory renders; if the telemetry backend is
 *     unreachable the prompt says the spans came from the local event log, so
 *     the answer can be honest about its own evidence rather than implying a
 *     trace backend that isn't running.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnv } from "../adapters/base.js";

/** Everything the model is told about the fleet, all of it measured. */
export interface AskContext {
  projectName: string;
  spendUsd: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  holder: string | null;
  agents: Array<{ id: string; kind: string; role?: string; turns?: number; usd?: number; health?: number | null; busy?: boolean }>;
  /** Recent turns/handoffs, newest last. */
  recentSpans: Array<{ ts: number; agent?: string; name?: string; ms?: number; code?: number; model?: string; msg?: string }>;
  decisions: Array<{ agentId: string; title: string; category?: string; confidence?: number; source?: string }>;
  /** "backend" when the spans came from ClickHouse, "local-log" when it is down. */
  spanSource: string;
}

export interface AskResult {
  answer: string;
  /** Which CLI and model actually answered. */
  via: string;
  /** MCP servers handed to the model for this question, if any. */
  mcpServers: string[];
  /** True when no CLI was available to answer at all. */
  unavailable?: boolean;
}

/** Where the headless CLIs live; the daemon's PATH may predate their install. */
function firstBin(candidates: Array<{ bin: string; args: (q: string) => string[]; label: string }>): typeof candidates[number] | null {
  for (const c of candidates) {
    if (c.bin.includes("/")) {
      if (fs.existsSync(c.bin)) return c;
    } else {
      // Resolve against PATH the cheap way: `which` is a process too, and this
      // sits in front of an HTTP handler.
      const dirs = (process.env.PATH ?? "").split(path.delimiter);
      if (dirs.some((d) => d && fs.existsSync(path.join(d, c.bin)))) return c;
    }
  }
  return null;
}

/**
 * Render the fleet's real state as the evidence block the model reasons over.
 *
 * Kept as plain prose and small tables rather than raw JSON: the question is
 * asked in English and the answer is read in English, and a model handed 40kB
 * of span JSON spends its attention parsing rather than answering.
 */
export function renderAskContext(c: AskContext): string {
  const L: string[] = [];
  L.push(`# Fleet: ${c.projectName}`);
  L.push(`Baton: ${c.holder ?? "nobody"} · ${c.turns} turns completed · $${c.spendUsd.toFixed(4)} spent · ${c.tokensIn} tokens in, ${c.tokensOut} out`);
  L.push("");
  L.push("## Agents");
  for (const a of c.agents) {
    const bits = [`${a.id} (${a.kind}${a.role && a.role !== a.id ? `, role ${a.role}` : ""})`];
    if (a.turns != null) bits.push(`${a.turns} turns`);
    if (a.usd != null) bits.push(`$${a.usd.toFixed(4)}`);
    if (a.health != null) bits.push(`health ${a.health}/100`);
    if (a.busy) bits.push("RUNNING NOW");
    L.push(`- ${bits.join(" · ")}`);
  }
  if (c.decisions.length) {
    L.push("");
    L.push("## Decisions recorded");
    for (const d of c.decisions.slice(-12)) {
      L.push(`- [${d.category ?? "decision"}] ${d.agentId}: ${d.title}` +
        (d.confidence != null ? ` (confidence ${d.confidence}%, ${d.source ?? "source unknown"})` : ` (confidence not measured, ${d.source ?? "source unknown"})`));
    }
  }
  if (c.recentSpans.length) {
    L.push("");
    L.push(`## Recent activity (${c.spanSource === "backend" ? "from exported spans" : "from the local event log — the telemetry backend is not reachable, so there are no trace ids"})`);
    for (const s of c.recentSpans.slice(-25)) {
      const when = new Date(s.ts).toISOString().slice(11, 19);
      const parts = [when, s.name ?? "?", s.agent ?? ""];
      if (s.model) parts.push(s.model);
      if (s.ms != null) parts.push(`${s.ms}ms`);
      if (s.code === 2) parts.push("ERROR");
      if (s.msg) parts.push(s.msg.slice(0, 80));
      L.push(`- ${parts.filter(Boolean).join(" · ")}`);
    }
  }
  return L.join("\n");
}

const SYSTEM = [
  "You are Ask, the observability assistant inside Loom's Observatory.",
  "You answer questions about THIS agent fleet using the evidence below, and any",
  "telemetry MCP tools you have been given — prefer calling those tools for",
  "anything the evidence block does not already contain.",
  "",
  "Rules:",
  "- Answer in at most 8 short lines. Lead with the answer, not a preamble.",
  "- Cite the concrete numbers you used. Never invent a metric that is not in the",
  "  evidence or returned by a tool; if something cannot be determined, say which",
  "  data would be needed.",
  "- If the evidence says the telemetry backend is unreachable, do not imply you",
  "  queried traces.",
  "- Plain text. No markdown headers, no bullet characters other than '-'.",
].join("\n");

/**
 * Put the question to whichever headless CLI this machine has, cheapest first.
 *
 * `agy` leads because a fleet question is a reading task, not a coding one, and
 * a flash-tier model answers it for a fraction of the orchestrator's budget —
 * which is the same reason the Antigravity adapter exists.
 */
export async function ask(
  question: string,
  ctx: AskContext,
  opts: { cwd: string; mcpConfigPath?: string; mcpServers?: string[]; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<AskResult> {
  const prompt = `${SYSTEM}\n\n===== EVIDENCE =====\n${renderAskContext(ctx)}\n===== END EVIDENCE =====\n\nQuestion: ${question}`;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const agy = path.join(os.homedir(), ".local", "bin", "agy");

  const chosen = firstBin([
    {
      bin: fs.existsSync(agy) ? agy : "agy",
      label: "agy · gemini-3.6-flash-high",
      args: (q) => {
        const a = ["--print", q, "--dangerously-skip-permissions", "--model", "gemini-3.6-flash-high",
          "--print-timeout", `${Math.round(timeoutMs / 1000)}s`, "--add-dir", opts.cwd];
        return a;
      },
    },
    {
      bin: "claude",
      label: "claude",
      args: (q) => {
        const a = ["-p", q, "--output-format", "text"];
        // Only claude takes the MCP document directly; see src/core/mcp.ts.
        if (opts.mcpConfigPath) a.push("--mcp-config", opts.mcpConfigPath);
        return a;
      },
    },
  ]);

  if (!chosen) {
    return {
      answer: "No local model is available to answer. Install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash) or Claude Code, sign in once, and ask again.",
      via: "none",
      mcpServers: [],
      unavailable: true,
    };
  }

  const out = await new Promise<{ text: string; err: string; code: number | null }>((resolve) => {
    const child = spawn(chosen.bin, chosen.args(prompt), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: agentEnv() });
    let text = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs + 5_000);
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => { text += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    child.on("error", () => { clearTimeout(timer); resolve({ text: "", err: "failed to start", code: null }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ text, err, code }); });
  });

  const answer = out.text.trim();
  if (!answer) {
    return {
      answer: `The model didn't answer${out.err ? ` — ${out.err.trim().slice(0, 200)}` : ""}. It may need signing in once from a terminal.`,
      via: chosen.label,
      mcpServers: opts.mcpServers ?? [],
      unavailable: true,
    };
  }
  return { answer, via: chosen.label, mcpServers: opts.mcpServers ?? [] };
}
