/**
 * Pre-flight forecast: what a turn on this agent usually costs and takes,
 * before you send it.
 *
 * Read from the agent's own recent turns, not a price list — a CLI on a
 * subscription reports no dollars and gets a time-only forecast, a model
 * agent's spend is what it actually spent here. "Typical" is the median and
 * "high" the 80th percentile, so one marathon turn doesn't move the number.
 * With a daily budget set, it says when one more high turn could cross it.
 */

export interface Forecast {
  /** How many recent turns it's read from. */
  turns: number;
  ms: { typical: number; high: number };
  /** Absent when the agent reports no spend (a CLI on a subscription). */
  usd?: { typical: number; high: number };
  budget?: { capUsd: number; spentUsd: number; mayCross: boolean };
}

/** The fewest turns a forecast is honest from. */
export const FORECAST_MIN_TURNS = 3;
/** How many recent turns it remembers per agent. */
export const FORECAST_WINDOW = 30;

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

export function forecastFrom(costs: number[], durations: number[], budget?: { capUsd: number; spentUsd: number }): Forecast | null {
  const ms = durations.filter((x) => Number.isFinite(x) && x > 0);
  if (ms.length < FORECAST_MIN_TURNS) return null;
  const usd = costs.filter((x) => Number.isFinite(x) && x > 0);
  const out: Forecast = { turns: ms.length, ms: { typical: Math.round(quantile(ms, 0.5)), high: Math.round(quantile(ms, 0.8)) } };
  if (usd.length >= FORECAST_MIN_TURNS) out.usd = { typical: round(quantile(usd, 0.5)), high: round(quantile(usd, 0.8)) };
  if (budget && budget.capUsd > 0) {
    const high = out.usd?.high ?? 0;
    out.budget = { capUsd: budget.capUsd, spentUsd: round(budget.spentUsd), mayCross: budget.spentUsd + high >= budget.capUsd };
  }
  return out;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/** A fixed-size record of the latest values. */
export class Recent {
  private xs: number[] = [];
  constructor(private readonly size = FORECAST_WINDOW) {}
  push(x: number): void { this.xs.push(x); if (this.xs.length > this.size) this.xs.shift(); }
  values(): number[] { return this.xs; }
}
