import type { EventJournal } from '../events/contracts.js';
import type { LoomEvent } from '../../types.js';
import { EventInbox } from './projections.js';
import { dismissed } from './store.js';
import { fileStamp } from './paused.js';
import { projectLoomDir } from '../registry.js';
import path from 'node:path';

const AGE = 14 * 24 * 60 * 60 * 1000;
const kinds: LoomEvent['kind'][] = ['needs_input', 'status', 'run_complete', 'error', 'message'];
type Chat = {
  lastText?: string;
  lastTextAt?: number;
  starts: Map<string, number>;
  workers: Map<string, LoomEvent>;
  costs: Array<{ at: number; usd: number }>;
};
/** One bounded bootstrap per loaded log; subsequent events update projections without SQL. */
export class LiveWorkspace {
  readonly inbox = new EventInbox();
  readonly chats = new Map<string, Chat>();
  lastId = 0;
  private dismissedMtime = '';
  private hidden = new Set<number>();
  constructor(log: EventJournal) {
    for (const e of log.list({ kinds, sinceTs: Date.now() - AGE, limit: 2000, allBranches: false })) this.update(e);
    this.lastId = log.lastId();
    log.onEvent(e => this.update(e)); // EventLog.close removes subscriptions with its runtime.
  }
  private update(e: LoomEvent) {
    this.lastId = e.id;
    this.inbox.update(e);
    const chat = e.chat ?? 'main';
    let row = this.chats.get(chat);
    if (!row) { row = { starts: new Map(), workers: new Map(), costs: [] }; this.chats.set(chat, row); }
    const p = e.payload;
    if (typeof p.text === 'string') { row.lastText = p.text.trim().split('\n').filter(Boolean).at(-1)?.slice(-300); row.lastTextAt = e.ts; }
    if (e.agentId) {
      if (p.orchestra || p.crew) { row.workers.delete(e.agentId); row.workers.set(e.agentId, e); }
      if (p.state === 'turn_started' || p.state === 'started') row.starts.set(e.agentId, e.ts);
    }
    if (p.state === 'turn_cost' && Number.isFinite(p.costUsd)) row.costs.push({ at: e.ts, usd: Number(p.costUsd) });
    row.costs = row.costs.filter(c => c.at >= Date.now() - AGE);
  }
  items(dir: string) {
    const stamp = fileStamp(path.join(projectLoomDir(dir), 'workspace-r4-dismissed.json'));
    if (stamp !== this.dismissedMtime) { this.hidden = new Set(dismissed(dir)); this.dismissedMtime = stamp; }
    return this.inbox.items(this.hidden, Date.now() - AGE);
  }
}
const projections = new WeakMap<EventJournal, LiveWorkspace>();
export function liveWorkspace(log: EventJournal) {
  let view = projections.get(log);
  if (!view) { view = new LiveWorkspace(log); projections.set(log, view); }
  return view;
}
