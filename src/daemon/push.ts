/**
 * Phone push — the daemon's side of fire-and-notify.
 *
 * Paired devices register an Expo push token; when an agent needs input or
 * work lands, the daemon POSTs to Expo's push API (no APNs/FCM credentials
 * to manage). Route hops are deliberately NOT pushed — a 5-step pipeline
 * should buzz your pocket once, not five times.
 *
 * LOOM_NO_PUSH=1 disables sending; LOOM_EXPO_PUSH_URL overrides the endpoint
 * (used by tests to point at a mock).
 */

import type { LoomEvent } from "../types.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Kinds that reach the phone. run_complete is filtered upstream during routes. */
export const PUSH_KINDS = new Set(["needs_input", "run_complete", "route_completed", "route_failed"]);

export function pushContent(projectName: string, event: LoomEvent): PushMessage {
  const title = `Loom · ${projectName}`;
  const p = event.payload;
  switch (event.kind) {
    case "needs_input":
      return { title, body: `${event.agentId} asks: ${String(p.question ?? "").slice(0, 140)}` };
    case "run_complete":
      return { title, body: `${event.agentId} finished its turn` };
    case "route_completed":
      return { title, body: `✔ route complete (${Number(p.steps ?? 0)} steps)` };
    case "route_failed":
      return {
        title,
        body: `${p.aborted ? "⊘ route stopped" : "✗ route failed"}: ${String(p.reason ?? "").slice(0, 120)}`,
      };
    default:
      return { title, body: event.kind };
  }
}

/** Send one message to many devices in a single Expo batch call. Best-effort. */
export async function sendExpoPush(tokens: string[], message: PushMessage): Promise<void> {
  if (!tokens.length || process.env.LOOM_NO_PUSH) return;
  const url = process.env.LOOM_EXPO_PUSH_URL ?? EXPO_PUSH_URL;
  const batch = tokens.map((to) => ({
    to,
    title: message.title,
    body: message.body,
    sound: "default",
    ...(message.data ? { data: message.data } : {}),
  }));
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Push is best-effort by design; the event log remains the source of truth.
  }
}
