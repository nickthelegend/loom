export interface ToolMetric { name: string; calls: number; failures: number; failureRate: number | null; averageMs: number | null }
export interface FailureGroup { error: string; count: number; lastSeen: number; examples: Array<{ eventId: number; chat: string; agent: string }> }
export interface Hours { timezone: string; totalMs: number; entries: Array<{ project: string; agent: string; day: string; activeMs: number }> }
export interface Rule { id: string; expression: string; paused: boolean; firing: boolean }
export interface PhoneInsights { tools: { byTool: ToolMetric[]; byAgent: ToolMetric[] }; errors: FailureGroup[]; hours: Hours }
export function toolLine(row: ToolMetric): string { return `${row.name}: ${row.calls} calls · ${row.failureRate === null ? 'outcomes unknown' : row.failureRate.toFixed(1) + '% failed'} · ${row.averageMs === null ? 'duration unmeasured' : row.averageMs.toFixed(1) + ' ms average'}`; }
export function hoursSummary(hours: Hours): string { return `${(hours.totalMs / 3_600_000).toFixed(2)} active agent hours · ${hours.timezone}`; }
export function alertState(rule: Rule): string { return rule.paused ? 'paused' : rule.firing ? 'firing' : 'watching'; }

export function examplePath(project: string, eventId: number): string { return `/api/projects/${encodeURIComponent(project)}/events/query?id=${eventId}`; }
