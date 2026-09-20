/**
 * The prompt queue: what you've lined up for this project, run one at a time.
 *
 * You type while an agent is mid-turn, or while an orchestra goal is still
 * running, and the prompt waits here instead of being refused or lost. Each
 * item names who takes it — one agent, the orchestrator (a new goal), or the
 * auto router — and nothing about it is final until it's sent: you can edit
 * the text, change who it goes to, reorder it or drop it.
 *
 * This module is the data and its file; ProjectRuntime decides when the head
 * of the queue may go (see ProjectRuntime.drainPromptQueue). The file lives in
 * the project's .loom/ beside the log, so a queue survives a daemon restart —
 * reloaded paused, because prompts you queued an hour ago shouldn't start
 * running just because the daemon came back.
 */

import fs from "node:fs";
import path from "node:path";

export type QueueTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "orchestra"; orchestrator?: string; workers?: string[]; maxParallel?: number }
  | { kind: "auto" };

/**
 * When a queued prompt may go, beyond "when nothing is in the way".
 *
 * The queue's default is as soon as it can, which is right for the next thing
 * you want said. These are for the things you want said *later*: at an hour,
 * once a goal is really on main rather than merely finished, or once CI has
 * spoken. Each one is a fact the daemon can check — nothing here guesses.
 */
export type QueueCondition =
  /** Not before this moment (epoch ms). */
  | { kind: "at"; at: number }
  /** After the goal that was running when this was queued has LANDED. */
  | { kind: "landed"; runId: string }
  /** After that goal's PR checks are green. */
  | { kind: "checks-green"; runId: string }
  /** After this many ms with no agent working. */
  | { kind: "quiet"; ms: number };

export interface QueueItem {
  id: string;
  text: string;
  target: QueueTarget;
  /** The chat it was typed in — an agent's reply comes back there. */
  chat: string;
  plan?: boolean;
  source: "user" | "route";
  at: number;
  editedAt?: number;
  /** Hold it back until this is true — see QueueCondition. */
  when?: QueueCondition;
}

/** A condition from the wire, checked. */
export function parseCondition(raw: unknown): QueueCondition | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const c = raw as Record<string, unknown>;
  if (c.kind === "at") {
    const at = typeof c.at === "string" ? Date.parse(c.at) : Number(c.at);
    if (!Number.isFinite(at)) throw new Error("that isn't a time I can read");
    return { kind: "at", at };
  }
  if (c.kind === "landed" || c.kind === "checks-green") {
    const runId = String(c.runId ?? "").trim();
    if (!runId) throw new Error(`a "${c.kind}" condition needs the goal it waits for`);
    return { kind: c.kind, runId };
  }
  if (c.kind === "quiet") {
    const ms = Number(c.ms);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error("a quiet period needs a duration");
    return { kind: "quiet", ms: Math.min(ms, 24 * 60 * 60_000) };
  }
  throw new Error(`unknown condition "${String(c.kind)}"`);
}

/** The condition in the words the queue shows. */
export function describeCondition(c: QueueCondition): string {
  if (c.kind === "at") {
    const d = new Date(c.at);
    return `waiting until ${d.toLocaleString()}`;
  }
  if (c.kind === "landed") return `waiting for goal ${c.runId} to land`;
  if (c.kind === "checks-green") return `waiting for goal ${c.runId}'s checks to go green`;
  return `waiting for ${Math.round(c.ms / 60_000)} quiet minute${c.ms >= 120_000 ? "s" : ""}`;
}

export interface QueueState {
  items: QueueItem[];
  paused: boolean;
  /** Why it's paused, when it paused itself (a refused send, a Stop, a restart). */
  reason?: string;
}

export interface QueueInput {
  text: string;
  target?: QueueTarget;
  chat?: string;
  plan?: boolean;
  source?: "user" | "route";
  when?: QueueCondition;
}

export const MAX_QUEUE = 100;
export const MAX_QUEUE_TEXT = 100_000;

/** A target from the wire: validated, so nothing downstream sees a shape it doesn't know. */
export function parseTarget(raw: unknown): QueueTarget {
  if (raw === undefined || raw === null || raw === "auto") return { kind: "auto" };
  if (raw === "orchestra") return { kind: "orchestra" };
  if (typeof raw === "string" && raw.trim()) return { kind: "agent", agentId: raw.trim() };
  if (typeof raw !== "object") throw new Error("target must be an agent id, \"orchestra\" or \"auto\"");
  const t = raw as Record<string, unknown>;
  if (t.kind === "auto") return { kind: "auto" };
  if (t.kind === "agent") {
    if (typeof t.agentId !== "string" || !t.agentId.trim()) throw new Error("an agent target needs an agentId");
    return { kind: "agent", agentId: t.agentId.trim() };
  }
  if (t.kind === "orchestra") {
    const workers = Array.isArray(t.workers) ? t.workers.map(String).filter(Boolean) : undefined;
    const maxParallel = Number(t.maxParallel);
    return {
      kind: "orchestra",
      ...(typeof t.orchestrator === "string" && t.orchestrator ? { orchestrator: t.orchestrator } : {}),
      ...(workers?.length ? { workers } : {}),
      ...(Number.isFinite(maxParallel) && maxParallel > 0 ? { maxParallel: Math.floor(maxParallel) } : {}),
    };
  }
  throw new Error(`unknown target kind "${String(t.kind)}"`);
}

