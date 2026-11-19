/** Model accounting uses recorded turns and persisted picks, never inferred winners. */
import fs from "node:fs";
import path from "node:path";
import { EventLog } from "./eventlog.js";
import { readProjectConfig } from "./registry.js";
import type { AgentConfig, LoomEvent, ProjectInfo } from "../types.js";
import type { OrchestraRun } from "./orchestra.js";

export type ScoreboardWindow = "7d" | "30d" | "all";

/** Rates are fractions (0..1), durations milliseconds, costs USD. Null means no
 * observations, not zero. Unknown models/kinds have the literal key "unknown".
 * avgCostUsd divides by costedTurns; tokens sum reported input and output tokens.
 */
export interface ModelStanding {
  key: string;
  kind?: string;
  model: string;
  turns: number;
  finished: number;
  interrupted: number;
  errored: number;
  finishedRate: number | null;
  interruptedRate: number | null;
  erroredRate: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  totalCostUsd: number;
  costedTurns: number;
  avgCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  entries: number;
  wins: number;
  winRate: number | null;
  tasksDone: number;
  reviews: number;
  reviewsPassed: number;
  reviewPassRate: number | null;
}

/** GET /api/scoreboard response. Both arrays sort by win rate descending, then
 * per-turn cost ascending (unknown last), then key. projects lists included ids.
 * since is an inclusive timestamp, null for all; generatedAt bounds the window.
 */
export interface Scoreboard {
  project: string;
  projects: string[];
  window: ScoreboardWindow;
  since: number | null;
  generatedAt: number;
  byKindModel: ModelStanding[];
  byModel: ModelStanding[];
}

export interface ScoreboardSource {
  id: string;
  agents: AgentConfig[];
  events: LoomEvent[];
  runs: OrchestraRun[];
}

export function scoreboardWindow(value: unknown = "30d"): ScoreboardWindow {
  if (value !== "7d" && value !== "30d" && value !== "all") throw new Error("window must be 7d, 30d or all");
  return value;
}

const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const string = (v: unknown): string | undefined => typeof v === "string" && v ? v : undefined;
const ratio = (n: number, d: number) => d ? n / d : null;

export function rankModels(rows: ModelStanding[]): ModelStanding[] {
  return rows.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) ||
    (a.avgCostUsd ?? Infinity) - (b.avgCostUsd ?? Infinity) || a.key.localeCompare(b.key));
}

export function modelScoreboard(sources: ScoreboardSource[], window: ScoreboardWindow = "30d", now = Date.now(), project = "all"): Scoreboard {
  scoreboardWindow(window);
  const since = window === "all" ? null : now - (window === "7d" ? 7 : 30) * 86_400_000;
  const within = (ts: number) => ts >= (since ?? 0) && ts <= now;
  type Bucket = { row: ModelStanding; durations: number[] };
  const kinds = new Map<string, Bucket>(), models = new Map<string, Bucket>();
  const bucket = (map: Map<string, Bucket>, key: string, model: string, kind?: string): Bucket => {
    let b = map.get(key);
    if (!b) {
      b = { durations: [], row: { key, ...(kind ? { kind } : {}), model, turns: 0, finished: 0, interrupted: 0, errored: 0,
        finishedRate: null, interruptedRate: null, erroredRate: null, medianMs: null, p90Ms: null,
        totalCostUsd: 0, costedTurns: 0, avgCostUsd: null, inputTokens: 0, outputTokens: 0, tokens: 0,
        entries: 0, wins: 0, winRate: null, tasksDone: 0, reviews: 0, reviewsPassed: 0, reviewPassRate: null } };
      map.set(key, b);
    }
    return b;
  };
  const each = (kind: string, model: string, update: (b: Bucket) => void) => {
    update(bucket(kinds, `${kind}@${model}`, model, kind));
    update(bucket(models, model, model));
  };
  for (const source of sources) {
    const runs = new Map(source.runs.map(r => [r.id, r]));
    for (const e of source.events) {
      if (!e.agentId || !within(e.ts)) continue;
      const p = e.payload;
      const interrupted = e.kind === "status" && p.state === "interrupted";
      if (e.kind !== "run_complete" && e.kind !== "error" && !interrupted) continue;
      const ref = p.orchestra as { runId?: string; taskId?: string } | undefined;
      const run = ref?.runId ? runs.get(ref.runId) : undefined;
      const selection = ref?.taskId ? run?.tasks.find(t => t.id === ref.taskId) : run?.orchestrator;
      const agent = source.agents.find(a => a.id === e.agentId);
      const kind = string(p.adapter) ?? selection?.kind ?? agent?.kind ?? "unknown";
      // Today's configured model cannot explain an old turn. Only pinned or reported selections can.
      const model = string(p.model) ?? selection?.model ?? "unknown";
      each(kind, model, b => {
        const r = b.row;
        r.turns++;
        if (interrupted || p.interrupted === true) r.interrupted++;
        else if (e.kind === "error" || p.error || p.isError === true || p.is_error === true) r.errored++;
        else r.finished++;
        const duration = number(p.durationMs), cost = number(p.costUsd);
        if (duration !== undefined) b.durations.push(duration);
        if (cost !== undefined) { r.totalCostUsd += cost; r.costedTurns++; }
        r.inputTokens += number(p.inputTokens) ?? 0;
        r.outputTokens += number(p.outputTokens) ?? 0;
      });
    }
    for (const run of source.runs) {
      for (const task of run.tasks) {
        const race = run.race || run.compare;
        // Entries and wins use the same cohort: entry time, even if its pick came later.
        const entry = race && within(task.startedAt ?? run.createdAt);
        const done = !race && task.status === "done" && within(task.finishedAt ?? run.updatedAt);
        const review = !race && task.status === "done" ? run.landing?.review : undefined;
        const checked = review && within(review.at) && (review.state === "success" || review.state === "failure");
        if (!entry && !done && !checked) continue;
        const worker = run.workerDetails?.find(w => w.id === task.agent);
        each(task.kind || worker?.kind || "unknown", task.model ?? worker?.model ?? "unknown", b => {
          if (entry) { b.row.entries++; if (run.applied?.task === task.id && run.applied.at <= now) b.row.wins++; }
          if (done) b.row.tasksDone++;
          // Landing records a review of the integrated run, applying to each completed task.
          // Merely finishing, reporting "done", or skipping review is not a pass.
          if (checked) { b.row.reviews++; if (review.state === "success") b.row.reviewsPassed++; }
        });
      }
    }
  }
  const finish = (map: Map<string, Bucket>) => rankModels([...map.values()].map(({ row: r, durations: ds }) => {
    ds.sort((a, b) => a - b);
    const mid = Math.floor(ds.length / 2);
    r.medianMs = ds.length ? ds.length % 2 ? ds[mid]! : (ds[mid - 1]! + ds[mid]!) / 2 : null;
    r.p90Ms = ds.length ? ds[Math.ceil(ds.length * 0.9) - 1]! : null;
    r.finishedRate = ratio(r.finished, r.turns); r.interruptedRate = ratio(r.interrupted, r.turns); r.erroredRate = ratio(r.errored, r.turns);
    r.avgCostUsd = ratio(r.totalCostUsd, r.costedTurns); r.tokens = r.inputTokens + r.outputTokens;
    r.winRate = ratio(r.wins, r.entries); r.reviewPassRate = ratio(r.reviewsPassed, r.reviews);
    return r;
  }));
  return { project, projects: sources.map(s => s.id), window, since, generatedAt: now, byKindModel: finish(kinds), byModel: finish(models) };
}

