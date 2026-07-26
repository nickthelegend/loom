/**
 * Loom → OpenTelemetry metrics (OTLP/HTTP JSON, `/v1/metrics`).
 *
 * Same shape as the trace exporter next door: aggregate in memory, flush on a
 * short timer, POST, never throw. What differs is that a metric is a fold, not
 * an event — several turns collapse into one datapoint — so this holds a small
 * aggregation table keyed by metric name + attribute set instead of a list.
 *
 * Every number here is derived from a LoomEvent that actually happened. There
 * is no periodic "emit 0 so the chart has a line" path, because a flat zero and
 * "nothing happened" look identical on a graph and only one of them is true.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 * `gen_ai.*` names and attributes follow the OpenTelemetry GenAI semantic
 * conventions (semantic-conventions-genai, the GenAI metrics doc split out of
 * the main semconv repo): `gen_ai.client.token.usage` with a
 * `gen_ai.token.type` of `input`/`output`, `gen_ai.client.operation.duration`
 * in seconds, dimensioned by `gen_ai.operation.name`, `gen_ai.system` and
 * `gen_ai.request.model`. `loom.*` names are ours — nothing in the convention
 * covers batons, routes or a per-agent daily spend cap — and follow its style.
 *
 * One deliberate deviation: the convention models `gen_ai.client.token.usage`
 * as a *histogram* (a distribution of tokens-per-request). Loom emits it as a
 * monotonic sum. A histogram earns its keep when you want percentiles over many
 * requests; Loom reports exactly one input/output pair per turn, and what
 * anyone asks this data is "how many tokens did this agent burn today" — a sum
 * answers that exactly, and a histogram's `sum` field only approximates it once
 * you start dropping buckets. `gen_ai.client.operation.duration` stays a
 * histogram, as specified, because turn latency genuinely is a distribution.
 *
 * ── Temporality ─────────────────────────────────────────────────────────────
 * Delta, everywhere (AGGREGATION_TEMPORALITY_DELTA). Cumulative asks the
 * *client* to remember every counter's running total for the life of the
 * process and expects the backend to detect resets. Loom's daemon restarts
 * whenever you edit a config or upgrade the CLI, so cumulative would mean a
 * counter reset every few minutes — the exact case cumulative handles worst.
 * Delta makes each export self-contained: what happened since the last flush,
 * nothing remembered, nothing to reset. Collectors accept both.
 */

import {
  encodeAttributes,
  postOtlp,
  resourceAttributes,
  type AttrValue,
  type KeyValue,
  type TelemetryConfig,
} from "./otlp.js";

/** OTLP AggregationTemporality. 1 = CUMULATIVE, 2 = DELTA. See the header. */
const TEMPORALITY_DELTA = 2;

/** Flush window, matched to the trace exporter's so signals land together. */
const FLUSH_MS = 1500;

/** Hard cap on distinct series held between flushes; see `guardCardinality`. */
const MAX_SERIES = 512;

/**
 * Bucket boundaries for `gen_ai.client.operation.duration`, in seconds, as
 * specified by the GenAI metrics convention. Kept verbatim rather than tuned:
 * matching the convention is what lets a GenAI dashboard built for any
 * other instrumented service read Loom's turns too.
 */
const DURATION_BUCKETS_S = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

export type MetricAttributes = Record<string, AttrValue>;

/** A monotonic counter's accumulated delta for one attribute set. */
type SumSeries = { kind: "sum"; attributes: KeyValue[]; value: number; isInt: boolean };

/** A histogram's accumulated delta for one attribute set. */
type HistogramSeries = {
  kind: "histogram";
  attributes: KeyValue[];
  bounds: number[];
  counts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
};

/**
 * A gauge observation. Unlike the other two this is not accumulated — it is the
 * last value we actually observed, carried with the timestamp we observed it,
 * so the exported point is a real reading rather than a flush-time guess.
 */
type GaugeSeries = { kind: "gauge"; attributes: KeyValue[]; value: number; observedNs: bigint };

type Series = SumSeries | HistogramSeries | GaugeSeries;

/** Everything a caller needs to describe one metric. */
type MetricMeta = { unit: string; description: string };

