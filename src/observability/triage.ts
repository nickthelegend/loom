/**
 * Agent self-triage — "why did I fail?"
 *
 * Agent-native observability: an agent (or you, on its behalf) reads its OWN
 * OpenTelemetry traces back out of the telemetry backend and gets a root cause.
 * We query the agent's recent spans from ClickHouse (the backend's store),
 * derive a deterministic root cause + fix from them, and — when Claude is
 * reachable (an Anthropic key, or the `claude` CLI you're already signed into) —
 * have Claude phrase it. The local event log is a fallback source so triage
 * still works if the backend is down.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import type { LoomEvent } from "../types.js";
import { SERVICE_NAME, SPAN_TABLE, chLiteral, chQuery } from "./clickhouse.js";

/**
 * The `claude` CLI in print mode emits either JSON (`--output-format json`,
 * whose `.result` is the text) or, on older CLIs, the raw text itself. Pull the
 * completion out of whichever we got; return null for an empty/again-parseable
 * result so triage falls back to the deterministic root cause.
 */
export function parseCliOutput(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { result?: unknown; is_error?: boolean };
    if (j.is_error) return null;
    const r = typeof j.result === "string" ? j.result.trim() : "";
    return r || null;
  } catch {
    return text; // not JSON — treat as plain text
  }
}

/**
 * A copy of the environment with Claude Code's nesting markers removed. When the
 * daemon is launched from inside a Claude Code session (or CI), the child
 * `claude` would otherwise inherit a child-session OAuth token that returns
 * empty completions. Stripping these is a no-op in a normal terminal.
 */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || /^CLAUDE_CODE/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export type TriageSpan = {
  ts: number;
  name: string;
  ms: number;
  code: number; // OTel status: 2 = error
  msg: string;
  kind: string;
  cost: number;
  tin: number;
  tout: number;
};

export type TriageResult = {
  agent: string;
  spanCount: number;
  errorCount: number;
  evidence: TriageSpan[];
  rootCause: string;
  suggestedFix: string;
  source: "llm" | "heuristic" | "no-data";
  from: "backend" | "local-log" | "none";
};

function safeId(id: string): string {
  return id.replace(/[^\w.\-:]/g, "");
}

/**
 * Pull the agent's own spans (its turns + the handoffs it's part of) from the
 * telemetry backend.
 */
async function fetchAgentSpans(agent: string, limit = 40): Promise<TriageSpan[]> {
  const a = safeId(agent);
  const sql = `
    SELECT toUnixTimestamp64Milli(timestamp) AS ts, name,
           round(duration_nano / 1e6) AS ms, status_code AS code, status_message AS msg,
           attributes_string['loom.event.kind'] AS kind,
           attributes_number['gen_ai.usage.cost_usd'] AS cost,
           toUInt32(attributes_number['gen_ai.usage.input_tokens']) AS tin,
           toUInt32(attributes_number['gen_ai.usage.output_tokens']) AS tout
    FROM ${SPAN_TABLE}
    WHERE \`resource_string_service$$name\` = '${chLiteral(SERVICE_NAME)}'
      AND (attributes_string['gen_ai.agent.id'] = '${a}'
           OR attributes_string['loom.handoff.to'] = '${a}'
           OR attributes_string['loom.handoff.from'] = '${a}')
    ORDER BY timestamp DESC
    LIMIT ${Math.min(120, limit)}`;
  const rows = await chQuery(sql);
  return rows.map((r) => ({
    ts: Number(r.ts),
    name: String(r.name),
    ms: Number(r.ms),
    code: Number(r.code),
    msg: String(r.msg ?? ""),
    kind: String(r.kind ?? ""),
    cost: Number(r.cost ?? 0),
    tin: Number(r.tin ?? 0),
    tout: Number(r.tout ?? 0),
  }));
}

/**
 * Fallback: derive trace-shaped rows from the local event log (same data the
 * backend gets).
 */
