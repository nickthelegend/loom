import type { AgentConfig } from "../../types.js";
import { listModelsForKind } from "../../daemon/system.js";
import type { RuntimeTurnsHost, TurnOptions } from "../../daemon/runtime/turns.js";
import { budgetSnapshot, enforceCostBudget } from "./budgets.js";
import { costSettings } from "./settings.js";

/** Use the same catalog as the agent model picker, never an alias from another CLI. */
export async function canUseSaver(cfg: Pick<AgentConfig, "kind"> | undefined, model: string): Promise<boolean> {
  if (!cfg) return false;
  if (cfg.kind === "model" || cfg.kind === "model-pool") return true;
  return (await listModelsForKind(cfg.kind)).models.includes(model);
}

/** Explicit entry hook: no replacement of another batch's turn methods. */
export async function prepareCostTurn(host: RuntimeTurnsHost, agentId: string | undefined, opts: TurnOptions) {
  const chat = opts.chat ?? "main";
  enforceCostBudget(host, chat);
  const binding = host.chatBinding(chat), id = agentId ?? binding.agentId ?? host.validHolder() ?? host.defaultAdapterId();
  const cfg = host.config.agents.find(a => a.id === id);
  const explicit = opts.model || opts.capturedModel || (binding.agentId === id && binding.model) || cfg?.options?.model;
  const saver = !explicit && costSettings(host.info.dir).saver ? budgetSnapshot(host).saver : null;
  const selected = saver?.active && await canUseSaver(cfg, saver.model) ? saver : null;
  return {
    opts: selected ? { ...opts, model: selected.model, ...(opts.capturedModel === null ? { capturedModel: selected.model } : {}) } : opts,
    accepted: () => {
      if (selected) host.log.append({ kind: "message", chat, payload: { author: "loom", state: "cost_saver", model: selected.model, alias: selected.alias,
        text: `Saver mode: ${selected.alias} (${selected.model}) for this turn.` } });
    },
  };
}
