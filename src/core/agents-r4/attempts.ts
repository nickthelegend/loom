import { setTimeout as delay } from "node:timers/promises";
import { retrySnapshot } from "./snapshot.js";
import type { Adapter, AdapterEvent, SendInput } from "../../types.js";
import type { AgentPolicy } from "./store.js";

export const isRetrying = (payload: Record<string, unknown>): boolean => payload.retrying === true;

const terminalBuffers = new WeakMap<Adapter, Array<{ event: AdapterEvent; deliver: (e: AdapterEvent) => void }>>();
export function deliverAttemptEvent(agent: Adapter, event: AdapterEvent, deliver: (e: AdapterEvent) => void): void {
  const buffer = terminalBuffers.get(agent);
  if (buffer && (event.kind === "error" || event.kind === "run_complete" && event.payload.error)) buffer.push({ event, deliver });
  else deliver(event);
}

export function transientFailure(message: string): boolean {
  return /(?:\b429\b|rate.?limit|too many requests|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network error|fetch failed|socket hang up)/i.test(message);
}

/** Each attempt still enters the adapter's normal admission gate. The outer busy
 * reservation keeps queued prompts from overtaking a retry's backoff.
 */
export async function runAttempts(agent: Adapter, input: SendInput, policy: AgentPolicy, host: {
  dir: string;
  budget: () => void;
  current: () => boolean;
  say: (event: AdapterEvent) => void;
  interrupted: () => Promise<boolean>;
  abandoned: () => void;
  retryInput?: (failure: string, signal: AbortSignal) => Promise<SendInput>;
}): Promise<void> {
  const ctl = new AbortController(), busy = agent.busy, interrupt = agent.interrupt;
  let active = true, attemptRunning = false, timedOut = false, pendingRetry = false;
  let timeout: Promise<void> | undefined;
  agent.busy = () => attemptRunning ? busy.call(agent) : active || busy.call(agent);
  agent.interrupt = async () => { ctl.abort(); await interrupt.call(agent); };
  const limit = policy.maxTurnMinutes ?? 0;
  const timer = limit > 0 ? setTimeout(() => {
    timeout = host.interrupted().then(interrupted => { timedOut = interrupted; }).catch(() => {});
  }, Math.min(limit * 60_000, 2_147_483_647)) : undefined;
  timer?.unref();
  try {
    for (let attempt = 0; ; attempt++) {
      if (ctl.signal.aborted || !host.current()) return;
      host.budget();
      const before = (policy.retries?.count ?? 0) > 0 ? await retrySnapshot(host.dir) : null;
      if (ctl.signal.aborted || !host.current()) return;
      let failure: string | undefined, thrown: unknown, edited = false;
      const buffered: Array<{ event: AdapterEvent; deliver: (e: AdapterEvent) => void }> = [];
      if (attempt < (policy.retries?.count ?? 0)) terminalBuffers.set(agent, buffered);
      const off = agent.onEvent(e => {
        if (e.kind === "error" || e.kind === "run_complete" && e.payload.error) failure = String(e.payload.message ?? e.payload.error ?? e.payload.text ?? "");
        if (e.kind === "file_edit" || e.kind === "tool_call" && !/^(read|read_file|glob|grep|list|list_files|search)$/i.test(String(e.payload.tool ?? ""))) edited = true;
        if (e.kind === "status" && e.payload.state === "interrupted") ctl.abort();
      });
      attemptRunning = true;
      try { pendingRetry = false; await agent.send(input); }
      catch (error) { thrown = error; failure = error instanceof Error ? error.message : String(error); }
      finally { attemptRunning = false; off(); terminalBuffers.delete(agent); }
      const canRetry = failure && !edited && (!input.continuity || host.retryInput) && !ctl.signal.aborted && host.current() && attempt < (policy.retries?.count ?? 0) && transientFailure(failure);
      const retry = canRetry && before !== null && before === await retrySnapshot(host.dir);
      for (const item of buffered) item.deliver({ ...item.event, payload: { ...item.event.payload, ...(retry ? { retrying: true } : {}) } });
      if (!retry) {
        if (thrown) throw thrown;
        return;
      }
      if (thrown && !buffered.length) host.say({ kind: "error", payload: { message: failure, retrying: true } });
      pendingRetry = true;
      host.say({ kind: "status", payload: { state: "turn_retry", attempt: attempt + 2, text: `Retry ${attempt + 1} of ${policy.retries!.count} in ${policy.retries!.waitSeconds}s` } });
      await delay(policy.retries!.waitSeconds * 1000, undefined, { signal: ctl.signal }).catch(() => {});
      if (!ctl.signal.aborted && host.current() && host.retryInput) input = await host.retryInput(failure!, ctl.signal);
    }
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    agent.busy = busy;
    agent.interrupt = interrupt;
    if (pendingRetry) host.abandoned();
    await timeout;
    if (timedOut && !attemptRunning && host.current()) host.say({ kind: "needs_input", payload: { reason: "turn_time_limit", question: "This turn reached its time limit. Continue when you are ready.", continue: true } });
  }
}
