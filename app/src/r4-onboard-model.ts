export interface Guide { id: string; title: string; body: string }
export interface Tour { id: string; title: string; steps: Array<{ title: string; body: string; target: string }> }
export interface Release { version: string; highlights: Array<{ text: string; topic: string }> }
export interface Readiness { score: number; stack: string; draft: string; applied: string[]; checks: Array<{ id: string; ok: boolean; detail: string; fix: string | null }> }
export interface Example { name: string; kind: string; title: string; description: string }
export function searchGuides(guides: Guide[], query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return guides.filter(g => words.every(w => `${g.title} ${g.body}`.toLowerCase().includes(w)));
}
export function shouldShowRelease(previous: string | null, version: string, usedBefore = false) { return previous ? previous !== version : usedBefore; }
export function tourPosition(value: string | null, length: number) { return Math.min(Math.max(0, Math.floor(Number(value)) || 0), length); }
export function exampleInstallRoute(example: Example, project?: string) {
  if (example.kind === "trigger" && !project) throw new Error("Choose a project for this trigger.");
  return example.kind === "trigger" ? `/api/projects/${encodeURIComponent(project!)}/examples/${encodeURIComponent(example.name)}/install` : `/api/help/examples/${encodeURIComponent(example.name)}/install`;
}

export function scenarioLocation(project: string, result: { chat?: string; run?: { chat: string }; review?: { chat: string } }) {
  return { project, chat: result.chat ?? result.review?.chat ?? result.run?.chat ?? "main", tab: result.run ? "orchestra" : "thread" };
}
