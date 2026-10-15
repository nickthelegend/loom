/**
 * Pre-flight forecast on the phone: what a turn on the agent you're about to
 * message usually costs and takes (the daemon's `forecast`, read from that
 * agent's own recent turns) — the desktop composer's chip, as one line.
 */

export interface Forecast {
  turns: number;
  ms: { typical: number; high: number };
  usd?: { typical: number; high: number };
  budget?: { capUsd: number; spentUsd: number; mayCross: boolean };
}

export function approxTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return m < 10 && r ? `${m}m ${r}s` : `${m}m`;
}

export function money(n: number): string {
  if (n < 0.00005) return "$0";
  return `$${n >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** The line under the composer, or null when there's nothing honest to say yet. */
export function forecastLine(f: Forecast | undefined | null): { text: string; warn: boolean } | null {
  if (!f || !f.ms || !(f.turns > 0)) return null;
  const cost = f.usd ? `~${money(f.usd.typical)} · ` : "~";
  let text = `${cost}${approxTime(f.ms.typical)} a turn, from its last ${f.turns}`;
  const warn = Boolean(f.budget?.mayCross);
  if (f.budget) text += ` · ${money(f.budget.spentUsd)} of ${money(f.budget.capUsd)} today${warn ? " — one more long turn could cross it" : ""}`;
  return { text, warn };
}
