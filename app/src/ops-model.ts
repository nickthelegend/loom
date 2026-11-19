export interface ProjectOps {
  metrics: { turns: number; costUsd: number; errors: number; queueDepth: number };
  disk: { worktrees: number; logs: number; attachments: number; total: number; skipped: string[] };
  stale: Array<{ agentId: string; busyMs: number }>;
  policy: { days: number; keep: number };
}
export interface MachineOps {
  backup: { every: string; keep: number; nextAt: number; lastAt?: number; error?: string } | null;
  log: { cap: number; bytes: number; rotatedBytes: number };
  crashes: string[];
}
export const projectOpsPath = (id: string, suffix = "ops") => `/api/projects/${encodeURIComponent(id)}/${suffix}`;
export const staleReapPath = (id: string, agent: string) => projectOpsPath(id, `stale/${encodeURIComponent(agent)}/reap`);
export const opsBytes = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
export function policyInput(days: string, keep: string) {
  const d = Number(days), k = Number(keep);
  if (!days.trim() || !keep.trim() || !Number.isFinite(d) || d < 0 || d > 36500 || !Number.isInteger(k) || k < 0 || k > 10000) throw new Error("Enter days 0–36500 and a whole number of runs 0–10000");
  return { days: d, keep: k };
}

export interface OpsActionResult {
  fixed?: string[];
  unfixable?: string[];
  summary?: { failures: number };
  backup?: MachineOps["backup"];
  policy?: ProjectOps["policy"];
  dryRun?: boolean;
  candidates?: string[];
  removed?: string[];
  skipped?: Array<{ id: string; reason: string }>;
  respawned?: boolean;
  disk?: ProjectOps["disk"];
}
export function opsActionText(r: OpsActionResult): string {
  if (r.fixed) return [r.fixed.length ? r.fixed.map(s => 'Fixed: ' + s).join('\n') : 'No repairs needed.', ...(r.unfixable || []).map(s => 'Needs attention: ' + s), r.summary ? 'Remaining failing checks: ' + r.summary.failures : ''].filter(Boolean).join('\n');
  if ('backup' in r) return r.backup ? 'Backups every ' + r.backup.every + '; keeping ' + r.backup.keep + '. Next: ' + new Date(r.backup.nextAt).toLocaleString() : 'Backup schedule disabled.';
  if (r.disk) return 'Report refreshed.';
  if (r.policy) return 'Saved worktree policy: ' + r.policy.days + ' days, at most ' + r.policy.keep + ' finished runs.';
  if (r.candidates) return [r.dryRun ? 'Dry run: ' + r.candidates.length + ' run' + (r.candidates.length === 1 ? '' : 's') + ' would be pruned.' : 'Pruned ' + (r.removed || []).length + ' runs.', (r.dryRun ? r.candidates : r.removed || []).join(', '), ...(r.skipped || []).map(s => 'Kept ' + s.id + ': ' + s.reason)].filter(Boolean).join('\n');
  if (r.respawned) return 'Session reaped and restarted.';
  return JSON.stringify(r, null, 2);
}