const META: Record<string, MetricMeta> = {
  "gen_ai.client.token.usage": { unit: "{token}", description: "Tokens consumed by an agent turn, by token type." },
  "gen_ai.client.operation.duration": { unit: "s", description: "Duration of a completed agent turn." },
  "loom.turns": { unit: "{turn}", description: "Agent turns that reached completion, by outcome." },
  "loom.cost.usd": { unit: "USD", description: "Money an adapter reported spending on a turn." },
  "loom.agents.active": { unit: "{agent}", description: "Agents currently executing a turn." },
  "loom.handoffs": { unit: "{handoff}", description: "Baton handoffs between agents." },
};

export class LoomMetrics {
  private series = new Map<string, Map<string, Series>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly metricsUrl: string;
  private readonly resource: KeyValue[];
  /**
   * Start of the current delta window. A delta datapoint's
   * `startTimeUnixNano`..`timeUnixNano` must bracket exactly the interval the
   * value accumulated over, and consecutive windows must not overlap — so this
   * advances to the previous flush's end rather than being re-read from the
   * clock each time.
   */
  private windowStartNs: bigint;

  constructor(private readonly cfg: TelemetryConfig) {
    this.metricsUrl = `${cfg.endpoint}/v1/metrics`;
    this.resource = resourceAttributes(cfg);
    this.windowStartNs = nowNs();
  }

  get enabled(): boolean {
    return this.cfg.metricsEnabled && typeof globalThis.fetch === "function";
  }

  /** Add to a monotonic counter. Negative or non-finite deltas are ignored. */
  addCount(name: string, value: number, attributes: MetricAttributes, isInt = true): void {
    if (!this.enabled || !Number.isFinite(value) || value < 0) return;
    const bag = this.bag(name);
    const attrs = encodeAttributes(attributes);
    const key = seriesKey(attrs);
    const existing = bag.get(key);
    if (existing?.kind === "sum") existing.value += value;
    else if (this.guardCardinality(bag)) bag.set(key, { kind: "sum", attributes: attrs, value, isInt });
    this.ensureTimer();
  }

  /** Record one observation into a histogram. */
  record(name: string, value: number, attributes: MetricAttributes, bounds = DURATION_BUCKETS_S): void {
    if (!this.enabled || !Number.isFinite(value) || value < 0) return;
    const bag = this.bag(name);
    const attrs = encodeAttributes(attributes);
    const key = seriesKey(attrs);
    let s = bag.get(key);
    if (s?.kind !== "histogram") {
      if (!this.guardCardinality(bag)) return;
      s = {
        kind: "histogram",
        attributes: attrs,
        bounds,
        // One bucket per boundary plus the +Inf overflow bucket — OTLP requires
        // bucketCounts.length === explicitBounds.length + 1.
        counts: new Array(bounds.length + 1).fill(0),
        count: 0,
        sum: 0,
        min: value,
        max: value,
      };
      bag.set(key, s);
    }
    let i = 0;
    while (i < s.bounds.length && value > s.bounds[i]!) i++;
    s.counts[i]! += 1;
    s.count += 1;
    s.sum += value;
    s.min = Math.min(s.min, value);
    s.max = Math.max(s.max, value);
    this.ensureTimer();
  }

  /** Observe a gauge's current value, as of now. */
  setGauge(name: string, value: number, attributes: MetricAttributes = {}): void {
    if (!this.enabled || !Number.isFinite(value)) return;
    const bag = this.bag(name);
    const attrs = encodeAttributes(attributes);
    const key = seriesKey(attrs);
    if (!bag.has(key) && !this.guardCardinality(bag)) return;
    bag.set(key, { kind: "gauge", attributes: attrs, value, observedNs: nowNs() });
    this.ensureTimer();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
  }

