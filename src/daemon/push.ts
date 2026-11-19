import { heldApprovals, approvalPending, recordHeldApproval } from "../core/phone-r4/held-approvals.js";
import { readDaemonConfig } from "../core/registry.js";
import { permitsPush, preferences } from "../core/phone-r4/preferences.js";
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
  /** A notification category the phone registered: "loom-approval" shows Allow / Deny on the alert itself. */
  categoryId?: string;
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
    // a "done" that didn't hold is news; a verified one repeats the done push
    case "proof": return p.verdict === "contradicted" ? "done" : null;
    case "route_completed": case "route_failed": return "goals";
    // an agent out of quota: the work changed hands, or waits for the reset
    // an agent out of quota: the work changed hands, or waits for the reset; an agent going in circles needs you
    case "status": return p.state === "quota_relay" || p.state === "quota_limit" ? "done" : p.state === "loop_detected" || p.state === "shield_tripped" ? "questions" : null;
    case "approval": return p.phase === "requested" ? "approvals" : null;
    // the morning report: a night shift's work, done
    case "shift": return p.phase === "report" ? "goals" : null;
    // the reviewers have all answered: findings to accept or reject
    case "review": return p.phase === "done" ? "goals" : null;
    case "council": return p.phase === "done" ? "goals" : null;
    case "orchestra":
      if (p.phase === "alert" || p.phase === "completed" || p.phase === "failed" || p.phase === "aborted") return "goals";
      return p.phase === "waiting" ? "questions" : null;
    case "crew":
      if (p.phase === "paused" || p.phase === "team_hold" || p.phase === "race_ready") return "questions";
      if (p.phase === "request_received") return "approvals";
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
    case "status":
      if (p.state === "quota_relay" || p.state === "quota_limit")
        return { title: `${String(p.from ?? event.agentId ?? "An agent")} ran out of quota · ${projectName}`, body: clip(p.text, 160) };
      if (p.state === "shield_tripped") return { title: `⛔ ${event.agentId ?? "An agent"} ran ${clip(p.what, 50)} · ${projectName}`,
        body: `${clip(p.command, 110)}${p.stopped ? " — Loom stopped the turn" : ""}` };
      if (p.state === "loop_detected") return { title: `${event.agentId ?? "An agent"} is going in circles · ${projectName}`,
        body: `${clip(p.text, 140)}${p.nudged ? " — Loom stopped it and asked it to step back" : " — Stop, Nudge or hand it off"}` };
      return { title, body: clip(p.text ?? p.state, 160) };
    case "proof":
      return { title: `⚠ ${String(p.about ?? "An agent")}'s “done” didn't hold · ${projectName}`, body: clip(p.headline, 160) };
    case "run_complete":
      return { title: `${event.agentId ?? "An agent"} is done · ${projectName}`, body: extra.reply ? clip(extra.reply, 160) : "finished its turn" };
    case "approval":
      return { title: `${event.agentId ?? "An agent"} wants to use ${clip(p.tool, 40)} · ${projectName}`, body: clip(p.input, 140) || "Allow or deny it" };
    case "shift":
      if (p.phase === "report") return { title: `🌙 Night shift done · ${projectName}`, body: `${clip(p.summary, 140)}${p.stopped ? ` — stopped: ${clip(p.stopped, 60)}` : ""}` };
      return { title, body: "night shift started" };
    case "council":
      return { title: `🏛 Council ${p.status === "done" ? "done" : String(p.status ?? "ended")} · ${projectName}`, body: clip(p.summary, 160) };
    case "review":
      return { title: `🔍 Review done · ${projectName}`, body: clip(p.summary, 160) || "the reviewers answered" };
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
      if (p.phase === "paused") return { title: `Crew paused · ${projectName}`, body: clip(p.reason, 160) || "Review its budget and resume when ready" };
      if (p.phase === "team_hold") return { title: `Crew held · ${projectName}`, body: clip((p.hold as { reason?: string } | undefined)?.reason, 160) || "Review the overlapping card before continuing" };
      if (p.phase === "race_ready") return { title: `Choose a crew result · ${projectName}`, body: "The race results are ready for your review" };
      if (p.phase === "request_received") return { title: `Crew request · ${projectName}`, body: `${clip(p.from, 40)} requests ${clip(p.teammate, 40)}. Accept or decline in Crew.` };
      if (p.phase === "completed") return { title: `${clip(p.crew, 40) || "Crew"} finished · ${projectName}`, body: clip(p.summary ?? p.text, 160) || "the goal is done — apply it when you're ready" };
      if (p.phase === "failed") return { title: `${clip(p.crew, 40) || "Crew"} stopped · ${projectName}`, body: clip(p.error, 160) || "the goal failed" };
      if (p.phase === "asks") return { title: `${clip(p.teammate, 30) || "A teammate"} asks · ${projectName}`, body: clip(p.question, 160) };
      if (p.phase === "planned") return { title: `${clip(p.crew, 40) || "Crew"} has a plan · ${projectName}`, body: "approve it to start building" };
      return { title, body: String(p.phase ?? "crew") };
    default:
      return { title, body: event.kind };
  }
}

