import fs from 'node:fs';
import path from 'node:path';
import type { OrchestraRun } from '../orchestra.js';
import type { CrewState } from '../crew.js';
import { projectLoomDir, readProjectState } from '../registry.js';
import type { QueueState } from '../prompt-queue.js';

export function fileStamp(file: string): string {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; } catch { return 'missing'; }
}
function json<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } }
const directories = new Map<string, { stamp: string; value: unknown[] }>();
function directory<T>(dir: string): T[] {
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { files = []; }
  // Include file stamps: an in-place state update need not change the directory mtime.
  const stamp = fileStamp(dir) + files.map(f => f + ':' + fileStamp(path.join(dir, f))).join('|');
  const old = directories.get(dir);
  if (old?.stamp === stamp) return old.value as T[];
  const value = files.flatMap(f => { const v = json<T | null>(path.join(dir, f), null); return v ? [v] : []; });
  directories.set(dir, { stamp, value });
  return value;
}
const states = new Map<string, { stamp: string; route: ReturnType<typeof readProjectState>['route']; queue: QueueState }>();
/** Preserve paused metadata without opening dormant event logs or starting adapters. */
export function dormantState(dir: string) {
  const base = projectLoomDir(dir), stateFile = path.join(base, 'state.json'), queueFile = path.join(base, 'queue.json');
  const stamp = fileStamp(stateFile) + '|' + fileStamp(queueFile);
  let cached = states.get(dir);
  if (!cached || cached.stamp !== stamp) {
    cached = { stamp, route: readProjectState(dir).route, queue: json<QueueState>(queueFile, { items: [], paused: false }) };
    states.set(dir, cached);
  }
  return { runs: directory<OrchestraRun>(path.join(base, 'orchestra')), crews: directory<CrewState>(path.join(base, 'crews')), route: cached.route, queue: cached.queue };
}
