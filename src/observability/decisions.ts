/**
 * Decision capture — the KAIRO-style "what did each agent decide, and why".
 *
 * Every substantial agent turn contains deliberate choices (a tech pick, an
 * approach, a fix). This extracts them into structured AgentDecisions, through
 * whichever extractor this machine actually has, in descending order of how much
 * it can be trusted to judge its own certainty:
 *
 *   "llm"       the Anthropic API, when ANTHROPIC_API_KEY is set;
 *   "cli"       a signed-in local agent CLI driven headlessly — `agy --print`
 *               (Antigravity, cheap Gemini model) or `claude -p`. Same trick
 *               observability/triage.ts uses to get real prose with no API key;
 *   "heuristic" a regex over the prose, when there is no model at all.
 *
 * That order is also why `confidence` is OPTIONAL. A model reading the turn can
 * say how sure the agent sounded; a regex matching "I'll use X because Y"
 * cannot, and the constants it used to stamp (70/75/78/80) were rendered to
 * users as a measured percentage with a progress bar and averaged into a fleet
 * "Avg confidence" tile. A heuristic decision now carries no confidence at all,
 * and `source` says how it was extracted, so nothing downstream has to guess
 * whether a number was measured or invented.
 *
 * The result is persisted per project and surfaced in the Observatory Decision
 * Explorer, the Timeline, and the Time-Travel Replay.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnv } from "../adapters/base.js";

export type DecisionCategory =
  | "architecture"
  | "design"
  | "implementation"
  | "fix"
  | "refactor"
  | "test"
  | "other";

/** How a decision was extracted — see the module header. */
export type DecisionSource = "llm" | "cli" | "heuristic";

export interface AgentDecision {
  id: string;
  projectId: string;
  chatId: string;
  agentId: string;
  agentRole: string;
  timestamp: number;
  turnIndex: number;
  /**
   * The telemetry trace of the turn this came out of, when telemetry minted
   * one. Absent when export is off — a decision with no trace links to nothing,
   * and the empty string it used to carry made every "open in the backend" a
   * dead end that looked like a live one.
   */
  traceId?: string;
  /** The log event id of the `run_complete` this was mined from, when known. */
  turnId?: string;
  category: DecisionCategory;
  title: string;
  reasoning: string;
  /** 0–100, from the extractor that read the turn. Absent for "heuristic". */
  confidence?: number;
  source: DecisionSource;
  alternatives: string[];
  filesCreated: string[];
  filesModified: string[];
  artifactNames: string[];
  memoryKeys: string[];
  upstreamDecisionIds: string[];
  /**
   * The WHOLE TURN's usage, not this decision's share of it.
   *
   * A turn yielding three decisions has one token count and one price; there is
   * no honest way to split them, and the previous field names (`tokensUsed`,
   * `costUsd`) sat on each decision as if there were — three rows each showing
   * the full turn cost, so a $0.04 turn read as $0.12 of decisions. Named for
   * what they are so a renderer has to say "from a turn that used X".
   */
  turnTokensUsed: number;
  turnCostUsd: number;
  durationMs: number;
}

export interface DecisionStats {
  total: number;
  byAgent: Record<string, number>;
  byCategory: Record<string, number>;
  /**
   * Averaged over the decisions that actually HAVE a confidence, and null when
   * none do — a fleet of heuristic decisions has no measured confidence, and
   * "0" would render as a real reading of total uncertainty.
   */
  avgConfidence: number | null;
  /** How many of `total` carried a confidence, so the average can be qualified. */
  confidenceSamples: number;
  /** How many decisions came from each extractor. */
  bySource: Record<DecisionSource, number>;
  topAlternatives: string[];
  criticalPath: string[];
}

const CATEGORIES: DecisionCategory[] = ["architecture", "design", "implementation", "fix", "refactor", "test", "other"];

type RawDecision = {
  category: DecisionCategory;
  title: string;
  reasoning: string;
  /** Absent when the extractor couldn't judge it — see the module header. */
  confidence?: number;
  alternatives: string[];
  filesCreated: string[];
  filesModified: string[];
  artifactNames: string[];
};

const DECISION_MODEL = process.env.LOOM_DECISION_MODEL || "claude-haiku-4-5-20251001";

