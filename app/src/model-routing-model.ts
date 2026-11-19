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