/** Read registered projects without starting their agents or recovering inactive runs. */
export async function readScoreboard(projects: ProjectInfo[], window: ScoreboardWindow = "30d", project = "all", now = Date.now()): Promise<Scoreboard> {
  const sinceTs = window === "all" ? undefined : now - (window === "7d" ? 7 : 30) * 86_400_000;
  const sources: ScoreboardSource[] = [];
  for (const info of projects) {
    const log = await EventLog.open(path.join(info.dir, ".loom"));
    try {
      const dir = path.join(info.dir, ".loom", "orchestra");
      const runs: OrchestraRun[] = [];
      for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".json")) : []) {
        // one unreadable run file (a crash mid-write, a hand edit) must not blank the whole board
        try { runs.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as OrchestraRun); } catch { /* skip it */ }
      }
      sources.push({ id: info.id, agents: readProjectConfig(info.dir)?.agents ?? [], runs,
        events: log.list({ kinds: ["run_complete", "error", "status"], allBranches: true, sinceTs }) });
    } finally { log.close(); }
  }
  return modelScoreboard(sources, window, now, project);
}

/** Require a full top-N with evidence; otherwise retain the caller's configured fleet. */
export function bestFleet(rows: ModelStanding[], count: number, fallback: string[], allowed: (kind: string) => boolean): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("best count must be an integer from 1 to 100");
  const best = rankModels([...rows]).filter(r => r.entries >= 5 && r.kind && r.model !== "unknown" && allowed(r.kind)).slice(0, count);
  return best.length === count ? best.map(r => `${r.kind}@${r.model}`) : fallback;
}

/** Quoted cells preserve commas/newlines; text prefixes keep spreadsheet formulas inert. */
export function scoreboardCsv(board: Scoreboard, by: "byKindModel" | "byModel" = "byKindModel"): string {
  const keys: Array<keyof ModelStanding> = ["key", "kind", "model", "turns", "finished", "interrupted", "errored", "finishedRate", "interruptedRate", "erroredRate", "medianMs", "p90Ms", "totalCostUsd", "costedTurns", "avgCostUsd", "inputTokens", "outputTokens", "tokens", "entries", "wins", "winRate", "tasksDone", "reviews", "reviewsPassed", "reviewPassRate"];
  const cell = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return [keys.map(cell).join(","), ...board[by].map(row => keys.map(k => cell(row[k])).join(","))].join("\r\n") + "\r\n";
}

export function scoreboardDigest(board: Scoreboard): string {
  if (!board.byModel.length) return "Weekly scoreboard: no model results in the last 7 days.";
  return "Weekly scoreboard · last 7 days\n" + board.byModel.map(r =>
    `${r.model}: ${r.turns} turns, ${r.finished} finished, ${r.wins}/${r.entries} wins, ${r.tokens} tokens, $${r.totalCostUsd.toFixed(4)} recorded cost`).join("\n");
}
