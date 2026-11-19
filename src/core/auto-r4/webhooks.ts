import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { projectWebhookSecret } from "../orchestra-options.js";
import { readJson, writeJson } from "./state.js";
import { outgoingEvents } from "./model.js";

export interface OutgoingWebhook { id: string; url: string; events: string[]; enabled: boolean; createdAt?: number }
export interface Delivery { id: string; webhook: string; event: string; body: string; at: number; attempts: number; nextAt?: number; status: "pending" | "sent" | "failed"; error?: string; httpStatus?: number }
interface WebhookState { webhooks: OutgoingWebhook[]; deliveries: Delivery[] }
const file = (dir: string) => path.join(dir, ".loom", "outgoing-webhooks.json");
export const readWebhooks = (dir: string) => readJson<WebhookState>(file(dir), { webhooks: [], deliveries: [] });
export const writeWebhooks = (dir: string, state: WebhookState) => writeJson(file(dir), state);
export function addWebhook(dir: string, url: string, events: string[]): OutgoingWebhook {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("webhook must be an HTTP(S) URL without credentials or fragment");
  if (!events.length || events.some(e => !outgoingEvents.includes(e))) throw new Error(`events must be from ${outgoingEvents.join(", ")}`);
  const state = readWebhooks(dir);
  if (state.webhooks.length >= 50) throw new Error("50 outgoing webhooks per project is the limit");
  const webhook = { id: randomUUID(), url: parsed.href, events: [...new Set(events)], enabled: true, createdAt: Date.now() };
  state.webhooks.push(webhook); writeWebhooks(dir, state); return webhook;
}
export function queueWebhooks(dir: string, project: string, event: string, payload: unknown, key: string, eventAt = Date.now()): void {
  const state = readWebhooks(dir);
  for (const hook of state.webhooks.filter(w => w.enabled && w.events.includes(event) && (w.createdAt ?? 0) <= eventAt)) {
    const id = `${hook.id}:${key}:${event}`;
    if (state.deliveries.some(d => d.id === id)) continue;
    state.deliveries.push({ id, webhook: hook.id, event, body: JSON.stringify({ event, project, payload }), at: Date.now(), attempts: 0, status: "pending", nextAt: Date.now() });
  }
  // Never trim pending work while bounding the completed delivery log.
  state.deliveries = [...state.deliveries.filter(d => d.status !== "pending").slice(-200), ...state.deliveries.filter(d => d.status === "pending")];
  writeWebhooks(dir, state);
}
export function resendWebhook(dir: string, id: string): Delivery {
  const state = readWebhooks(dir), prior = state.deliveries.find(d => d.id === id);
  if (!prior || !state.webhooks.some(w => w.id === prior.webhook && w.enabled)) throw new Error("delivery or enabled webhook not found");
  const delivery: Delivery = { ...prior, id: randomUUID(), at: Date.now(), attempts: 0, status: "pending", nextAt: Date.now(), error: undefined, httpStatus: undefined };
  state.deliveries.push(delivery); writeWebhooks(dir, state); return delivery;
}
export class WebhookSender {
  private busy = new Set<string>();
  async tick(dir: string, now = Date.now()): Promise<void> {
    if (this.busy.has(dir)) return;
    this.busy.add(dir);
    try {
      const state = readWebhooks(dir);
      for (const item of state.deliveries.filter(d => d.status === "pending" && (d.nextAt ?? 0) <= now).slice(0, 10)) {
        const hook = state.webhooks.find(w => w.id === item.webhook && w.enabled);
        let error: string | undefined, status: number | undefined;
        try {
          if (!hook) throw new Error("webhook removed or disabled");
          const signature = createHmac("sha256", projectWebhookSecret(dir)).update(item.body).digest("hex");
          const response = await fetch(hook.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body: item.body,
            headers: { "content-type": "application/json", "x-loom-signature-256": `sha256=${signature}`, "x-loom-delivery": item.id } });
          status = response.status; await response.body?.cancel();
          if (!response.ok) throw new Error(`HTTP ${status}`);
        } catch (e) { error = (e as Error).message; }
        const fresh = readWebhooks(dir), delivery = fresh.deliveries.find(d => d.id === item.id);
        if (!delivery) continue;
        delivery.attempts++; delivery.httpStatus = status; delivery.error = error;
        delivery.status = !error ? "sent" : delivery.attempts >= 5 || !hook ? "failed" : "pending";
        delivery.nextAt = delivery.status === "pending" ? now + 1000 * 2 ** delivery.attempts : undefined;
        writeWebhooks(dir, fresh);
      }
    } finally { this.busy.delete(dir); }
  }
}
