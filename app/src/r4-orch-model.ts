export interface EditableTask { id: string; title: string; prompt: string; agent: string; dependsOn: string[]; model?: string; effort?: string }
export function editPlan(tasks: EditableTask[], index: number, operation: 'up' | 'down' | 'remove'): EditableTask[] {
  const next = tasks.map(t => ({ ...t, dependsOn: [...t.dependsOn] }));
  if (index < 0 || index >= next.length) return next;
  if (operation === 'remove') {
    const id = next.splice(index, 1)[0]!.id;
    return next.map(t => ({ ...t, dependsOn: t.dependsOn.filter(d => d !== id) }));
  }
  const other = operation === 'up' ? index - 1 : index + 1;
  if (other >= 0 && other < next.length) [next[index], next[other]] = [next[other]!, next[index]!];
  return next;
}
export function taskOptions(check: string, rounds: string, minutes: string) {
  const n = minutes.trim() ? Number(minutes) : undefined;
  const r = rounds.trim() ? Number(rounds) : undefined;
  if (n !== undefined && (!Number.isFinite(n) || n <= 0 || n > 10080)) throw new Error('Task minutes must be positive and at most 10080');
  if (r !== undefined && (!Number.isInteger(r) || r < 0 || r > 20)) throw new Error('Check rounds must be an integer from 0 to 20');
  return { check: check.trim() || undefined, checkRounds: r, taskMinutes: n };
}

export function heldActive(run: { status: string; held?: boolean }): boolean {
  return !!run.held && !["completed", "failed", "aborted", "moved"].includes(run.status);
}