/** The machine is part of the key because a phone can pair with several computers. */
export function projectPushGroup(data: Record<string, unknown>): string {
  return `loom:${encodeURIComponent(String(data.daemon ?? ""))}:${encodeURIComponent(String(data.projectId ?? ""))}`;
}

/** Send one message to many devices in a single Expo batch call. Best-effort. */
export async function sendExpoPush(tokens: string[], message: PushMessage, groupedAndroid: ReadonlySet<string> = new Set()): Promise<void> {
  if (!tokens.length || process.env.LOOM_NO_PUSH) return;
  const clients = readDaemonConfig()?.clients ?? [];
  const recipients = new Map<string, string>();
  tokens = [...new Set(tokens)].filter(token => {
    const matches = clients.filter(c => c.pushToken === token).sort((a, b) => b.createdAt - a.createdAt);
    const category = String(message.data?.category ?? "updates");
    const project = typeof message.data?.projectId === "string" ? message.data.projectId : undefined;
    const chat = String(message.data?.chat ?? "main");
    const eligibleAll = matches.filter(c => {
      if (c.guest && (!project || c.guest.project !== project || c.guest.chat !== chat || c.guest.expiresAt <= Date.now())) return false;
      if (project && c.projects?.length && !c.projects.includes(project)) return false;
      if (message.data?.category && c.pushKinds && !c.pushKinds.includes(category)) return false;
      return true;
    });
    // One phone can sit behind several pairings (re-paired, old one not revoked). Quiet hours and mutes on any of
    // them hold the push: picking "the newest" is ambiguous when two were paired in the same millisecond.
    const eligible = eligibleAll[0];
    const permitted = () => eligibleAll.every(c => permitsPush(preferences(c.id), category, project, chat));
    const chosen = eligible && permitted() ? eligible : undefined;
    const approvalId = message.data?.approvalId;
    if (eligible && !chosen && category === "approvals" && project && typeof approvalId === "string") {
      recordHeldApproval(project, approvalId);
      heldApprovals.hold(`${project}:${approvalId}:${token}`, {
        pending: () => approvalPending(project, approvalId) && (readDaemonConfig()?.clients ?? []).some(c => c.id === eligible.id && c.pushToken === token),
        permitted,
        send: () => sendExpoPush([token], message, groupedAndroid),
      });
    }
    if (chosen) recipients.set(token, chosen.id);
    return !matches.length || Boolean(chosen);
  });
  if (!tokens.length) return;
  if (message.data?.kind === "run_complete" || message.data?.kind === "needs_input") message = { ...message, categoryId: "loom-reply" };
  const url = process.env.LOOM_EXPO_PUSH_URL ?? EXPO_PUSH_URL;
  const batch = tokens.map((to) => {
    const group = message.data?.projectId ? projectPushGroup(message.data) : undefined;
    const androidData = group && groupedAndroid.has(to);
    return {
      to,
      ...(androidData ? { priority: "high" } : { title: message.title, body: message.body, sound: "default" }),
      ...(group ? { threadId: group } : {}),
      ...(message.data ? { data: { ...message.data, clientId: recipients.get(to), ...(group ? { projectGroup: group } : {}),
        ...(androidData ? { loomTitle: message.title, loomBody: message.body } : {}) } } : {}),
      ...(message.categoryId ? { categoryId: message.categoryId } : {}),
    };
  });
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