const DECISION_EXTRACT_PROMPT = `You are analyzing an AI coding agent's turn output.
Extract all significant decisions the agent made. A decision is a deliberate choice
between alternatives — tech choices, architectural decisions, implementation approaches.

For each decision, output JSON with this exact shape:
{
  "decisions": [
    {
      "category": "architecture|design|implementation|fix|refactor|test|other",
      "title": "short label under 60 chars",
      "reasoning": "why the agent chose this (1-2 sentences)",
      "confidence": 85,
      "alternatives": ["other option 1", "other option 2"],
      "filesCreated": ["path/to/file.ts"],
      "filesModified": ["path/to/existing.ts"],
      "artifactNames": ["ComponentName", "functionName"]
    }
  ]
}

Rules:
- Only extract REAL decisions, not descriptions of what was done
- confidence: how sure the AGENT sounded about this choice, 0-100. 90+ very
  sure, 70-89 reasonably sure, below 70 uncertain. Judge it from the text; if
  the text gives you nothing to judge it by, OMIT the field entirely rather
  than guessing a number
- alternatives: what the agent explicitly considered OR obvious alternatives
- If no clear decisions, return {"decisions": []}
- Output ONLY valid JSON, no markdown, no explanation

Agent turn output to analyze:
`;

/**
 * Truncate to a word boundary with an ellipsis — never mid-word. A decision
 * title cut at a raw 60 chars reads as broken ("…Redis to store and"); cut at
 * the last whole word with an ellipsis reads as intentional.
 */
function clip(s: string, max = 60): string {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, "") + "…";
}

/** Coerce one loose object from the model into a well-formed RawDecision. */
function normalizeRaw(d: Record<string, unknown>): RawDecision {
  const cat = String(d.category ?? "other") as DecisionCategory;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const conf = Number(d.confidence);
  return {
    category: CATEGORIES.includes(cat) ? cat : "other",
    title: clip(String(d.title ?? "")) || "decision",
    reasoning: String(d.reasoning ?? ""),
    // A model that declined to answer, or answered with junk, gets no
    // confidence — not a plausible-looking default standing in for one.
    ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(100, Math.round(conf))) } : {}),
    alternatives: arr(d.alternatives).slice(0, 6),
    filesCreated: arr(d.filesCreated),
    filesModified: arr(d.filesModified),
    artifactNames: arr(d.artifactNames).slice(0, 12),
  };
}

/** Parse the model's JSON reply (tolerating ```json fences) into RawDecisions. */
export function parseDecisionsJson(text: string): RawDecision[] {
  const cleaned = (text || "").replace(/```json|```/g, "").trim();
  if (!cleaned) return [];
  try {
    const parsed = JSON.parse(cleaned) as { decisions?: unknown };
    const list = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
    return list.map((d) => normalizeRaw((d ?? {}) as Record<string, unknown>));
  } catch {
    return [];
  }
}

/**
 * Regex fallback — pull decisions from natural phrasings ("I'll use X because Y",
 * "Instead of X, I'll Y") when there is no model of any kind to read the turn.
 *
 * It emits NO confidence, deliberately. Matching a sentence shape tells you a
 * decision was stated; it tells you nothing whatsoever about how sure the agent
 * was, and the 75/78/80 these branches used to stamp were numbers nobody
 * measured, shown to users as if somebody had.
 */
export function extractDecisionsRegex(text: string): RawDecision[] {
  const decisions: RawDecision[] = [];
  const base = { filesCreated: [] as string[], filesModified: [] as string[], artifactNames: [] as string[] };

  const usePattern = /I(?:'ll| will) (?:use|implement|create|build|add|go with|adopt) ([^.]+?) (?:because|since|as|so that) ([^.]+)\./gi;
  let m: RegExpExecArray | null;
  while ((m = usePattern.exec(text)) !== null) {
    decisions.push({ ...base, category: "implementation", title: clip(m[1]!), reasoning: m[2]!.trim(), alternatives: [] });
  }

  const insteadPattern = /[Ii]nstead of ([^,]+), I(?:'ll| will) ([^.]+)\./g;
  while ((m = insteadPattern.exec(text)) !== null) {
    decisions.push({ ...base, category: "implementation", title: clip(m[2]!), reasoning: `Preferred over: ${m[1]!.trim()}`, alternatives: [m[1]!.trim()] });
  }

  const choosePattern = /I(?:'ve| have)? (?:chose|decided|opted|picked)(?: to| for)? ([^.]+?)(?: (?:because|since|to) ([^.]+))?\./gi;
  while ((m = choosePattern.exec(text)) !== null) {
    decisions.push({ ...base, category: "implementation", title: clip(m[1]!), reasoning: (m[2] ?? "chosen approach").trim(), alternatives: [] });
  }

  return decisions.slice(0, 5);
}

/** Call the Anthropic API to extract decisions; empty on any failure. */
async function llmExtract(turnText: string, apiKey: string): Promise<RawDecision[]> {
  if (typeof globalThis.fetch !== "function") return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: DECISION_MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: DECISION_EXTRACT_PROMPT + turnText.slice(0, 3000) }],
      }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (j.content ?? []).map((c) => c.text ?? "").join("").trim();
    return parseDecisionsJson(text);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The CLI extractor — a real model, with no API key
// ---------------------------------------------------------------------------

/**
 * Run a prompt through a local agent CLI and hand back its raw stdout.
 * Null means "this CLI isn't here, or it gave us nothing".
 */
export type CliExtractor = (prompt: string) => Promise<string | null>;

/** agy's cheap tier; the extraction is a small structured read, not reasoning. */
const AGY_MODEL = process.env.LOOM_DECISION_AGY_MODEL || "gemini-3.6-flash-low";
/** The claude alias used when agy isn't installed. Small + fast is right. */
const CLAUDE_MODEL = process.env.LOOM_DECISION_CLAUDE_MODEL || "haiku";

/** Where the agy installer drops the binary; it isn't always on the daemon's PATH. */
const AGY_INSTALLED = path.join(os.homedir(), ".local", "bin", "agy");

/**
 * Run one CLI to completion and return its stdout, or null on timeout, crash,
 * or an empty answer. Deliberately the same shape as triage.ts's `claudeCli`:
 * neutral cwd (no project trust dialog, no CLAUDE.md dragged into context),
 * stdin closed (both CLIs stall in print mode with a pipe open), and `agentEnv`
 * so a daemon started from inside a Claude Code session doesn't hand the child
 * a session-scoped token that answers with nothing.
 */
function runCli(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], cwd: os.tmpdir(), env: agentEnv() });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(null);
    }, timeoutMs);
    kill.unref?.();
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(kill);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(kill);
      resolve(out.trim() || null);
    });
  });
}

