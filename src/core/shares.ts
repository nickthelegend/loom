/**
 * Read-only thread links (#199): a teammate opens a link and reads a chat — prompts, replies,
 * what ran, what changed — as the replay page (core/replay.ts), without pairing or a token of
 * their own. Each link is a random token that expires and can be revoked; only its SHA-256 is
 * kept on disk, so the shares file alone opens nothing. ~/.loom/shares.json.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loomHome } from "./registry.js";

export interface Share {
  /** Short id to list and revoke by (not the token). */
  id: string;
  /** sha256 of the token. */
  hash: string;
  projectId: string;
  chat: string;
  title: string;
  createdAt: number;
  expiresAt: number;
}

export const MAX_SHARE_HOURS = 24 * 30;
const file = () => path.join(loomHome(), "shares.json");
const sha = (token: string) => createHash("sha256").update(token).digest("hex");

function load(): Share[] {
  try { return (JSON.parse(fs.readFileSync(file(), "utf8")) as Share[]).filter((s) => s && s.hash); } catch { return []; }
}
function save(shares: Share[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(shares, null, 2) + "\n", { mode: 0o600 });
}

/** A new link for one chat, good for `hours` (1 h to 30 days). The token is returned once. */
export function createShare(input: { projectId: string; chat: string; title: string; hours?: number }, now = Date.now()): { share: Share; token: string } {
  const hours = Math.min(MAX_SHARE_HOURS, Math.max(1, Math.round(input.hours ?? 24)));
  const token = randomBytes(24).toString("base64url");
  const share: Share = { id: randomBytes(4).toString("hex"), hash: sha(token), projectId: input.projectId, chat: input.chat,
    title: input.title, createdAt: now, expiresAt: now + hours * 3_600_000 };
  save([...load().filter((s) => s.expiresAt > now), share]);
  return { share, token };
}

/** The share a token opens — null when there's none, or it expired or was revoked. */
export function openShare(token: string, now = Date.now()): Share | null {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const h = sha(token);
  return load().find((s) => s.hash === h && s.expiresAt > now) ?? null;
}

export function listShares(now = Date.now()): Share[] {
  return load().filter((s) => s.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt);
}

/** Revoke by id; true when there was one. */
export function revokeShare(id: string): boolean {
  const all = load();
  const left = all.filter((s) => s.id !== id);
  if (left.length === all.length) return false;
  save(left);
  return true;
}
