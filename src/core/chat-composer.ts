import { usageReport } from "./usage.js";
import type { LoomEvent } from "../types.js";
import { readProjectState, writeProjectState } from "./registry.js";

export interface ChatComposer {
  pins: number[];
  draft: string;
  revision: number;
  expanded: Record<string, boolean>;
}

export function chatComposer(dir: string, chat: string): ChatComposer {
  return readProjectState(dir).chatComposer?.[chat] ?? { pins: [], draft: "", revision: 0, expanded: {} };
}

export function updateChatComposer(dir: string, chat: string, patch: Partial<ChatComposer>): ChatComposer {
  const state = readProjectState(dir);
  const next = { ...chatComposer(dir, chat), ...patch };
  state.chatComposer = { ...state.chatComposer, [chat]: next };
  writeProjectState(dir, state);
  return next;
}

export function quoteMessage(event: LoomEvent, project: string, chat: string): string {
  const link = `#p/${encodeURIComponent(project)}/c/${encodeURIComponent(chat)}/m/${event.id}`;
  return `> [Reply to message #${event.id}](${link})\n` +
    String(event.payload.text ?? "").split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
}

export function chatMarkdown(events: LoomEvent[], title: string): string {
  return `# ${title}\n\n` + events.map(e => {
    const p = e.payload;
    if (e.kind === "message" && !p.reasoning) return `## ${p.author === "user" ? "You" : e.agentId ?? "Loom"}\n\n${String(p.text ?? "")}\n`;
    if (e.kind === "tool_call") return `### ${String(p.tool ?? "Tool")}\n\n${String(p.summary ?? "")}\n\n${String(p.preview ?? p.output ?? "")}\n`;
    if (e.kind === "file_edit") return `### Edited ${String(p.path ?? "file")}\n\n${String(p.diff ?? "")}\n`;
    if (e.kind === "error") return `> Error: ${String(p.message ?? p.error ?? "")}\n`;
    if (e.kind === "run_complete") return `_${e.agentId ?? "Agent"} finished${p.costUsd ? ` · $${Number(p.costUsd).toFixed(4)}` : ""}_\n`;
    return "";
  }).filter(Boolean).join("\n");
}

export function chatTotals(events: LoomEvent[]): { costUsd: number; tokens: number; turns: number } {
  const totals = usageReport(events).totals;
  return { costUsd: totals.usd, tokens: totals.tokensIn + totals.tokensOut, turns: totals.turns };
}

export function templateVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map(m => m[1]!))];
}

export function fillTemplate(text: string, values: Record<string, unknown>): string {
  for (const name of templateVariables(text)) {
    if (!Object.hasOwn(values, name) || typeof values[name] !== "string") throw new Error(`missing variable: ${name}`);
  }
  const result = text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, name: string) => String(values[name]));
  if (result.length > 100_000) throw new Error("template result is too long");
  return result;
}