/**
 * The default CLI extractor: `agy --print` if Antigravity is installed, else
 * `claude -p`. agy is preferred because a turn handed to it runs on Gemini
 * rather than spending the orchestrator's Claude budget — the same reason the
 * antigravity-cli adapter exists.
 *
 * Returns null when neither CLI is present, which is what demotes extraction to
 * the regex (and to no confidence at all).
 */
export const defaultCliExtractor: CliExtractor = async (prompt) => {
  if (fs.existsSync(AGY_INSTALLED)) {
    const out = await runCli(
      AGY_INSTALLED,
      ["--print", prompt, "--model", AGY_MODEL, "--dangerously-skip-permissions", "--print-timeout", "90s"],
      120_000,
    );
    if (out) return out;
  }
  // `claude -p --output-format json` puts the completion in `.result`; the
  // parser below tolerates either that wrapper or bare text.
  return await runCli("claude", ["-p", prompt, "--output-format", "json", "--model", CLAUDE_MODEL], 90_000);
};

/**
 * Pull the completion out of whatever a CLI printed: the `.result` of claude's
 * JSON wrapper, or the raw text agy prints. Kept separate from
 * `parseDecisionsJson` because that one is looking for the decisions document,
 * and one of these two CLIs wraps it in another one.
 */
export function unwrapCliOutput(raw: string | null): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text) as { result?: unknown; is_error?: boolean; decisions?: unknown };
    if (Array.isArray(j?.decisions)) return text; // already the document we want
    if (j?.is_error) return "";
    return typeof j?.result === "string" ? j.result.trim() : "";
  } catch {
    return text; // not JSON — agy's markdown, which parseDecisionsJson defences
  }
}

/** Ask a local CLI to read the turn; empty on any failure. */
async function cliExtract(turnText: string, extractor: CliExtractor): Promise<RawDecision[]> {
  const out = await extractor(DECISION_EXTRACT_PROMPT + turnText.slice(0, 3000)).catch(() => null);
  return parseDecisionsJson(unwrapCliOutput(out));
}

export interface ExtractOpts {
  agentId: string;
  agentRole: string;
  projectId: string;
  chatId: string;
  turnIndex: number;
  /** The turn's telemetry trace, when telemetry minted one. Omit when it didn't. */
  traceId?: string;
  /** The `run_complete` log event this turn is, when the caller knows it. */
  turnId?: string;
  turnText: string;
  /** The WHOLE turn's usage — see AgentDecision#turnTokensUsed. */
  turnTokensUsed: number;
  turnCostUsd: number;
  durationMs: number;
  filesChanged: string[];
  anthropicApiKey?: string;
  /** Overridable so a caller (or a test) can drive the CLI path without a CLI. */
  cliExtractor?: CliExtractor;
}

