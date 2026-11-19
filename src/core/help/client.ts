import type { helpGuides, whatsNew, featureTours } from "./catalog.js";
import type { projectReadiness, starterPrompts } from "./readiness.js";
import type { examples, installExample } from "./examples.js";
import type { runScenario } from "./scenarios.js";

export type HelpTransport = <T>(method: string, route: string, body?: Record<string, unknown>) => Promise<T>;
export class OnboardClient {
  constructor(private request: HelpTransport) {}
  help(q = "") { return this.request<{ guides: ReturnType<typeof helpGuides>; tours: typeof featureTours }>("GET", `/api/help?q=${encodeURIComponent(q)}`); }
  whatsnew() { return this.request<ReturnType<typeof whatsNew>>("GET", "/api/help/whatsnew"); }
  ready(id: string, fix = false) { return this.request<Awaited<ReturnType<typeof projectReadiness>>>(fix ? "POST" : "GET", `/api/projects/${encodeURIComponent(id)}/ready`, fix ? { fix: true } : undefined); }
  starters(id: string) { return this.request<Awaited<ReturnType<typeof starterPrompts>>>("GET", `/api/projects/${encodeURIComponent(id)}/starter-prompts`); }
  examples() { return this.request<{ examples: typeof examples }>("GET", "/api/help/examples"); }
  install(name: string, project?: string) { return this.request<ReturnType<typeof installExample>>("POST", project ? `/api/projects/${encodeURIComponent(project)}/examples/${encodeURIComponent(name)}/install` : `/api/help/examples/${encodeURIComponent(name)}/install`, {}); }
  scenario(id: string, scenario: string) { return this.request<Awaited<ReturnType<typeof runScenario>>>("POST", `/api/projects/${encodeURIComponent(id)}/demo-scenarios/${encodeURIComponent(scenario)}`, {}); }
  lesson(id: string, lesson: string) { return this.request<{ chat?: string; run?: { id: string }; steer?: { status: string } }>("POST", `/api/projects/${encodeURIComponent(id)}/tutorial/${encodeURIComponent(lesson)}`, {}); }
  provider(step: string, body: Record<string, unknown>) { return this.request<{ step: string; models?: string[]; model?: string; agent?: { id: string } }>("POST", `/api/help/provider/${encodeURIComponent(step)}`, body); }
}
