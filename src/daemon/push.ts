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

/**
 * What a push is about — the kinds a phone can switch on and off:
 *   questions  an agent (or a goal, or a crew) is waiting on your answer
 *   approvals  a tool call is waiting on Allow / Deny, or a crew's plan on approval
 *   done       an agent finished a turn in a chat of yours
 *   goals      an Orchestra run, race, crew goal or route finished, failed or needs you
 *   updates    a new Loom release is out (LoomDaemon.watchReleases)
 */
export type PushCategory = "questions" | "approvals" | "done" | "goals" | "updates";
export const PUSH_CATEGORIES: PushCategory[] = ["questions", "approvals", "done", "goals", "updates"];

/** Kinds that reach the phone. run_complete is filtered upstream during routes. */
export const PUSH_KINDS = new Set(["needs_input", "run_complete", "route_completed", "route_failed"]);

/** Which category this event pushes under, or null when it doesn't buzz the phone. */
export function pushCategory(event: LoomEvent): PushCategory | null {
  const p = event.payload ?? {};
  switch (event.kind) {
    case "needs_input": return "questions";
    case "run_complete": return "done";
    case "route_completed": case "route_failed": return "goals";
    case "approval": return p.phase === "requested" ? "approvals" : null;
    case "orchestra":
      if (p.phase === "alert" || p.phase === "completed" || p.phase === "failed" || p.phase === "aborted") return "goals";
      return p.phase === "waiting" ? "questions" : null;
    case "crew":
      if (p.phase === "completed" || p.phase === "failed") return "goals";
      if (p.phase === "asks") return "questions";
      return p.phase === "planned" && p.awaitingApproval ? "approvals" : null;
    default: return null;
  }
}

/** May this device get this category? A device that never chose gets them all. */
export function wantsPush(kinds: string[] | undefined, category: PushCategory): boolean {
  return !kinds || kinds.includes(category);
}

/** Does this event buzz the phone? */
export function shouldPush(event: LoomEvent): boolean {
  return pushCategory(event) !== null;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function pushContent(projectName: string, event: LoomEvent, extra: { reply?: string } = {}): PushMessage {
  const title = `Loom · ${projectName}`;
  const p = event.payload;
  switch (event.kind) {
    case "needs_input":
      return { title: `${event.agentId ?? "An agent"} needs you · ${projectName}`, body: clip(p.question, 160) || "it's waiting on your answer" };
    case "run_complete":
      return { title: `${event.agentId ?? "An agent"} is done · ${projectName}`, body: extra.reply ? clip(extra.reply, 160) : "finished its turn" };
    case "approval":
      return { title: `${event.agentId ?? "An agent"} wants to use ${clip(p.tool, 40)} · ${projectName}`, body: clip(p.input, 140) || "Allow or deny it" };
    case "route_completed":
      return { title, body: `✔ route complete (${Number(p.steps ?? 0)} steps)` };
    case "route_failed":
      return {
        title,
        body: `${p.aborted ? "⊘ route stopped" : "✗ route failed"}: ${String(p.reason ?? "").slice(0, 120)}`,
      };
    case "orchestra":
      if (p.phase === "completed") return { title: `Goal done · ${projectName}`, body: clip(p.summary ?? p.goal, 160) || "the run finished" };
      if (p.phase === "failed" || p.phase === "aborted") return { title: `Goal ${p.phase} · ${projectName}`, body: clip(p.error ?? p.goal, 160) };
      if (p.phase === "waiting") return { title: `A goal needs you · ${projectName}`, body: clip(p.question, 160) };
      return { title, body: String(p.text ?? "a goal needs you").slice(0, 160) };
    case "crew":
      if (p.phase === "completed") return { title: `${clip(p.crew, 40) || "Crew"} finished · ${projectName}`, body: clip(p.summary ?? p.text, 160) || "the goal is done — apply it when you're ready" };
      if (p.phase === "failed") return { title: `${clip(p.crew, 40) || "Crew"} stopped · ${projectName}`, body: clip(p.error, 160) || "the goal failed" };
      if (p.phase === "asks") return { title: `${clip(p.teammate, 30) || "A teammate"} asks · ${projectName}`, body: clip(p.question, 160) };
      if (p.phase === "planned") return { title: `${clip(p.crew, 40) || "Crew"} has a plan · ${projectName}`, body: "approve it to start building" };
      return { title, body: String(p.phase ?? "crew") };
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
