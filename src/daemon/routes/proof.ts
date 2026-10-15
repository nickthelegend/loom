import type { Express } from 'express';
import type { WithRuntime } from './context.js';
import { MAIN_CHAT } from "../../types.js";

/** Register Proof routes (daemon/proof.ts) in the order established by LoomDaemon.routes(). */
export function registerProofRoutes(app: Express, withRuntime: WithRuntime): void {
  // Check a finished turn: the newest in the chat, or the one ending at ?at (a run_complete id).
  // It re-runs the tests in a clean checkout, so it can take as long as the tests do.
  app.post(
    "/api/projects/:id/proof",
    withRuntime(async (rt, req, res) => {
      const b = (req.body ?? {}) as { chat?: unknown; at?: unknown; testCommand?: unknown };
      const chat = typeof b.chat === "string" && b.chat ? b.chat : MAIN_CHAT;
      const at = typeof b.at === "number" && Number.isFinite(b.at) ? b.at : undefined;
      const testCommand = typeof b.testCommand === "string" && b.testCommand.trim() ? b.testCommand.trim().slice(0, 500) : undefined;
      try {
        const result = await rt.proofs.prove(chat, { ...(at ? { at } : {}), ...(testCommand ? { testCommand } : {}) });
        if (!result) return void res.status(404).json({ error: "no finished agent turn to check in this chat" });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
}