  /**
   * Build the OTLP payload for everything accumulated so far and clear the
   * window. Exported for tests: asserting on the JSON we would send beats
   * asserting on a mocked fetch, and the payload shape is the part a collector
   * actually rejects.
   */
  collect(nowOverrideNs?: bigint): Record<string, unknown> | null {
    if (this.series.size === 0) return null;
    const endNs = nowOverrideNs ?? nowNs();
    const startNs = this.windowStartNs;
    const metrics: Record<string, unknown>[] = [];
    for (const [name, bag] of this.series) {
      if (bag.size === 0) continue;
      const meta = META[name] ?? { unit: "1", description: "" };
      metrics.push({
        name,
        unit: meta.unit,
        description: meta.description,
        ...body([...bag.values()], startNs, endNs),
      });
    }
    this.series.clear();
    this.windowStartNs = endNs;
    if (metrics.length === 0) return null;
    return {
      resourceMetrics: [
        {
          resource: { attributes: this.resource },
          scopeMetrics: [{ scope: { name: "loom" }, metrics }],
        },
      ],
    };
  }

  private bag(name: string): Map<string, Series> {
    let b = this.series.get(name);
    if (!b) this.series.set(name, (b = new Map()));
    return b;
  }

  /**
   * Refuse to open a new series past the cap.
   *
   * Metric attributes come from agent ids and model names, which are bounded in
   * practice — but a misbehaving adapter reporting a unique model string per
   * turn would otherwise turn this map into an unbounded leak and the backend's
   * index into a mess. Dropping the *new* series keeps the ones already being
   * measured intact and correct; the alternative (evicting) would silently
   * discard counts that were already recorded.
   */
  private guardCardinality(bag: Map<string, Series>): boolean {
    return bag.size < MAX_SERIES;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, FLUSH_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private drain(): void {
    const payload = this.collect();
    if (!payload) return;
    postOtlp(this.metricsUrl, this.cfg.headers, payload);
  }
}

/** The `sum` / `histogram` / `gauge` body for one metric's worth of series. */
function body(all: Series[], startNs: bigint, endNs: bigint): Record<string, unknown> {
  const start = startNs.toString();
  const time = endNs.toString();
  const first = all[0]!;
  if (first.kind === "gauge") {
    // No temporality and no start time on a gauge: it is a reading, not an
    // interval. The timestamp is when we actually observed it.
    return {
      gauge: {
        dataPoints: all
          .filter((s): s is GaugeSeries => s.kind === "gauge")
          .map((s) => ({
            attributes: s.attributes,
            timeUnixNano: s.observedNs.toString(),
            ...numeric(s.value, true),
          })),
      },
    };
  }
  if (first.kind === "histogram") {
    return {
      histogram: {
        aggregationTemporality: TEMPORALITY_DELTA,
        dataPoints: all
          .filter((s): s is HistogramSeries => s.kind === "histogram")
          .map((s) => ({
            attributes: s.attributes,
            startTimeUnixNano: start,
            timeUnixNano: time,
            count: String(s.count),
            sum: s.sum,
            bucketCounts: s.counts.map(String),
            explicitBounds: s.bounds,
            min: s.min,
            max: s.max,
          })),
      },
    };
  }
  return {
    sum: {
      aggregationTemporality: TEMPORALITY_DELTA,
      // Every counter Loom emits only ever goes up within a window — turns
      // completed, tokens spent, dollars burned, batons passed. None of them
      // can be undone, so isMonotonic is the truth and lets a backend offer rate().
      isMonotonic: true,
      dataPoints: all
        .filter((s): s is SumSeries => s.kind === "sum")
        .map((s) => ({
          attributes: s.attributes,
          startTimeUnixNano: start,
          timeUnixNano: time,
          ...numeric(s.value, s.isInt),
        })),
    },
  };
}

/**
 * `asInt` (int64, string-encoded per the proto3 JSON mapping) or `asDouble`.
 * Counts are integers; money and seconds are not, and rounding either to an int
 * would report $0 for a real three-cent turn.
 */
function numeric(value: number, isInt: boolean): Record<string, unknown> {
  return isInt ? { asInt: String(Math.round(value)) } : { asDouble: value };
}

/** Stable identity for an attribute set, so repeat observations coalesce. */
function seriesKey(attrs: KeyValue[]): string {
  return attrs
    .map((a) => `${a.key}=${Object.values(a.value)[0]}`)
    .sort()
    .join("");
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}
