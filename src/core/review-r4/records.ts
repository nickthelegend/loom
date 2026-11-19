import type { LoomEvent } from "../../types.js";
import { triage } from "../review-triage.js";
import { digest, patchFiles } from "./git.js";

export function summarize(patch: string, files: { path: string }[] = []) {
  const parts = new Map(patchFiles(patch).map(f => [f.path, f.patch]));
  return triage(patch, files).files.map(f => {
    const part = parts.get(f.path) ?? "";
    const action = part.includes("deleted file mode") ? "Deletes" : part.includes("new file mode") ? "Creates" : "Updates";
    const flags = [...f.reasons];
    if (/(^|\/)(.*lock.*|.*\.lock)$/.test(f.path) && !flags.some(f => /lock/.test(f))) flags.push("changes a lockfile");
    if (/(^|\/)(.*config.*|\.env[^/]*)(\/|$)/i.test(f.path) && !flags.some(f => /config/.test(f))) flags.push("changes configuration");
    if (f.added + f.removed >= 500 || part.length >= 100_000) flags.push("very large file change");
    const symbols = [...part.matchAll(/^\+.*?\b(?:function|class|interface|def|func)\s+([\w$]+)/gm)].map(m => m[1]).slice(0, 4);
    return { ...f, flags, summary: `${action} ${f.path}: adds ${f.added} and removes ${f.removed} lines${symbols.length ? `; defines ${symbols.join(", ")}` : ""}.`, version: digest(part), patch: part };
  });
}
export function chatChanges(events: LoomEvent[], chat: string) {
  const files = new Map<string, { path: string; patch: string; version: string }>();
  for (const event of events) {
    if (event.kind !== "turn_diff" || (event.chat ?? "main") !== chat) continue;
    const parts = new Map(patchFiles(String(event.payload.patch ?? "")).map(f => [f.path, f.patch]));
    for (const file of (event.payload.files ?? []) as { path: string }[]) {
      files.set(file.path, { path: file.path, patch: parts.get(file.path) ?? "", version: digest(`${event.id}:${parts.get(file.path) ?? ""}`) });
    }
  }
  return [...files.values()];
}
/** Follow line offsets backwards through recorded turns; context lines are not authorship. */
export function blameLine(events: LoomEvent[], file: string, line: number) {
  if (!Number.isSafeInteger(line) || line < 1) throw new Error("line must be a positive integer");
  let current = line;
  for (const event of [...events].reverse()) {
    if (event.kind !== "turn_diff") continue;
    const patch = patchFiles(String(event.payload.patch ?? "")).find(f => f.path === file)?.patch;
    if (!patch) continue;
    let oldN = 0, newN = 0, offset = 0, mapped: number | undefined;
    for (const text of patch.split("\n")) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (h) {
        oldN = Number(h[1]); newN = Number(h[3]);
        const oldCount = Number(h[2] ?? 1), newCount = Number(h[4] ?? 1);
        if (newN > current || (!newCount && newN === current)) break;
        offset = oldN + oldCount - (oldCount ? 1 : 0) - newN - newCount + (newCount ? 1 : 0);
      } else if (newN && text.startsWith("+") && !text.startsWith("+++")) {
        if (newN === current) {
          const prompt = events.filter(e => e.id < event.id && (e.chat ?? "main") === (event.chat ?? "main") && e.kind === "message" && !e.agentId).at(-1);
          return { path: file, line, chat: event.chat ?? "main", turn: event.id, agent: event.agentId ?? null, prompt: String(prompt?.payload.text ?? ""), checkpoint: event.payload.checkpoint ?? null, text: text.slice(1) };
        }
        newN++;
      } else if (text.startsWith("-") && !text.startsWith("---")) oldN++;
      else if (text.startsWith(" ")) { if (newN === current) mapped = oldN; oldN++; newN++; }
    }
    current = mapped ?? current + offset;
  }
  return { path: file, line, chat: null, turn: null, agent: null, prompt: null, reason: "No recorded Loom turn attributes this line" };
}
