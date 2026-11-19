export const automationKinds = ["schedule", "file", "event", "branch", "url", "webhook"] as const;
export type AutomationKind = typeof automationKinds[number];
export interface AutomationDraft {
  kind: AutomationKind; name: string; when: string; prompt: string; condition: string;
  action: "prompt" | "recipe" | "orchestrate" | "route"; target: string; every: string; select: string; failureLimit: string;
}
export const emptyAutomation = (): AutomationDraft => ({ kind: "schedule", name: "", when: "every weekday at 9am", prompt: "", condition: "", action: "prompt", target: "", every: "15m", select: "", failureLimit: "3" });
export function automationInput(draft: AutomationDraft, previewed: string, existingSchedule = false): Record<string, unknown> {
  const keepSchedule = existingSchedule && draft.kind === "schedule" && !draft.when.trim();
  if (draft.kind === "schedule" && !keepSchedule && (!draft.when.trim() || previewed !== draft.when.trim())) throw new Error("Preview the next five runs before saving.");
  const keys = { schedule: "when", file: "onChange", event: "on", branch: "onCommit", url: "watchUrl" };
  const body: Record<string, unknown> = { kind: draft.kind, name: draft.name.trim() || draft.kind, prompt: draft.prompt.trim(), condition: draft.condition.trim(), failureLimit: Number(draft.failureLimit), recipe: "", route: "", orchestrate: false };
  if (draft.kind !== "webhook" && !keepSchedule) body[keys[draft.kind]] = draft.when.trim();
  if (draft.kind === "url") { body.every = draft.every.trim(); body.select = draft.select.trim(); }
  if (draft.action === "orchestrate") body.orchestrate = true;
  else if (draft.action !== "prompt") body[draft.action] = draft.target.trim();
  return body;
}
export function automationStatus(data: { hold?: string | null; held: number }): string { return `${data.hold || "Automation active"} · ${data.held} held`; }

export function quietDefaults(quiet?: boolean | { range: string; days: number[] }): { range: string; days: string } {
  return typeof quiet === "object" ? { range: quiet.range, days: quiet.days.map(d => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d]).join(",") } : { range: "22:00-07:00", days: "mon-fri" };
}
