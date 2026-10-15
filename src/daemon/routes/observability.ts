import type { Express } from 'express';
import { writeMcpSession } from "../../core/mcp.js";
import { ask, type AskContext } from "../../observability/ask.js";
import { burnSeries, fetchMetricSeries, fetchSpans, healthScore, insightSpansFromLog, LOOM_METRIC_NAMES, traceSpans, type InsightSpan, type MetricSeries } from "../../observability/insights.js";
import { fetchLogs, type InsightLog } from "../../observability/logs-query.js";
import { buildSnapshots } from "../../observability/snapshots.js";
import { triageAgent } from "../../observability/triage.js";
import { kairoMetrics } from '../system.js';
import type { WithRuntime } from './context.js';
import { leaderboard, perDay, turnRows, turnsCsv, trustByAgent } from "../../core/turn-stats.js";
/** Register observability routes in the order established by LoomDaemon.routes(). */
export function registerObservabilityRoutes(app: Express, withRuntime: WithRuntime): void {

  app.get(
    "/api/projects/:id",
    withRuntime(async (rt, _req, res) => {
      res.json({ project: await rt.status() });
    }),
  );

  // Per-agent cost / turns / tokens for the fleet — the same numbers the
  // observability layer ships as gen_ai spans, served locally so the UI can
  // render them without a telemetry backend being up at all.
  app.get(
    "/api/projects/:id/metrics",
    withRuntime(async (rt, _req, res) => {
      res.json({ metrics: rt.costSummary(), kairo: kairoMetrics(rt) });
    }),
  );

  // Decision explorer: structured decisions mined from agent turns.
  app.get(
    "/api/projects/:id/decisions",
    withRuntime(async (rt, req, res) => {
      const agent = req.query.agent ? String(req.query.agent) : undefined;
      const category = req.query.category ? String(req.query.category) : undefined;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      let decisions = rt.getDecisions();
      if (agent) decisions = decisions.filter((d) => d.agentId === agent);
      if (category) decisions = decisions.filter((d) => d.category === category);
      res.json({ decisions: decisions.slice(0, limit), stats: rt.decisionStats() });
    }),
  );

  // Time-Travel Replay: snapshots folded from the event log, on demand.
  app.get(
    "/api/projects/:id/snapshots",
    withRuntime(async (rt, _req, res) => {
      res.json({ snapshots: buildSnapshots(rt.log.list({ limit: 2000 })) });
    }),
  );

  // Agent self-triage: read one agent's own traces back out of the telemetry
  // store (falling back to the local event log) and root-cause its last
  // failure.
  app.get(
    "/api/projects/:id/triage/:agentId",
    withRuntime(async (rt, req, res) => {
      const agent = String(req.params.agentId ?? "");
      const events = rt.log.list({ limit: 300 });
      res.json({ triage: await triageAgent(agent, events) });
    }),
  );

  // Observatory insights, read back from the backend's ClickHouse (with a
  // local-log fallback so the panels still work when it is empty/down):
  //   spans  → Span Replay (scrub a turn's spans frame by frame)
  //   trace  → Trace Waterfall (one trace's span tree + a backend deep link)
  //   burn   → per-agent cost over time + a linear 24h projection
  //   health → the 0–100 Agent Health Score with its penalty breakdown
  app.get(
    "/api/projects/:id/insights/spans",
    withRuntime(async (rt, req, res) => {
      const agent = req.query.agent ? String(req.query.agent) : undefined;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      let spans = await fetchSpans(rt.info.name, { agent, limit }).catch(() => [] as InsightSpan[]);
      let from: "backend" | "local-log" = "backend";
      if (!spans.length) {
        spans = insightSpansFromLog(rt.log.list({ limit: 400 }), agent).slice(0, limit);
        from = "local-log";
      }
      res.json({ from, spans });
    }),
  );

  app.get(
    "/api/projects/:id/insights/trace/:traceId",
    withRuntime(async (_rt, req, res) => {
      const spans = await traceSpans(String(req.params.traceId ?? "")).catch(() => [] as InsightSpan[]);
      res.json({ traceId: String(req.params.traceId ?? ""), spans });
    }),
  );

  /**
   * The other two OTel signals, read back.
   *
   * Both differ from /insights/spans in one important way: there is no
   * local-log fallback. A span can be reconstructed from the event log because
   * it summarises an event Loom already stored; a log body or a metric sample
   * cannot be, and faking one would put a number on screen the telemetry
   * backend never saw. So when ClickHouse is unreachable these return
   * `from: "unavailable"` with an empty payload and the UI is expected to say
   * the backend is unreachable rather than render a plausible-looking empty
   * chart.
   *
   * `rt.info.name` — not the project id — is the filter value, because that is
   * what Loom stamps onto loom.project when it exports (same as the span
   * routes above).
   */
  app.get(
    "/api/projects/:id/insights/logs",
    withRuntime(async (rt, req, res) => {
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      let from: "backend" | "unavailable" = "backend";
      const logs = await fetchLogs({
        project: rt.info.name,
        agent: req.query.agent ? String(req.query.agent) : undefined,
        severity: req.query.severity ? String(req.query.severity) : undefined,
        traceId: req.query.traceId ? String(req.query.traceId) : undefined,
        search: req.query.q ? String(req.query.q) : undefined,
        limit,
      }).catch(() => {
        from = "unavailable";
        return [] as InsightLog[];
      });
      res.json({ from, logs });
    }),
  );

  app.get(
    "/api/projects/:id/insights/metrics",
    withRuntime(async (rt, req, res) => {
      // `names` is a comma list; omitting it means "everything Loom emits".
      const names = String(req.query.names ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // `since` accepts either an absolute epoch-ms or a lookback in ms; a
      // value small enough to be a duration cannot be a real 2020s timestamp.
      const raw = Number(req.query.since) || 0;
      const now = Date.now();
      const sinceMs = raw <= 0 ? now - 6 * 3600_000 : raw < 1e12 ? now - raw : raw;
      const stepMs = Math.max(1000, Number(req.query.step) || 60_000);
      let from: "backend" | "unavailable" = "backend";
      const series = await fetchMetricSeries(names.length ? names : LOOM_METRIC_NAMES, {
        project: rt.info.name,
        sinceMs,
        stepMs,
      }).catch(() => {
        from = "unavailable";
        return [] as MetricSeries[];
      });
      res.json({ from, sinceMs, stepMs, series });
    }),
  );

  /**
   * Ask the Observatory a question about this fleet.
   *
   * The evidence is assembled from the same sources the Observatory renders —
   * status, metrics, health, spans, decisions — so an answer can never cite a
   * number the screen doesn't also show. Any MCP servers the project has
   * configured are handed to the model for the turn, which is the point: when
   * one of them fronts the telemetry store, let the model query it directly
   * rather than trusting a summary.
   */
  app.post(
    "/api/projects/:id/observatory/ask",
    withRuntime(async (rt, req, res) => {
      const question = String((req.body ?? {}).question ?? "").trim();
      if (!question) return void res.status(400).json({ error: "missing question" });

      const status = await rt.status();
      const metrics = rt.costSummary();
      const byAgent = new Map(metrics.byAgent.map((a) => [a.agentId, a]));

      let spans = await fetchSpans(rt.info.name, { limit: 120 }).catch(() => [] as InsightSpan[]);
      let spanSource = "backend";
      if (!spans.length) {
        spans = insightSpansFromLog(rt.log.list({ limit: 300 })).slice(0, 120);
        spanSource = "local-log";
      }

      const ctx: AskContext = {
        projectName: rt.info.name,
        spendUsd: metrics.totalUsd ?? 0,
        turns: metrics.turns ?? 0,
        tokensIn: metrics.tokensIn ?? 0,
        tokensOut: metrics.tokensOut ?? 0,
        holder: status.holder ?? null,
        agents: status.agents.map((a) => {
          const mine = spans.filter((s) => s.agent === a.id);
          return {
            id: a.id, kind: a.kind, role: a.role, busy: a.busy,
            turns: byAgent.get(a.id)?.turns, usd: byAgent.get(a.id)?.usd,
            // Scored the same way the Metrics tab scores it: this agent's own
            // spans, so the answer and the screen can never disagree.
            health: mine.length ? healthScore(mine).score : null,
          };
        }),
        recentSpans: spans.slice(-40).map((s) => ({ ts: s.ts, agent: s.agent, name: s.name, ms: s.ms, code: s.code, model: s.model, msg: s.msg })),
        decisions: rt.getDecisions().map((d) => ({ agentId: d.agentId, title: d.title, category: d.category, confidence: d.confidence, source: d.source })),
        spanSource,
      };

      // Hand over the project's real MCP servers for this question, exactly
      // as a turn would get them.
      const session = writeMcpSession(rt.config.mcps);
      try {
        const result = await ask(question, ctx, {
          cwd: rt.info.dir,
          ...(session?.configPath ? { mcpConfigPath: session.configPath } : {}),
          mcpServers: (session?.servers ?? []).map((s) => s.name),
        });
        res.json({ ...result, spanSource, evidenceAgents: ctx.agents.length, evidenceSpans: ctx.recentSpans.length });
      } finally {
        session?.cleanup?.();
      }
    }),
  );

  app.get(
    "/api/projects/:id/insights/burn",
    withRuntime(async (rt, req, res) => {
      const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
      const buckets = Math.min(60, Math.max(2, Number(req.query.buckets) || 12));
      const series = await burnSeries(rt.info.name, { hours, buckets }).catch(() => null);
      // `budgetStatus` is what the caps are actually measured against — the
      // day's real spend per agent and whether it has run out. The bare
      // `budgets` map stays for the inputs that edit it.
      res.json({ burn: series, budgets: rt.budgets(), budgetStatus: rt.budgetStatus() });
    }),
  );

  // Turns off the log: the agent leaderboard, a per-day count for the
  // activity heatmap, and every turn as CSV.
  app.get(
    "/api/projects/:id/insights/turns",
    withRuntime(async (rt, req, res) => {
      const days = Math.min(366, Math.max(7, Number(req.query.days) || 84));
      const rows = turnRows(rt.log.list({ kinds: ["run_complete", "error"], limit: 50_000 }));
      // ?since= (ms) narrows the leaderboard to a window — "today", for loom stats
      const since = Number(req.query.since) || 0;
      const board = leaderboard(since ? rows.filter((r) => r.ts >= since) : rows);
      // your 👍/👎, beside what the log says
      const rated = rt.ratingsByAgent();
      // what Loom checked: Proof's verdicts, loops, shield trips — and what a "done" that held costs
      const trust = trustByAgent(rt.log.list({ kinds: ["proof", "status"], limit: 50_000, ...(since ? { sinceTs: since } : {}) }));
      res.json({
        leaderboard: board.map((a) => {
          const t = trust[a.agentId];
          return { ...a, ...(rated[a.agentId] ? { rated: rated[a.agentId] } : {}),
            ...(t ? { trust: { ...t, costPerVerifiedUsd: t.verified ? a.totalCostUsd / t.verified : null } } : {}) };
        }),
        days: perDay(rows, days), total: rows.length,
      });
    }),
  );
  app.get(
    "/api/projects/:id/insights/turns.csv",
    withRuntime(async (rt, _req, res) => {
      const rows = turnRows(rt.log.list({ kinds: ["run_complete", "error"], limit: 50_000 }));
      const safe = rt.info.name.replace(/[^\w.-]+/g, "-");
      res
        .type("text/csv")
        .setHeader("Content-Disposition", `attachment; filename="${safe}-turns.csv"`)
        .send(turnsCsv(rows));
    }),
  );
  app.get(
    "/api/projects/:id/insights/health",
    withRuntime(async (rt, req, res) => {
      const agent = req.query.agent ? String(req.query.agent) : undefined;
      let spans = await fetchSpans(rt.info.name, { agent, limit: 300 }).catch(() => [] as InsightSpan[]);
      let from: "backend" | "local-log" = "backend";
      if (!spans.length) {
        spans = insightSpansFromLog(rt.log.list({ limit: 500 }), agent);
        from = "local-log";
      }
      if (agent) return void res.json({ from, health: healthScore(spans) });
      // Fleet: one score per agent (its own turns/errors), plus the overall.
      const byAgent: Record<string, ReturnType<typeof healthScore>> = {};
      for (const a of [...new Set(spans.map((s) => s.agent).filter(Boolean))]) {
        byAgent[a] = healthScore(spans.filter((s) => s.agent === a));
      }
      res.json({ from, overall: healthScore(spans), byAgent });
    }),
  );

  // Budget CRUD for the burn-rate panel — per-agent USD/day, persisted in
  // state and enforced on every dispatch (see ProjectRuntime#enforceBudget).
  // `status` carries today's real spend against each cap, so the panel can
  // show how close an agent is instead of only what was typed in.
  app.get(
    "/api/projects/:id/budgets",
    withRuntime(async (rt, _req, res) => {
      res.json({ budgets: rt.budgets(), status: rt.budgetStatus() });
    }),
  );

  app.put(
    "/api/projects/:id/budgets/:agentId",
    withRuntime(async (rt, req, res) => {
      const usd = Number((req.body as Record<string, unknown>)?.usdPerDay ?? 0);
      const budgets = rt.setBudget(String(req.params.agentId ?? ""), usd);
      res.json({ budgets, status: rt.budgetStatus() });
    }),
  );
}
