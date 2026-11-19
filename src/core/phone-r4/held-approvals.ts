/** Keep held pushes until quiet ends, but never send a settled/expired request. */
export class HeldApprovals {
  private entries = new Map<string, { pending: () => boolean; permitted: () => boolean; send: () => Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  hold(key: string, entry: { pending: () => boolean; permitted: () => boolean; send: () => Promise<void> }) {
    this.entries.set(key, entry);
    this.timer ??= setInterval(() => { void this.flush(); }, 1000);
    this.timer.unref();
  }
  async flush() {
    for (const [key, entry] of this.entries) {
      if (!entry.pending()) this.entries.delete(key);
      else if (entry.permitted()) { this.entries.delete(key); await entry.send(); }
    }
    if (!this.entries.size) { clearInterval(this.timer); this.timer = undefined; }
  }
}
export const heldApprovals = new HeldApprovals();
let pending: (project: string, id: string) => boolean = () => false;
let onHeld: (project: string, id: string) => void = () => {};
export function registerPendingApprovals(check: typeof pending, record: typeof onHeld) { pending = check; onHeld = record; }
export const approvalPending = (project: string, id: string) => pending(project, id);

const heldHistory = new Map<string, number>();
export function recordHeldApproval(project: string, id: string) {
  for (const [key, at] of heldHistory) if (at < Date.now() - 86400000) heldHistory.delete(key);
  if (!heldHistory.has(`${project}:${id}`)) onHeld(project, id);
  heldHistory.set(`${project}:${id}`, Date.now());
}
export const wasApprovalHeld = (project: string, id: string) => heldHistory.has(`${project}:${id}`);
