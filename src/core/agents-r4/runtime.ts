import { isAdapter } from "../../types.js";
import type { ProjectRuntime } from "../../daemon/runtime.js";
import type { RuntimeTurns } from "../../daemon/runtime/turns.js";
import type { RuntimeAgents } from "../../daemon/runtime/agents.js";
import { sessionSettings, redactEnvironment } from "./store.js";

const runtimes = new WeakMap<ProjectRuntime, { turns: RuntimeTurns; lifecycle: RuntimeAgents }>();
export function sessionBusy(rt: ProjectRuntime, id: string): boolean {
  const state = runtimes.get(rt), agent = state?.lifecycle.agents.get(id);
  return Boolean(state?.turns.busySince.has(id) || agent && isAdapter(agent) && agent.busy());
}
export const sleepingAgents = new WeakMap<ProjectRuntime, Set<string>>();

/** Recreate stopped adapters through the existing replacement barrier. Their
 * persisted sessions stay in AgentStateStore, and roster/baton identity stays put.
 */
export function registerSessionRuntime(rt: ProjectRuntime, turns: RuntimeTurns, lifecycle: RuntimeAgents, closed: () => boolean): void {
  runtimes.set(rt, { turns, lifecycle });
  const append = rt.log.append.bind(rt.log);
  rt.log.append = event => {
    return append({ ...event, payload: redactEnvironment(event.payload, rt.info.id, rt.config.agents.map(c => c.id)) });
  };
  const asleep = new Set<string>(), touched = new Map<string, number>();
  sleepingAgents.set(rt, asleep);
  const off = rt.log.onEvent(e => {
    if (e.agentId && e.payload.state !== "asleep") { touched.set(e.agentId, Date.now()); asleep.delete(e.agentId); }
  });
  let running = false, lastSweep = 0;
  const sweepMs = Math.max(1, Number(process.env.LOOM_AGENTS_ARCHIVE_SWEEP_MS) || 300_000);
  const timer = setInterval(() => {
    if (closed()) { clearInterval(timer); off(); return; }
    if (running) return;
    running = true;
    void (async () => {
      const settings = sessionSettings(rt.info.dir), now = Date.now();
      for (const cfg of rt.config.agents) {
        const idle = settings.agents[cfg.id]?.idleSleepMinutes ?? settings.idleSleepMinutes ?? 0;
        if (!touched.has(cfg.id)) touched.set(cfg.id, now);
        if (!idle || asleep.has(cfg.id) || cfg.enabled === false || turns.busySince.has(cfg.id) || now - touched.get(cfg.id)! < idle * 60_000) continue;
        const agent = lifecycle.agents.get(cfg.id);
        if (!agent || agent.capabilities.tier !== "adapter") continue;
        // setAgentOptions checks busy again synchronously and installs the new
        // instance before yielding, so Stop and chat bindings never lose it.
        rt.setAgentOptions(cfg.id, {});
        await lifecycle.settled(cfg.id);
        if (closed() || !lifecycle.agents.has(cfg.id) || turns.busySince.has(cfg.id)) continue;
        asleep.add(cfg.id);
        rt.log.append({ kind: "status", agentId: cfg.id, payload: { state: "asleep", text: "Asleep · wakes on the next message" } });
      }
      if (settings.autoArchiveDays && now - lastSweep >= sweepMs) {
        lastSweep = now;
        for (const chat of rt.chats()) {
          if (chat.id === "main" || chat.archived || turns.sendingChats.has(chat.id) || [...lifecycle.agents.values()].some(a => turns.chatOf(a.id) === chat.id && (turns.busySince.has(a.id) || isAdapter(a) && a.busy()))) continue;
          const last = Math.max(rt.log.list({ chat: chat.id, limit: 1 })[0]?.ts ?? 0, chat.restoredAt ?? 0, chat.createdAt);
          if (now - last >= settings.autoArchiveDays * 86_400_000) rt.setChatFlags(chat.id, { archived: true });
        }
      }
    })().catch(() => {}).finally(() => { running = false; });
  }, Math.min(1000, sweepMs));
  timer.unref();
}
