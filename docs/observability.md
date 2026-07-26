# Observability — Loom over OpenTelemetry

Loom ships its agent activity as **all three OpenTelemetry signals — traces,
metrics and logs**. Every turn, tool call, baton handoff, route step and memory
fold your agents produce becomes a span; the same events are folded into
counters and histograms; and every agent message, tool call, edit, decision and
error is also emitted as a log record correlated to the span it happened inside.
You get the whole fleet in one place: latency, cost, token usage, error rates,
the critical path across agents — and, from a slow span, the log lines saying
what the agent was actually doing while it was slow.

**Backend-agnostic by construction.** Loom speaks OTLP/HTTP and nothing else, so
it works against anything with a `/v1/{traces,metrics,logs}` endpoint: the
OpenTelemetry Collector, Grafana/Tempo, Jaeger, SigNoz, Honeycomb, Datadog's
OTLP intake. Loom has no vendor SDK and no vendor-specific code path — point
`OTEL_EXPORTER_OTLP_ENDPOINT` at your collector and it works.

## How it works

Loom's daemon is already a stream of `LoomEvent`s. The observability layer
(`src/observability/`) folds the notable ones into each signal and exports them
over **OTLP/HTTP (JSON)** — no OpenTelemetry SDK dependency, just `fetch`.
Egress is best-effort: if no collector is reachable the POST fails silently and
never touches the agent loop.

| Signal | Endpoint | Module |
|---|---|---|
| Traces | `/v1/traces` | `src/observability/otlp.ts` |
| Metrics | `/v1/metrics` | `src/observability/metrics.ts` |
| Logs | `/v1/logs` | `src/observability/logs.ts` |

All three carry the same `service.name`, `service.namespace = loom` resource
block — a backend keys a service off `service.name`, and a mismatch is what
makes a trace and its own logs look like two different apps.

