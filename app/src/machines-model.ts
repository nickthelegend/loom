/**
 * Several computers on one phone: your desktop, your laptop, a box in the cloud — each paired
 * once, one tap to switch, each with its own Loom Cloud route so any of them answers from
 * anywhere. Pure (no storage, no React), so it's testable in plain node; api.ts keeps the list.
 */

/** A computer's Loom Cloud route, as the pairing link gave it — kept as is, read by api.ts. */
export type MachineRelay = object;

export interface Machine {
  id: string;
  /** What you call it — the computer's hostname until you rename it. */
  name: string;
  url: string;
  token: string;
  relay?: MachineRelay;
  addedAt: number;
}

export interface MachineCreds {
  url: string;
  token: string;
  relay?: MachineRelay;
}

const hostOf = (url: string) => url.replace(/^\w+:\/\//, "").replace(/\/.*$/, "");

/**
 * Add a computer, or refresh one already here. The same address paired again (a new token, a
 * new relay key after `loom cloud rotate`) replaces its old entry instead of piling up.
 */
export function upsertMachine(list: Machine[], creds: MachineCreds, opts: { name?: string; now?: number; id?: string } = {}): { list: Machine[]; id: string } {
  const at = list.findIndex((m) => m.url === creds.url);
  if (at >= 0) {
    const cur = list[at]!;
    const next: Machine = { ...cur, token: creds.token, ...(creds.relay ? { relay: creds.relay } : {}), ...(opts.name ? { name: opts.name } : {}) };
    if (!creds.relay) delete next.relay;
    return { list: list.map((m, i) => (i === at ? next : m)), id: cur.id };
  }
  const id = opts.id ?? `m${(opts.now ?? Date.now()).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const m: Machine = { id, name: opts.name || hostOf(creds.url) || "Computer", url: creds.url, token: creds.token, ...(creds.relay ? { relay: creds.relay } : {}), addedAt: opts.now ?? Date.now() };
  return { list: [...list, m], id };
}

export function removeMachine(list: Machine[], id: string): Machine[] {
  return list.filter((m) => m.id !== id);
}

export function renameMachine(list: Machine[], id: string, name: string): Machine[] {
  const n = name.trim().slice(0, 40);
  return n ? list.map((m) => (m.id === id ? { ...m, name: n } : m)) : list;
}

/** The computer to use: the one you picked, else the first. */
export function activeMachine(list: Machine[], activeId: string | null): Machine | undefined {
  return list.find((m) => m.id === activeId) ?? list[0];
}

/** After one is forgotten (or revoked): which to use next, if any. */
export function nextAfter(list: Machine[], goneId: string): Machine | undefined {
  return list.find((m) => m.id !== goneId);
}

/** A push from a computer names itself by hostname: the paired one it came from, else the active one. */
export function machineForPush(list: Machine[], daemonName: unknown, activeId: string | null): Machine | undefined {
  if (typeof daemonName === "string" && daemonName) {
    const hit = list.find((m) => m.name === daemonName || m.name.toLowerCase() === daemonName.toLowerCase());
    if (hit) return hit;
  }
  return activeMachine(list, activeId);
}

export const credsOf = (m: Machine): MachineCreds => ({ url: m.url, token: m.token, ...(m.relay ? { relay: m.relay } : {}) });
