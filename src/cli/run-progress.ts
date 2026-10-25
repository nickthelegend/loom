/**
 * What changed in an orchestra run between two looks at it, as one event per change — so a
 * `loom chain` log shows where an hour went instead of "started … done" (field: a chain of ten
 * orchestras printed nothing between them). Pure: the CLI polls, this diffs.
 */

import type { OrchestraRun } from "../core/orchestra.js";

export type ProgressEvent =
  | { kind: "run"; run: string; status: string; round: number }
  | { kind: "round"; run: string; round: number }
  | { kind: "planned"; run: string; task: string; agent: string; title: string }
  | { kind: "task"; run: string; task: string; agent: string; status: string; attempt: number; files?: number; error?: string };

export function runEvents(prev: OrchestraRun | null, next: OrchestraRun): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  const run = next.id;
  if (!prev || prev.status !== next.status) out.push({ kind: "run", run, status: next.status, round: next.round });
  else if (prev.round !== next.round) out.push({ kind: "round", run, round: next.round });
  const before = new Map((prev?.tasks ?? []).map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const was = before.get(t.id);
    if (!was) out.push({ kind: "planned", run, task: t.id, agent: t.agent, title: t.title });
    // a task that comes back for another attempt changes status through running again; say so
    if (was?.status === t.status && was.attempts === t.attempts) continue;
    if (!was && t.status === "pending") continue;
    out.push({
      kind: "task", run, task: t.id, agent: t.agent, status: t.status, attempt: t.attempts,
      ...(t.status === "done" && t.files ? { files: t.files.length } : {}),
      ...(t.error && (t.status === "failed" || t.status === "conflict") ? { error: t.error.split("\n")[0]!.slice(0, 200) } : {}),
    });
  }
  return out;
}

/** One line for a person reading a log. */
export function formatEvent(e: ProgressEvent, label = ""): string {
  const at = new Date().toTimeString().slice(0, 8);
  const head = `${at} ${label ? `${label} ` : ""}`;
  switch (e.kind) {
    case "run": return `${head}${e.run} ${e.status}${e.round ? ` (round ${e.round})` : ""}`;
    case "round": return `${head}${e.run} review round ${e.round}`;
    case "planned": return `${head}${e.task} planned for ${e.agent}: ${e.title}`;
    case "task": {
      const again = e.attempt > 1 && e.status === "running" ? ` (attempt ${e.attempt})` : "";
      const files = e.files !== undefined ? ` — ${e.files} file${e.files === 1 ? "" : "s"}` : "";
      const why = e.error ? `: ${e.error}` : "";
      return `${head}${e.task} [${e.agent}] ${e.status}${again}${files}${why}`;
    }
  }
}
