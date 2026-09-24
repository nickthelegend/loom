/**
 * A chat as Markdown: your prompts, the replies, what was done and what
 * changed. The same shape the app's "Export as Markdown" writes.
 */

import type { LoomEvent } from "../types.js";

function day(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function threadMarkdown(events: LoomEvent[], title: string, now = new Date()): string {
  const out = [`# ${title}`, "", `_Exported from Loom ${now.toLocaleString()} · ${events.length} events_`, ""];
  let lastDay = "";
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const d = day(e.ts);
    if (d !== lastDay) {
      lastDay = d;
      out.push("", "---", "", `*${d}*`, "");
    }
    if (e.kind === "message" && !e.agentId && p.author !== "loom") out.push("", `### You · ${clock(e.ts)}`, "", String(p.text ?? ""));
    else if (e.kind === "message" && e.agentId && !p.reasoning)
      out.push("", `### ${e.agentId}${p.model ? ` (${p.model})` : ""} · ${clock(e.ts)}${p.partial ? " · stopped" : ""}`, "", String(p.text ?? ""));
    else if (e.kind === "tool_call") out.push(`- ⚙ ${String(p.summary ?? p.tool ?? p.name ?? "tool").split("\n")[0]}`);
    else if (e.kind === "turn_diff") {
      const files = (p.files as Array<{ path: string }> | undefined) ?? [];
      out.push("", `> Edited ${files.length} file(s) · +${Number(p.added ?? 0)} −${Number(p.removed ?? 0)}: ${files.slice(0, 12).map((f) => f.path).join(", ")}`);
    } else if (e.kind === "error") out.push("", `> **Error** (${e.agentId ?? "loom"}): ${String(p.message ?? p.error ?? "").split("\n")[0]}`);
    else if (e.kind === "run_complete")
      out.push("", `_${e.agentId ?? "agent"} finished${p.durationMs ? ` in ${dur(Number(p.durationMs))}` : ""}${p.costUsd ? ` · $${Number(p.costUsd).toFixed(4)}` : ""}_`);
  }
  return out.join("\n") + "\n";
}
