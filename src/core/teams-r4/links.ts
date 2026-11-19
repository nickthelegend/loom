import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { loomHome } from "../registry.js";
import { redactText } from "../redact.js";

export interface ChangeFile { path: string; diff: string }
export interface Handoff { summary: string; branch: string; questions: string[]; note: string; to: string }
export interface Annotation {
  id: string; at: number; name: string; text: string; messageId?: number;
  verdict?: "approve" | "request-changes"; reply?: string;
}
export interface LinkDetails {
  projectId?: string; chat?: string; expiresAt?: number;
  passcode?: { salt: string; hash: string };
  notifyFirstOpen?: boolean; views: number; lastOpenedAt?: number;
  changes?: { branch: string; files: ChangeFile[] }; handoff?: Handoff; reviewer?: string;
  annotations: Annotation[]; submissions: number;
}
export const MAX_LINK_COMMENTS = 100;
const file = () => path.join(loomHome(), "teams-r4-links.json");
let cache: { path: string; mtimeMs: number; size: number; data: Record<string, LinkDetails> } | undefined;
function read(): Record<string, LinkDetails> {
  const name = file();
  try {
    const stat = fs.statSync(name);
    if (cache?.path === name && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.data;
    const data = JSON.parse(fs.readFileSync(name, "utf8")) as Record<string, LinkDetails>;
    cache = { path: name, mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { cache = undefined; return {}; } throw e; }
}
function stripPayload(details: LinkDetails): void {
  delete details.changes; delete details.handoff; delete details.passcode;
}
function save(all: Record<string, LinkDetails>) {
  const now = Date.now();
  for (const [id, details] of Object.entries(all)) {
    if (details.expiresAt === undefined || details.expiresAt > now) continue;
    if (details.expiresAt + 30 * 86400000 <= now) delete all[id];
    else stripPayload(details);
  }
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file() + ".tmp", JSON.stringify(all) + "\n", { mode: 0o600 });
  fs.renameSync(file() + ".tmp", file());
  const stat = fs.statSync(file());
  cache = { path: file(), mtimeMs: stat.mtimeMs, size: stat.size, data: all };
}
export function linkDetails(id: string): LinkDetails { return structuredClone(read()[id] ?? { views: 0, annotations: [], submissions: 0 }); }
/** Keep annotations available for owner moderation after the public link is revoked. */
export function dropLinkPayload(id: string): void {
  const all = read();
  if (!all[id]) return;
  stripPayload(all[id]); save(all);
}
export function configureLink(id: string, input: { projectId?: string; chat?: string; expiresAt?: number; passcode?: unknown; notifyFirstOpen?: unknown; changes?: LinkDetails["changes"]; handoff?: Handoff; reviewer?: string }): void {
  const all = read(), details = linkDetails(id);
  if (input.expiresAt !== undefined) details.expiresAt = input.expiresAt;
  if (input.projectId) details.projectId = input.projectId;
  if (input.chat) details.chat = input.chat;
  if (input.passcode !== undefined && input.passcode !== "") {
    if (typeof input.passcode !== "string" || input.passcode.length < 4 || input.passcode.length > 128) throw new Error("passcode must have 4–128 characters");
    const salt = randomBytes(16).toString("hex");
    details.passcode = { salt, hash: scryptSync(input.passcode, salt, 32).toString("hex") };
  }
  if (input.notifyFirstOpen !== undefined && typeof input.notifyFirstOpen !== "boolean") throw new Error("notifyFirstOpen must be boolean");
  details.notifyFirstOpen = input.notifyFirstOpen === true;
  if (input.changes) details.changes = input.changes;
  if (input.handoff) details.handoff = input.handoff;
  if (input.reviewer) details.reviewer = input.reviewer;
  all[id] = details; save(all);
}
export function acceptsPasscode(id: string, value: unknown): boolean {
  const pass = linkDetails(id).passcode;
  if (!pass) return true;
  if (typeof value !== "string" || value.length > 128) return false;
  return timingSafeEqual(Buffer.from(pass.hash, "hex"), scryptSync(value, pass.salt, 32));
}
export function linkStats(id: string) {
  const d = linkDetails(id);
  return { passcodeProtected: Boolean(d.passcode), views: d.views, lastOpenedAt: d.lastOpenedAt ?? null, notifyFirstOpen: Boolean(d.notifyFirstOpen), ...(d.reviewer ? { reviewer: d.reviewer } : {}), ...(d.changes ? { changes: true } : {}) };
}
/** Count successful page opens only; polling annotations never increments a view. */
export function recordOpen(id: string, now = Date.now()): boolean {
  const all = read(), d = linkDetails(id), notify = d.views === 0 && d.notifyFirstOpen === true;
  d.views++; d.lastOpenedAt = now; all[id] = d; save(all); return notify;
}
export function addAnnotation(id: string, input: { name?: unknown; text?: unknown; messageId?: unknown; verdict?: unknown }): Annotation {
  const all = read(), d = linkDetails(id);
  if (d.submissions >= MAX_LINK_COMMENTS) throw new Error(`this link has reached its ${MAX_LINK_COMMENTS} comment limit`);
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) throw new Error("name must have 1–80 characters");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000) throw new Error("note must have 1–4000 characters");
  if (input.verdict !== undefined && (!d.reviewer || !["approve", "request-changes"].includes(String(input.verdict)))) throw new Error("this link does not accept that review verdict");
  if (input.verdict && d.annotations.some(a => a.verdict)) throw new Error("this review already has a verdict");
  if (input.messageId !== undefined && (!Number.isSafeInteger(input.messageId) || Number(input.messageId) < 1)) throw new Error("invalid message id");
  const annotation: Annotation = { id: randomBytes(8).toString("hex"), at: Date.now(), name: redactText(input.name.trim()), text: redactText(input.text.trim()),
    ...(input.messageId !== undefined ? { messageId: Number(input.messageId) } : {}),
    ...(input.verdict ? { verdict: input.verdict as Annotation["verdict"] } : {}) };
  d.annotations.push(annotation); d.submissions++; all[id] = d; save(all); return annotation;
}
export function moderateAnnotation(id: string, annotationId: string, reply?: unknown): void {
  const all = read(), d = linkDetails(id), row = d.annotations.find(a => a.id === annotationId);
  if (!row) throw new Error("no such annotation");
  if (reply === undefined) d.annotations = d.annotations.filter(a => a.id !== annotationId);
  else {
    if (typeof reply !== "string" || !reply.trim() || reply.length > 4000) throw new Error("reply must have 1–4000 characters");
    row.reply = redactText(reply.trim());
  }
  all[id] = d; save(all);
}

export function projectAnnotations(projectId: string, chat: string) {
  return Object.entries(read()).filter(([, d]) => d.projectId === projectId && d.chat === chat).flatMap(([shareId, d]) => d.annotations.map(a => ({ ...a, shareId })));
}