Event → span mapping (using the OpenTelemetry [GenAI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where they
apply):

| LoomEvent | Span | Key attributes |
|---|---|---|
| `run_complete` | `gen_ai.agent.turn` | `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cost_usd`, duration |
| `tool_call` | `gen_ai.tool.call` | `gen_ai.tool.name` |
| `handoff` | `loom.baton.handoff` | `loom.handoff.from`, `loom.handoff.to` |
| `route_*` | `loom.route.<phase>` | `loom.route.id` |
| `memory_add/update/forget` | `loom.memory.<op>` | `loom.memory.kind`, `loom.memory.scope` |
| `error` | `loom.error` (ERROR status) | message |

Every span carries `service.name = loom`, plus `loom.project` and `loom.chat`
so you can slice by project and conversation. One trace per turn: it is minted
at the turn boundary rather than off a `turn_started` status only some adapters
emit, so the span tree is right for the whole roster.

### Metrics emitted

Six, all delta temporality — the daemon restarts whenever you edit a config or
upgrade the CLI, which is the case cumulative handles worst.

| Metric | Unit | What it counts |
|---|---|---|
| `gen_ai.client.token.usage` | `{token}` | Tokens an agent turn consumed, split by `gen_ai.token.type` (`input`/`output`) |
| `gen_ai.client.operation.duration` | `s` | Turn duration (histogram, as the convention specifies) |
| `loom.turns` | `{turn}` | Turns that reached completion, by outcome |
| `loom.cost.usd` | `USD` | Money an adapter *reported* spending on a turn |
| `loom.agents.active` | `{agent}` | Agents currently executing a turn |
| `loom.handoffs` | `{handoff}` | Baton handoffs between agents |

These same six names are the default set the Observatory's metric explorer
queries when a caller names none (`LOOM_METRIC_NAMES` in
`src/observability/insights.ts` — a constant in the code, not a knob).

`gen_ai.client.token.usage` deviates from the convention on purpose: it is a
monotonic sum rather than a histogram, because Loom reports exactly one
input/output pair per turn and the question anyone asks is "how many tokens did
this agent burn today", which a sum answers exactly.

**Nothing emits a zero to keep a chart's line alive.** A flat zero and "nothing
happened" look identical on a graph and only one of them is true. The same rule
governs cost: an adapter that reports tokens but no dollar figure (codex does
exactly this) produces token datapoints and *no* cost datapoint, rather than a
cost of 0 — zeros are indistinguishable from real cheap turns once summed, and
the total then reads as authoritative.

### Logs emitted

Every agent message, tool call, file edit, decision, route step, budget pause
and error becomes one OTLP log record. When the event happened inside a turn it
carries that turn's `traceId`/`spanId`, so the trace view gets a working
"related logs" tab. Severity is mapped without inflation: an agent speaking is
INFO, a failed turn is ERROR, something a human must look at but that isn't a
failure (blocked on input, over budget, a suggested handoff) is WARN, adapter
lifecycle chatter is DEBUG. Nothing is FATAL.

## Point it at your collector

Nothing to configure for a local collector — Loom exports to
`http://localhost:4318` out of the box. To target another one, set environment
variables before starting the daemon:

```bash
# a collector on another host
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"

# a hosted backend that wants an ingestion key — any header name it asks for
export OTEL_EXPORTER_OTLP_HEADERS="signoz-access-token=<key>"
# or, for a different vendor:
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<key>"

# optional: rename the service
export LOOM_SERVICE_NAME="loom"
```

The ingestion key rides in through the standard `OTEL_EXPORTER_OTLP_HEADERS`
(`k=v,k2=v2`) rather than a per-vendor variable, so a new destination is a
config change and never a code change.

## Turn it off

Consent is not per-signal — any of these kills all three:

```bash
export DO_NOT_TRACK=1               # or
export LOOM_TELEMETRY_DISABLED=1    # or
export LOOM_OTEL=0
```

## Every environment variable

Resolved in `resolveTelemetryConfig` (`src/observability/otlp.ts`) unless noted.

| Variable | Default | What it does |
|---|---|---|
| `LOOM_OTEL_ENDPOINT` | `http://localhost:4318` | Collector base URL. `OTEL_EXPORTER_OTLP_ENDPOINT` is the fallback. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Standard `k=v,k2=v2` headers, for whatever ingestion key your backend wants. |
| `LOOM_SERVICE_NAME` | `loom` | `service.name` on all three signals. `OTEL_SERVICE_NAME` is the fallback. Also what the read-back queries filter on, so emit and read-back can't disagree. |
| `DO_NOT_TRACK` | — | Any truthy value disables **all** telemetry. |
| `LOOM_TELEMETRY_DISABLED` | — | Same, Loom-specific. |
| `LOOM_OTEL` | — | `0` disables all telemetry. |
| `LOOM_OTEL_METRICS` | on | `0` turns off the metrics exporter only; traces and logs keep going. |
| `LOOM_OTEL_LOGS` | on | `0` turns off the logs exporter only. Volume control — Loom ships every agent message as a log record, which is the point, and also a lot of bytes. |

### Reading telemetry back

The Observatory reads spans, metrics and logs back out of the backend's store to
render Span Replay, the trace waterfall, burn rate and the Logs view. That
requires a ClickHouse-backed store; the physical table names default to the
layout an OTLP collector writes and are overridable for a backend that lays them
out differently.

| Variable | Default | What it does |
|---|---|---|
| `LOOM_CLICKHOUSE_URL` | `http://localhost:8123` | Where to query the telemetry store. |
| `LOOM_SPAN_TABLE` | `signoz_traces.distributed_signoz_index_v3` | The span index. |
| `LOOM_LOG_TABLE` | *(collector default)* | The log table. |
| `LOOM_METRIC_SAMPLES_TABLE` / `LOOM_METRIC_SERIES_TABLE` | *(collector defaults)* | The metric tables. |
| `LOOM_TRACE_UI_URL` | — | Your backend's own UI, for the trace deep links. Unset means the links hide themselves rather than pointing at a guessed port. |

Read-back is optional. With no store reachable, the panels that can fall back to
the local event log do (Span Replay, triage, burn rate); the Logs view says so
instead, because a log record's severity and trace correlation only exist once
it has been shipped, and reconstructing something log-shaped from the event log
would be inventing the correlation that is the whole point.

These steer the LLM-backed read-back features, and exist so those paths can be
made deterministic:

| Variable | Default | What it does |
|---|---|---|
| `LOOM_TRIAGE_NO_LLM` | — | `1` makes triage skip the model entirely and return the deterministic heuristic. `src/observability/triage.ts` |
| `LOOM_DECISION_MODEL` | `claude-haiku-4-5-20251001` | The model used to extract decisions from a turn's output. `src/observability/decisions.ts` |
| `LOOM_DECISIONS_NO_CLI` | — | `1` stops decision extraction from shelling out to a signed-in CLI when there's no `ANTHROPIC_API_KEY`; it falls through to the regex extractor. `src/observability/decisions.ts` |

The classification and evidence behind triage are deterministic either way; only
the prose is model-written.

## Self-heal

Loom accepts alerts back from your monitoring at `POST /api/webhooks/alerts`, in
the Alertmanager-shaped payload SigNoz, Prometheus and Grafana all send. A
firing alert takes the named agent out of rotation — it is refused the baton
until the alert resolves — and a resolved one puts it back.

This is the part a dashboard cannot show you: it knows the alert fired, only
Loom knows the fleet reacted. The Observatory's Self-heal view is built from
Loom's own event log rather than the backend's API, so it still answers when the
backend is down — which is exactly the moment you want to know which agents are
still paused.

| Variable | Default | What it does |
|---|---|---|
| `LOOM_WEBHOOK_SECRET` | — | Shared secret the webhook requires, when set. |
| `LOOM_HEAL_DISABLED` | — | `1` accepts alerts but never acts on them. |
| `LOOM_HEAL_MAX_RETRIES` | — | How many times a recovered agent is retried. |
| `LOOM_HEAL_RECHECK_MS` | — | How long before a quarantined agent is re-examined. |

## Verify it's flowing

Run a turn, then look for the `loom` service in your backend, or query the
store directly:

```sql
SELECT name, count()
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = 'loom' AND timestamp > now() - INTERVAL 15 MINUTE
GROUP BY name;
```

## Test it

The exporter and the event→span mapping are covered end to end:

```bash
npm test -- observability          # unit: config, mapper, OTLP payload shape
npm test -- observability-export   # integration: a stand-in OTLP collector
                                   # receives real spans from daemon turns
```

The integration test stands up a real HTTP server, points the daemon at it, runs
real turns and asserts on the OTLP payloads that arrive — so "it exports" is a
measured claim rather than a mocked one.
