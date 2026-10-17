import type { Express } from 'express';
import type { WithRuntime } from './context.js';

/** Register Review routes (daemon/review.ts) in the order established by LoomDaemon.routes(). */
export function registerReviewRoutes(app: Express, withRuntime: WithRuntime): void {
  const bad = (res: import("express").Response, err: unknown) => res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

  // Start one: { agents: string[], file?, text?, focus? } — no file and no text reviews the uncommitted changes.
  app.post(
    "/api/projects/:id/reviews",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { agents?: unknown; file?: unknown; text?: unknown; focus?: unknown };
      const agents = Array.isArray(b.agents) ? b.agents.map(String) : typeof b.agents === "string" ? b.agents.split(",") : [];
      try {
        const review = await rt.startReview({
          agents,
          ...(typeof b.file === "string" && b.file ? { file: b.file } : {}),
          ...(typeof b.text === "string" && b.text ? { text: b.text } : {}),
          ...(typeof b.focus === "string" && b.focus ? { focus: b.focus } : {}),
        });
        res.json({ review });
      } catch (err) { bad(res, err); }
    }),
  );

  app.get("/api/projects/:id/reviews", withRuntime(async (rt, _req, res) => void res.json({ reviews: rt.reviews.recent() })));

  app.get(
    "/api/projects/:id/reviews/:reviewId",
    withRuntime(async (rt, req, res) => {
      const review = rt.reviews.status(String(req.params.reviewId));
      if (!review) return void res.status(404).json({ error: "no such review" });
      res.json({ review });
    }),
  );

  // Accept (it becomes a decision) or reject one finding: { decision: "accepted" | "rejected", note? }
  app.post(
    "/api/projects/:id/findings/:findingId",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { decision?: unknown; note?: unknown };
      const decision = b.decision === "accept" ? "accepted" : b.decision === "reject" ? "rejected" : b.decision;
      try {
        res.json(rt.reviews.decide(String(req.params.findingId), decision as "accepted" | "rejected", typeof b.note === "string" && b.note.trim() ? b.note.trim() : undefined));
      } catch (err) { bad(res, err); }
    }),
  );
}
