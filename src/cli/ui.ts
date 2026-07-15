/**
 * CLI rendering — one place that turns log events into terminal lines.
 */

import pc from "picocolors";
import type { LoomEvent, ProjectStatus } from "../types.js";

const AGENT_COLORS = [pc.cyan, pc.green, pc.yellow, pc.blue, pc.magenta] as const;
const colorCache = new Map<string, (typeof AGENT_COLORS)[number]>();

export function agentColor(id: string): (s: string) => string {
  let fn = colorCache.get(id);
  if (!fn) {
    fn = AGENT_COLORS[colorCache.size % AGENT_COLORS.length]!;
    colorCache.set(id, fn);
  }
  return fn;
}

export function timeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatEvent(e: LoomEvent): string | null {
  const who = e.agentId ?? String(e.payload.author ?? "");
  const paint = agentColor(who || "system");
  switch (e.kind) {
    case "message": {
      const text = String(e.payload.text ?? "");
      if (!e.agentId) {
        const author = String(e.payload.author ?? "you");
        if (author === "loom") {
          // Route-generated instructions: show compactly, not as the human.
          return pc.dim(`${timeShort(e.ts)} loom ⟶ ${text.split("\n")[0] ?? ""}`);
        }
        return `${pc.dim(timeShort(e.ts))} ${pc.bold("you")} ${text}`;
      }
      return `${pc.dim(timeShort(e.ts))} ${paint(pc.bold(who))} ${text}`;
    }
    case "tool_call":
      return pc.dim(`  ⚙ ${String(e.payload.summary ?? e.payload.tool ?? "tool")}`);
    case "file_edit":
      return pc.dim(`  ✎ ${String(e.payload.path ?? "")}`);
    case "handoff": {
      const from = (e.payload.from as string | null) ?? "—";
      const to = (e.payload.to as string | null) ?? "—";
      const dirty = e.payload.dirty ? pc.dim("  · uncommitted changes in tree") : "";
      return pc.magenta(`  ⟶ baton: ${from} → ${to}`) + dirty;
    }
    case "suggestion":
      return pc.yellow(
        `  💡 ${String(e.payload.reason ?? "handoff suggested")}  ${pc.dim(`(/handoff ${String(e.payload.to)})`)}`,
      );
    case "needs_input":
      return pc.yellow(`  ⏸ ${who} needs input: ${String(e.payload.question ?? "")}`);
    case "run_complete": {
      const ms = Number(e.payload.durationMs ?? 0);
      const cost = e.payload.costUsd !== undefined ? ` · $${Number(e.payload.costUsd).toFixed(4)}` : "";
      return pc.dim(`  ✓ ${who} done (${(ms / 1000).toFixed(1)}s${cost})`);
    }
    case "decision":
      return pc.blue(`  ★ decision: ${String(e.payload.text ?? "")}`);
    case "route_started": {
      const steps = (e.payload.steps as string[] | undefined) ?? [];
      const name = e.payload.name ? ` "${String(e.payload.name)}"` : "";
      return pc.cyan(`  ➤ route${name} started: ${steps.join(" → ")}`);
    }
    case "route_step": {
      const n = Number(e.payload.step) + 1;
      const of = e.payload.of ? `/${Number(e.payload.of)}` : "";
      const reason = e.payload.reason ? pc.dim(`  (${String(e.payload.reason)})`) : "";
      return pc.cyan(`  ➤ ${e.payload.of ? "step" : "hop"} ${n}${of} → ${String(e.payload.agent)}`) + reason;
    }
    case "route_paused":
      return pc.yellow(
        `  ⏸ route paused — ${String(e.payload.agent)} asks: ${String(e.payload.question ?? "")}` +
          pc.dim("  (answer with loom send / chat; route resumes automatically)"),
      );
    case "route_resumed":
      return pc.cyan(`  ➤ route resumed`);
    case "route_completed":
      return pc.green(`  ✔ route completed (${Number(e.payload.steps)} steps)`);
    case "route_failed":
      return e.payload.aborted
        ? pc.yellow(`  ⊘ route stopped: ${String(e.payload.reason ?? "")}`)
        : pc.red(`  ✗ route failed: ${String(e.payload.reason ?? "")}`);
    case "error":
      return pc.red(`  ✗ ${who}: ${String(e.payload.message ?? "error")}`);
    case "status": {
      const state = String(e.payload.state ?? "");
      if (["interrupted", "unreachable", "wait_failed"].includes(state)) {
        return pc.dim(`  · ${who} ${state}`);
      }
      if (state === "turn_cost") {
        return pc.dim(`  · cost $${Number(e.payload.costUsd ?? 0).toFixed(4)}`);
      }
      if (state === "projection") {
        return pc.dim(`  · shared memory distilled by llm (${Number(e.payload.ms ?? 0)}ms)`);
      }
      return null; // lifecycle noise stays out of the chat
    }
    default:
      return null;
  }
}

export function formatProjectRow(p: ProjectStatus): string {
  const flag = p.needsInput ? pc.yellow("● needs input") : pc.dim("○ idle");
  const holder = p.holder ? agentColor(p.holder)(p.holder) : pc.dim("—");
  const last = p.lastEvent
    ? pc.dim(`${timeShort(p.lastEvent.ts)} ${p.lastEvent.kind}`)
    : pc.dim("no activity");
  const route =
    p.route && (p.route.status === "running" || p.route.status === "waiting_human")
      ? pc.cyan(
          `  ➤ ${p.route.name ?? "route"} ${p.route.current + 1}/${p.route.steps.length}` +
            (p.route.status === "waiting_human" ? " ⏸" : ""),
        )
      : "";
  return `${flag}  ${pc.bold(p.name)} ${pc.dim(`(${p.id})`)}  baton: ${holder}${route}  ${last}`;
}

export function formatAgentRow(a: ProjectStatus["agents"][number]): string {
  const paint = agentColor(a.id);
  const baton = a.holdsBaton ? pc.magenta(" ⟵ baton") : "";
  const avail = a.available ? pc.green("●") : pc.red("○");
  const busy = a.busy ? pc.yellow(" (busy)") : "";
  const tier = a.tier === "bridge" ? pc.dim(" [bridge]") : "";
  return ` ${avail} ${paint(pc.bold(a.id))} ${pc.dim(a.kind)} — ${a.role}${tier}${busy}${baton}`;
}
