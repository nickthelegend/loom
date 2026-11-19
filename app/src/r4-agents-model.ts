export interface ChatLabel { name: string; color: string }
export interface SessionChat { id: string; title: string; archived?: boolean; labels?: ChatLabel[] }
export function filterSessionChats<T extends SessionChat>(chats: T[], archived: boolean, label: string, query = "", messageMatches: string[] = []): T[] {
  return chats.filter(c => Boolean(c.archived) === archived && (!label || c.labels?.some(l => l.name === label)) && (c.title.toLowerCase().includes(query.toLowerCase()) || messageMatches.includes(c.id)));
}
export function environmentEntry(text: string): { key: string; value: string } {
  const at = text.indexOf("=");
  if (at < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text.slice(0, at))) throw new Error("Use KEY=VALUE");
  return { key: text.slice(0, at), value: text.slice(at + 1) };
}
export function sessionState(agent: { asleep?: boolean; busy?: boolean }): string { return agent.busy ? "Working" : agent.asleep ? "Asleep" : "Ready"; }
export function retryNotice(events: Array<{ id: number; kind: string; agentId?: string; payload: Record<string, unknown> }>): string | null {
  const retry = [...events].reverse().find(e => e.payload.state === "turn_retry");
  if (!retry || events.some(e => e.id > retry.id && e.agentId === retry.agentId &&
    (e.kind === "run_complete" && !e.payload.retrying || e.kind === "error" && !e.payload.retrying || e.payload.state === "interrupted"))) return null;
  return String(retry.payload.text ?? "Retrying this turn");
}
export function policyInput(turn: string, sleep: string, count: string, wait: string) {
  const values = [turn, sleep, count, wait].map(Number);
  if (values.some(n => !Number.isFinite(n) || n < 0) || !Number.isInteger(values[2]) || values[2]! > 10 || values[3]! > 3600) throw new Error("Use nonnegative numbers; retries are a whole count from 0 to 10 and wait is at most 3600 seconds");
  return { maxTurnMinutes: values[0]!, idleSleepMinutes: values[1]!, retries: { count: values[2]!, waitSeconds: values[3]! } };
}
