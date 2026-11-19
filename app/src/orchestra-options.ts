export interface RunOptions {
  maxUsd?: number;
  planOnly?: boolean;
  stallMinutes?: number;
  kindLimits?: Record<string, number>;
  webhookUrl?: string;
}

export function parseRunOptions(budget: string, stall: string, limits: string, webhook: string, planOnly: boolean): RunOptions {
  const positive = (value: string, name: string) => {
    if (!value.trim()) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive`);
    return n;
  };
  const kindLimits: Record<string, number> = {};
  for (const row of limits.split(",").map(s => s.trim()).filter(Boolean)) {
    const [kind, value, extra] = row.split("=");
    const n = Number(value);
    if (!kind || !/^[a-z][a-z0-9-]*$/.test(kind) || extra !== undefined || !Number.isInteger(n) || n < 1 || n > 100) throw new Error("Use kind=count, e.g. echo=2");
    kindLimits[kind] = n;
  }
  return { maxUsd: positive(budget, "Budget"), stallMinutes: positive(stall, "Stall interval"), kindLimits,
    webhookUrl: webhook.trim() || undefined, planOnly };
}
