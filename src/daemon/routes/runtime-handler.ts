import { ChatMoveError } from "../../core/chat-move.js";
import { type Request, type Response } from "express";
import { NotHolderError } from "../../core/baton.js";
import { logbook } from "../../core/logbook.js";
import { RouteActiveError } from "../../core/routes.js";
import { BudgetExceededError, ProjectRuntime, QuarantinedError } from "../runtime.js";
import type { RouteContext, WithRuntime } from './context.js';
export function createRuntimeHandler(ctx: Pick<RouteContext, "runtime">): WithRuntime {

  const withRuntime: WithRuntime = (
    handler: (rt: ProjectRuntime, req: Request, res: Response) => Promise<void>,
  ) => {
    return (req: Request, res: Response) => {
      void (async () => {
        try {
          const rt = await ctx.runtime(String(req.params.id));
          await handler(rt, req, res);
        } catch (err) {
          if (err instanceof ChatMoveError) { res.status(err.status).json({ error: err.message }); return; }
          if (err instanceof NotHolderError) {
            res.status(409).json({
              error: "not_holder",
              holder: err.holder,
              agentId: err.agentId,
              message: err.message,
            });
            return;
          }
          if (err instanceof RouteActiveError) {
            res.status(409).json({ error: "route_active", message: err.message });
            return;
          }
          // Same 409 family: a firing alert has this agent out of rotation,
          // and the client should say so rather than "500".
          if (err instanceof QuarantinedError) {
            res.status(409).json({
              error: "agent_quarantined",
              agentId: err.agentId,
              reason: err.reason,
              since: err.since,
              message: err.message,
            });
            return;
          }
          // 409, like the other "the fleet is in a state that forbids this"
          // refusals. The numbers ride along so a client can say what the cap
          // was and what has been spent against it, without guessing.
          if (err instanceof BudgetExceededError) {
            res.status(409).json({
              error: "budget_exceeded",
              agentId: err.agentId,
              budgetUsd: err.budgetUsd,
              spentTodayUsd: err.spentUsd,
              message: err.message,
            });
            return;
          }
          // A 500 used to be a sentence for one caller and nothing else: no
          // stack, no record, gone the moment the fetch resolved. Now the
          // Console gets it with the stack and the route that produced it.
          logbook.error(
            "api",
            `${req.method} ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
            String(req.params.id ?? ""),
          );
          res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
      })();
    };
  };
  return withRuntime;
}
