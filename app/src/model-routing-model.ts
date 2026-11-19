export interface ModelEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  usage: { warning: boolean; stopped: boolean } | null;
}
export function estimateLabel(e: ModelEstimate): string {
  return `~${e.inputTokens} input tokens · ${e.usd == null ? "price unavailable" : `~$${e.usd.toFixed(4)}`}` +
    (e.usage?.stopped ? " · Daily cap reached" : e.usage?.warning ? " · 80% of daily cap used" : "");
}
export function parseAgentRouting(extraArgs: string, fallbacks: string, effort: string) {
  const array = (text: string, name: string): string[] => {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some(v => typeof v !== "string" || /[\0\r\n]/.test(v))) throw new Error(`${name} must be a JSON array of strings without NUL or newlines`);
    return value;
  };
  return { extraArgs: array(extraArgs, "Extra arguments"), fallbacks: array(fallbacks, "Fallback models"), effort };
}

export function costMoney(value: number | null | undefined): string {
  return value == null ? "unknown" : `$${value.toFixed(4)}`;
}
export function cacheSavingsLabel(row: { cachedIn: number; tokensIn: number; cacheSavedUsd?: number | null }): string {
  return `${row.tokensIn ? Math.round(Math.min(row.cachedIn, row.tokensIn) / row.tokensIn * 100) : 0}% cached · ${costMoney(row.cacheSavedUsd)} saved at API prices`;
}
export function costBudgetLabel(row: { spentUsd: number; capUsd: number; projectedUsd?: number; stopped: boolean; warning: boolean }): string {
  return `${costMoney(row.spentUsd)} / ${row.capUsd ? costMoney(row.capUsd) : "no cap"}${row.projectedUsd === undefined ? "" : ` · projected ${costMoney(row.projectedUsd)}`}${row.stopped ? " · Needs you: raise cap" : row.warning ? " · 80% used" : ""}`;
}
