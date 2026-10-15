import type { FeedEvent } from "./team-hub.js";
export interface CrewRequestView {
  id: string; from: string; owner: string; crew: string; teammate: string; repo: string;
  text: string; at: number; expiresAt: number;
  state: "pending" | "accepted" | "declined" | "expired";
}
export function crewRequests(events: FeedEvent[], decrypt: (event: FeedEvent) => unknown, now = Date.now()): CrewRequestView[] {
  const views = new Map<string, CrewRequestView>();
  for (const event of events) {
    const id = String(event.meta.requestId ?? "");
    if (event.type === "crew_request") {
      const content = decrypt(event) as { text?: unknown } | null;
      if (!id || typeof content?.text !== "string") continue;
      const expiresAt = Number(event.meta.expiresAt);
      views.set(id, { id, from: event.github ?? "", owner: String(event.meta.owner ?? ""), crew: String(event.meta.crew ?? ""),
        teammate: String(event.meta.teammate ?? ""), repo: event.repo ?? "", text: content.text,
        at: event.ts, expiresAt, state: expiresAt <= now ? "expired" : "pending" });
    } else if (event.type === "crew_request_answered") {
      const view = views.get(id);
      if (view && event.github?.toLowerCase() === view.owner.toLowerCase() && (event.meta.state === "accepted" || event.meta.state === "declined")) view.state = event.meta.state;
    }
  }
  return [...views.values()].sort((a, b) => b.at - a.at);
}