export class PromptQueue {
  private state: QueueState = { items: [], paused: false };
  private seq = 0;

  /** `file` null keeps it in memory (tests, projects with no .loom). */
  constructor(
    private file: string | null,
    private onChange: (s: QueueState) => void = () => {},
  ) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<QueueState>;
      const items = Array.isArray(raw.items) ? raw.items.filter(validItem) : [];
      this.state = items.length
        ? { items, paused: true, reason: "the daemon restarted — resume to run what's queued" }
        : { items: [], paused: false };
    } catch {
      // no file yet, or unreadable: an empty queue, not a crash
    }
  }

  snapshot(): QueueState {
    return { items: this.state.items.map((i) => ({ ...i, target: { ...i.target } as QueueTarget })), paused: this.state.paused, ...(this.state.reason ? { reason: this.state.reason } : {}) };
  }

  get paused(): boolean {
    return this.state.paused;
  }

  get length(): number {
    return this.state.items.length;
  }

  peek(): QueueItem | undefined {
    return this.state.items[0];
  }

  add(input: QueueInput): QueueItem {
    const text = input.text.trim();
    if (!text) throw new Error("nothing to queue — the prompt is empty");
    if (text.length > MAX_QUEUE_TEXT) throw new Error(`a queued prompt is at most ${MAX_QUEUE_TEXT} characters`);
    if (this.state.items.length >= MAX_QUEUE) throw new Error(`the queue is full (${MAX_QUEUE} prompts)`);
    const item: QueueItem = {
      id: `q${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      text,
      target: input.target ?? { kind: "auto" },
      chat: input.chat ?? "main",
      ...(input.plan ? { plan: true } : {}),
      source: input.source ?? "user",
      at: Date.now(),
      ...(input.when ? { when: input.when } : {}),
    };
    this.state.items.push(item);
    this.changed();
    return item;
  }

  edit(id: string, patch: { text?: string; target?: QueueTarget; plan?: boolean; when?: QueueCondition | null }): QueueItem {
    const item = this.must(id);
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (!text) throw new Error("a queued prompt can't be empty — remove it instead");
      if (text.length > MAX_QUEUE_TEXT) throw new Error(`a queued prompt is at most ${MAX_QUEUE_TEXT} characters`);
      item.text = text;
    }
    if (patch.target) item.target = patch.target;
    if (patch.plan !== undefined) {
      if (patch.plan) item.plan = true;
      else delete item.plan;
    }
    if (patch.when !== undefined) {
      if (patch.when) item.when = patch.when;
      else delete item.when; // null means "go as soon as you can"
    }
    item.editedAt = Date.now();
    this.changed();
    return item;
  }

  remove(id: string): void {
    const i = this.index(id);
    this.state.items.splice(i, 1);
    if (!this.state.items.length) this.state = { items: [], paused: false };
    this.changed();
  }

  /** Move an item to position `to` (0 = next to run), clamped to the queue. */
  move(id: string, to: number): void {
    const from = this.index(id);
    const [item] = this.state.items.splice(from, 1);
    const dest = Math.max(0, Math.min(this.state.items.length, Math.floor(Number.isFinite(to) ? to : 0)));
    this.state.items.splice(dest, 0, item!);
    this.changed();
  }

  clear(): number {
    const n = this.state.items.length;
    this.state = { items: [], paused: false };
    this.changed();
    return n;
  }

  setPaused(paused: boolean, reason?: string): void {
    this.state.paused = paused;
    if (paused && reason) this.state.reason = reason;
    else delete this.state.reason;
    this.changed();
  }

  /** Take the head to send it. */
  shift(): QueueItem | undefined {
    const item = this.state.items.shift();
    if (item) this.changed();
    return item;
  }

  /** Put a head that couldn't go back where it was. */
  unshift(item: QueueItem): void {
    this.state.items.unshift(item);
    this.changed();
  }

  private must(id: string): QueueItem {
    return this.state.items[this.index(id)]!;
  }

  private index(id: string): number {
    const i = this.state.items.findIndex((x) => x.id === id);
    if (i < 0) throw new QueueItemGone(id);
    return i;
  }

  private changed(): void {
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ items: this.state.items }, null, 2));
        fs.renameSync(tmp, this.file);
      } catch {
        // a queue that can't be saved still works for this session
      }
    }
    this.onChange(this.snapshot());
  }
}

/** The item was already sent or removed — the UI raced the queue. */
export class QueueItemGone extends Error {
  constructor(id: string) {
    super(`queued prompt ${id} is gone — it was sent or removed`);
  }
}

function validItem(x: unknown): x is QueueItem {
  if (!x || typeof x !== "object") return false;
  const i = x as QueueItem;
  if (typeof i.id !== "string" || typeof i.text !== "string" || !i.text) return false;
  try {
    i.target = parseTarget(i.target);
  } catch {
    return false;
  }
  i.chat = typeof i.chat === "string" && i.chat ? i.chat : "main";
  i.source = i.source === "route" ? "route" : "user";
  i.at = Number(i.at) || Date.now();
  return true;
}