function spansFromLog(agent: string, events: LoomEvent[]): TriageSpan[] {
  const out: TriageSpan[] = [];
  for (const e of events) {
    const p = e.payload ?? {};
    const mine =
      e.agentId === agent || p.to === agent || p.from === agent || p.agent === agent;
    if (!mine) continue;
    if (e.kind === "run_complete") {
      // The turn's real cost, the same field the backend path reads into `cost`
      // and the same one insightSpansFromLog takes. This was a literal 0: every
      // fallback turn came back free, which is a number nobody measured sitting
      // in the column where a measured one goes. Nothing renders triage evidence
      // costs today — but a fabricated zero is only ever one render away from
      // being believed, and the log has the answer right here.
      out.push({ ts: e.ts, name: "gen_ai.agent.turn", ms: Number(p.durationMs ?? 0), code: p.error ? 2 : 1,
        msg: String(p.error ?? ""), kind: e.kind, cost: Number(p.costUsd ?? 0), tin: Number(p.inputTokens ?? 0), tout: Number(p.outputTokens ?? 0) });
    } else if (e.kind === "error") {
      out.push({ ts: e.ts, name: "loom.error", ms: 0, code: 2, msg: String(p.message ?? "error"), kind: e.kind, cost: 0, tin: 0, tout: 0 });
    } else if (e.kind === "route_failed") {
      out.push({ ts: e.ts, name: "loom.route.failed", ms: 0, code: 2, msg: String(p.error ?? p.reason ?? "route failed"), kind: e.kind, cost: 0, tin: 0, tout: 0 });
    } else if (e.kind === "handoff") {
      out.push({ ts: e.ts, name: "loom.baton.handoff", ms: 0, code: 1, msg: `${p.from ?? "?"} -> ${p.to ?? "?"}`, kind: e.kind, cost: 0, tin: 0, tout: 0 });
    } else if (e.kind === "needs_input") {
      out.push({ ts: e.ts, name: "loom.needs_input", ms: 0, code: 1, msg: String(p.question ?? "needs input"), kind: e.kind, cost: 0, tin: 0, tout: 0 });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, 40);
}

const isError = (s: TriageSpan): boolean => s.code === 2 || s.name === "loom.error" || s.name === "loom.route.failed";

function humanAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Deterministic root cause from the spans — reliable, no model required. */
function heuristic(agent: string, spans: TriageSpan[]): { rootCause: string; suggestedFix: string } {
  const errors = spans.filter(isError);
  const turns = spans.filter((s) => s.name === "gen_ai.agent.turn");
  if (!spans.length) {
    return { rootCause: `No traces for ${agent} yet.`, suggestedFix: "Run a turn so it emits telemetry, then triage again." };
  }
  if (!errors.length) {
    const slow = [...turns].sort((a, b) => b.ms - a.ms)[0];
    return {
      rootCause: `${agent} looks healthy — ${turns.length} turn(s), no error spans in its last ${spans.length} events${slow ? `, slowest turn ${slow.ms}ms` : ""}.`,
      suggestedFix: "Nothing to fix; the agent completed its turns cleanly.",
    };
  }
  const last = errors[0]!;
  const ago = humanAgo(last.ts);
  const where =
    last.name === "loom.route.failed" ? "a route step" : last.name === "loom.error" ? "the agent itself" : `a ${last.name}`;
  // upstream: the handoff that last passed the baton INTO this agent
  const upstream = spans.find((s) => s.name === "loom.baton.handoff" && s.msg.endsWith(`-> ${agent}`));
  const upTxt = upstream ? ` Upstream: the baton reached it via ${upstream.msg.replace(" -> ", " → ")}.` : "";
  const rootCause = `${agent} hit ${errors.length} error(s); the most recent (${ago}) was on ${where}: "${(last.msg || "unknown").slice(0, 220)}".${upTxt}`;
  const m = last.msg.toLowerCase();
  let fix = "Open the failing span in the telemetry backend for the full context, then retry the turn.";
  if (/exited|crash|serve exited|killed|sigterm|sigkill|process/.test(m)) fix = "The agent process crashed — restart the agent (or its CLI/daemon) and re-hand the baton.";
  else if (/timeout|timed out|deadline/.test(m)) fix = "A call timed out — raise the tool/turn timeout or check the upstream service, then re-hand the baton.";
  else if (/permission|denied|unauthor|not signed|401|403/.test(m)) fix = "Auth/permission failure — re-sign-in the agent's CLI (or refresh its API key) and retry.";
  else if (/json|parse|malformed|unexpected token|bad request/.test(m)) fix = "Malformed input, likely from the upstream handoff — validate the briefing/JSON before passing the baton.";
  else if (/rate|429|quota|limit/.test(m)) fix = "Rate-limited — back off and retry, or route the turn to a fallback agent.";
  else if (/model .* (not )?support|no public api/.test(m)) fix = "The model/endpoint isn't supported — switch the agent's model in .loom/config.json.";
  return { rootCause, suggestedFix: fix };
}

/** The triage model, overridable so an operator isn't pinned to one release. */
const TRIAGE_MODEL = process.env.LOOM_TRIAGE_MODEL || "claude-haiku-4-5-20251001";

/** Concatenate the text blocks of an Anthropic /v1/messages response. */
export function parseAnthropicText(json: unknown): string | null {
  const j = json as { content?: Array<{ type?: string; text?: string }> };
  const text = (j?.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("").trim();
  return text || null;
}

/** The triage prompt — the agent's spans, newest first, and what to answer. */
export function triagePrompt(agent: string, spans: TriageSpan[]): string {
  const lines = spans
    .slice(0, 30)
    .map((s) => `${new Date(s.ts).toISOString()} ${s.name} ${s.ms}ms status=${s.code}${s.msg ? ` "${s.msg.slice(0, 160)}"` : ""}`)
    .join("\n");
  return (
    `You are triaging a coding agent named "${agent}" from its OpenTelemetry traces (newest first):\n\n${lines}\n\n` +
    `In 2-3 sentences: the root cause of any failure, the specific span/turn, any upstream handoff, and one concrete fix. If healthy, say so plainly.`
  );
}

/**
 * Ask Claude to phrase the root cause. Two independent paths so LLM prose works
 * in ANY environment: the Anthropic API (an ANTHROPIC_API_KEY, works headless /
 * in CI / behind a server) first, then the signed-in `claude` CLI. Either one
 * returning text wins; null (→ deterministic heuristic) only if both are absent.
 */
async function llmPhrase(agent: string, spans: TriageSpan[]): Promise<string | null> {
  // Deterministic escape hatch (tests, or an operator who wants heuristic only).
  if (process.env.LOOM_TRIAGE_NO_LLM === "1") return null;
  const prompt = triagePrompt(agent, spans);

  const key = process.env.ANTHROPIC_API_KEY;
  if (key && typeof globalThis.fetch === "function") {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: TRIAGE_MODEL, max_tokens: 320, messages: [{ role: "user", content: prompt }] }),
      });
      if (res.ok) {
        const text = parseAnthropicText(await res.json());
        if (text) return text;
      }
    } catch {
      /* fall through to CLI */
    }
  }
  return await claudeCli(prompt);
}

