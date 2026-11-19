import { readBridges } from "../../daemon/chat-bridge.js";
import { readEmail } from "../../daemon/email-digest.js";
import { sendMail } from "../smtp.js";
import { readProjectState, readDaemonConfig } from "../registry.js";
import { sendExpoPush, wantsPush } from "../../daemon/push.js";
import { costSettings } from "./settings.js";
import { budgetEvent, budgetNotices, invalidateCostSnapshot, type CostHost } from "./budgets.js";
import type { LoomEvent } from "../../types.js";

const deliveryKeys = new WeakMap<CostHost["log"], Set<string>>();

/** Reuse configured destinations; project preferences never expose machine credentials. */
export async function deliverSpendAlert(host: CostHost, event: LoomEvent, mail: typeof sendMail = sendMail): Promise<void> {
  const channels = costSettings(host.info.dir).alerts;
  if (!budgetEvent(event) || !channels.length) return;
  const text = `${host.info.name}: ${String(event.payload.text ?? `Agent ${event.agentId} budget reached; paused.`)}`;
  let seen = deliveryKeys.get(host.log);
  if (!seen) {
    seen = new Set(host.log.list({ kinds: ["status"], allBranches: true }).filter(e => e.payload.state === "cost_alert_delivered").map(e => String(e.payload.key)));
    deliveryKeys.set(host.log, seen);
  }
  for (const channel of channels) {
    const key = `${event.id}:${channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (channel === "push") {
        const tokens = (readDaemonConfig()?.clients ?? []).filter(c => !c.guest && (!c.projects?.length || c.projects.includes(host.info.id)) && wantsPush(c.pushKinds, "questions")).map(c => c.pushToken).filter((t): t is string => Boolean(t));
        if (!tokens.length) throw new Error("No paired phone has budget notifications enabled");
        await sendExpoPush(tokens, { title: "Loom spend alert", body: text, data: { projectId: host.info.id, chat: event.chat ?? "main" } });
      } else if (channel === "email") {
        const email = readEmail();
        if (!email.enabled) throw new Error("Configure email in Settings first");
        await mail(email, "Loom spend alert", text);
      } else {
        const cfg = readBridges()[channel];
        if (!cfg?.enabled || !cfg.channels[0] || (cfg.project && ![host.info.id, host.info.name].includes(cfg.project))) throw new Error(`Configure ${channel} for this project first`);
        const url = channel === "slack" ? (process.env.LOOM_SLACK_API || "https://slack.com/api") + "/chat.postMessage" : `${process.env.LOOM_DISCORD_API || "https://discord.com/api/v10"}/channels/${encodeURIComponent(cfg.channels[0])}/messages`;
        const response = await fetch(url, { method: "POST", headers: { authorization: `${channel === "slack" ? "Bearer" : "Bot"} ${cfg.botToken}`, "content-type": "application/json" },
          body: JSON.stringify(channel === "slack" ? { channel: cfg.channels[0], text, mrkdwn: false } : { content: text, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (!response.ok) throw new Error(`${channel} returned ${response.status}`);
        if (channel === "slack" && !(await response.json() as { ok: boolean }).ok) throw new Error("Slack rejected the notification");
      }
      host.log.append({ kind: "status", payload: { state: "cost_alert_delivered", key, channel } });
    } catch (e) {
      seen.delete(key);
      host.log.append({ kind: "status", payload: { state: "cost_alert_failed", key, channel, text: (e as Error).message } });
    }
  }
}
export function observeCostBudgets(host: CostHost): void {
  let pending = Promise.resolve();
  host.log.onEvent?.(event => {
    if (event.kind === "run_complete" || (event.kind === "status" && event.payload.state === "turn_cost")) {
      invalidateCostSnapshot(host);
      const s = costSettings(host.info.dir);
      if (s.monthlyUsd || s.dailyUsd || Object.keys(s.chats).length || Object.keys(readProjectState(host.info.dir).budgets ?? {}).length) {
        // Publish the triggering event first, so nested notices cannot overtake its event ID.
        pending = pending.then(() => budgetNotices(host, event.chat ?? "main")).catch(() => {});
      }
    }
    // The new agent notice includes both 80% and 100%; do not send the old pause a second time.
    if (budgetEvent(event) && (event.payload.state !== "budget_exceeded" || event.payload.wouldCross)) pending = pending.then(() => deliverSpendAlert(host, event)).catch(() => {});
  });
}