/** Extract structured decisions from one completed turn. */
export async function extractDecisions(opts: ExtractOpts): Promise<AgentDecision[]> {
  const { turnText, filesChanged, anthropicApiKey } = opts;
  // Skip trivial turns (greetings, acknowledgements).
  if ((turnText ?? "").trim().length < 100) return [];

  let raw: RawDecision[] = [];
  let source: DecisionSource = "heuristic";
  if (anthropicApiKey) {
    raw = await llmExtract(turnText, anthropicApiKey);
    if (raw.length) source = "llm";
  }
  // Deterministic escape hatch (tests, or an operator who wants no shell-outs).
  if (raw.length === 0 && process.env.LOOM_DECISIONS_NO_CLI !== "1") {
    raw = await cliExtract(turnText, opts.cliExtractor ?? defaultCliExtractor);
    if (raw.length) source = "cli";
  }
  if (raw.length === 0) {
    raw = extractDecisionsRegex(turnText);
    source = "heuristic";
  }

  const changed = new Set(filesChanged);
  const now = Date.now();
  return raw.map((d, i) => ({
    id: `${opts.projectId}-${opts.chatId}-t${opts.turnIndex}-d${i}-${now}`,
    projectId: opts.projectId,
    chatId: opts.chatId,
    agentId: opts.agentId,
    agentRole: opts.agentRole,
    timestamp: now,
    turnIndex: opts.turnIndex,
    // Absent, not "", when this turn has no trace: the difference is a working
    // link versus one that opens a backend search for nothing.
    ...(opts.traceId ? { traceId: opts.traceId } : {}),
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    category: d.category,
    title: d.title,
    reasoning: d.reasoning,
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    source,
    alternatives: d.alternatives,
    // Only keep file claims the turn actually changed (when we know the diff).
    filesCreated: changed.size ? d.filesCreated.filter((f) => changed.has(f)) : d.filesCreated,
    filesModified: changed.size ? d.filesModified.filter((f) => changed.has(f)) : d.filesModified,
    artifactNames: d.artifactNames,
    memoryKeys: [],
    upstreamDecisionIds: [],
    turnTokensUsed: opts.turnTokensUsed,
    turnCostUsd: opts.turnCostUsd,
    durationMs: opts.durationMs,
  }));
}

/**
 * Read one decision back out of the persisted store, in today's shape.
 *
 * Records written before `source` existed are the problem this handles. Every
 * one of them carries a confidence, and on a machine with no ANTHROPIC_API_KEY
 * — which is the machine most of them were written on — that number came from
 * the regex's 70/75/78/80 constants. It is not distinguishable from a measured
 * one, and a number you cannot tell apart from an invented number must not be
 * rendered as a measurement. So a record with no `source` is read as heuristic
 * and reports no confidence.
 *
 * A projection, not a migration: the file on disk is untouched, and a record
 * written from here on carries its real source and is passed through as-is.
 * The old turn-total names are mapped across for the same reason.
 */
export function normalizeStoredDecision(raw: AgentDecision & { tokensUsed?: number; costUsd?: number }): AgentDecision {
  const { tokensUsed, costUsd, confidence, traceId, ...rest } = raw;
  // A record with a source states how it was extracted and can be believed; one
  // without predates the distinction and keeps nothing it can't account for.
  const measured = raw.source !== undefined ? confidence : undefined;
  return {
    ...rest,
    source: raw.source ?? "heuristic",
    ...(typeof measured === "number" ? { confidence: measured } : {}),
    // "" was what "no trace" used to look like; it links to nothing.
    ...(traceId ? { traceId } : {}),
    turnTokensUsed: raw.turnTokensUsed ?? tokensUsed ?? 0,
    turnCostUsd: raw.turnCostUsd ?? costUsd ?? 0,
  };
}

/** Roll up decisions for the Explorer header + KAIRO metrics. */
export function decisionStats(decisions: AgentDecision[]): DecisionStats {
  const byAgent: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const bySource: Record<DecisionSource, number> = { llm: 0, cli: 0, heuristic: 0 };
  const altCounts = new Map<string, number>();
  let confSum = 0;
  let confSamples = 0;
  for (const d of decisions) {
    byAgent[d.agentId] = (byAgent[d.agentId] ?? 0) + 1;
    byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
    // Decisions read off disk predate `source`; count them as what they were.
    bySource[d.source ?? "heuristic"] += 1;
    // Only measured confidences are averaged. Treating a missing one as 0 would
    // drag the fleet average down with a number nobody ever reported.
    if (typeof d.confidence === "number") {
      confSum += d.confidence;
      confSamples += 1;
    }
    for (const a of d.alternatives) altCounts.set(a, (altCounts.get(a) ?? 0) + 1);
  }
  const topAlternatives = [...altCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
  // Critical path = the ordered chain of agents that made decisions (deduped runs).
  const chain: string[] = [];
  for (const d of [...decisions].sort((a, b) => a.timestamp - b.timestamp)) {
    if (chain[chain.length - 1] !== d.agentId) chain.push(d.agentId);
  }
  return {
    total: decisions.length,
    byAgent,
    byCategory,
    avgConfidence: confSamples ? Math.round(confSum / confSamples) : null,
    confidenceSamples: confSamples,
    bySource,
    topAlternatives,
    criticalPath: chain.slice(0, 8),
  };
}