/**
 * Best-effort: run the prompt through the signed-in `claude` CLI in print mode.
 * We ask for JSON so we can read `.result` reliably, run in a neutral cwd (no
 * project trust dialog, no giant CLAUDE.md pulled into context), and strip the
 * Claude Code nesting vars so a daemon started from inside a session still gets
 * a real completion. Falls back to null (→ heuristic) on timeout/empty.
 */
function claudeCli(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("claude", ["-p", prompt, "--output-format", "json"], {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: os.tmpdir(),
        env: cliEnv(),
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const kill = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 30_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => { clearTimeout(kill); resolve(parseCliOutput(out)); });
  });
}

/**
 * Triage one agent. `fallbackEvents` (the local log) is used only when the
 * backend has nothing, so triage always returns something useful.
 */
export async function triageAgent(agent: string, fallbackEvents: LoomEvent[] = []): Promise<TriageResult> {
  let spans: TriageSpan[] = [];
  let from: TriageResult["from"] = "none";
  try {
    spans = await fetchAgentSpans(agent);
    if (spans.length) from = "backend";
  } catch {
    /* the backend's ClickHouse unreachable — fall back to the local log */
  }
  if (!spans.length && fallbackEvents.length) {
    spans = spansFromLog(agent, fallbackEvents);
    if (spans.length) from = "local-log";
  }
  const errorCount = spans.filter(isError).length;
  const base = heuristic(agent, spans);
  const llm = spans.length ? await llmPhrase(agent, spans) : null;
  return {
    agent,
    spanCount: spans.length,
    errorCount,
    evidence: spans.slice(0, 12),
    rootCause: llm ?? base.rootCause,
    suggestedFix: base.suggestedFix,
    source: llm ? "llm" : spans.length ? "heuristic" : "no-data",
    from,
  };
}
