export interface ConfigValidation { valid: boolean; errors: Array<{ path: string; message: string }>; warnings: string[] }
export function configValidationText(result: ConfigValidation): string {
  return [result.valid ? ".loom/config.json is valid" : ".loom/config.json is invalid",
    ...result.errors.map(e => `${e.path}: ${e.message}`), ...result.warnings.map(w => `Warning: ${w}`)].join("\n");
}
export interface ModelStanding {
  key: string; turns: number; winRate: number | null; finishedRate: number | null; medianMs: number | null; avgCostUsd: number | null;
}
export function standingDetail(row: ModelStanding): string {
  const pct = (v: number | null) => v === null ? "—" : `${Math.round(v * 100)}%`;
  return `${row.turns} turns · wins ${pct(row.winRate)} · finishes ${pct(row.finishedRate)}\nMedian ${row.medianMs === null ? "—" : `${(row.medianMs / 1000).toFixed(1)}s`} · per turn ${row.avgCostUsd === null ? "—" : `$${row.avgCostUsd.toFixed(4)}`}`;
}
