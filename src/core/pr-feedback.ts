import { recordIntakePr } from "./intake.js";
import fs from "node:fs";
import path from "node:path";

export type PrFeedbackMode = "off" | "ci" | "ci+reviews";

/** GET /api/projects/:id/prs returns { prs: TrackedPr[] }. Terminal rows remain
 * visible as history, but only OPEN rows are polled. Times are epoch milliseconds.
 */
export interface TrackedPr {
  prNumber: number;
  /** GitHub owner/name, or hostname/owner/name for GitHub Enterprise. */
  repo: string;
  chat: string;
  agentId?: string;
  /** Manually attached PRs and maintenance PRs use delivery. */
  source: "delivery" | "board" | "orchestra";
  openedAt: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  mergeable?: string;
  headRefOid?: string;
  checkedAt?: number;
}

export interface PrRecord extends TrackedPr {
  signatures: string[];
}

export function prFromUrl(url: string): { prNumber: number; repo: string } {
  const u = new URL(url);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(u.pathname);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !match || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error("PR must be a positive number or an HTTPS pull request URL");
  }
  return { prNumber: Number(match[3]), repo: `${u.hostname === "github.com" ? "" : `${u.hostname}/`}${match[1]}/${match[2]}` };
}

export function readPrRecords(dir: string): PrRecord[] {
  try { return JSON.parse(fs.readFileSync(path.join(dir, ".loom", "prs.json"), "utf8")) as PrRecord[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function savePrRecord(dir: string, record: PrRecord): void {
  const rows = readPrRecords(dir);
  const i = rows.findIndex(p => p.repo === record.repo && p.prNumber === record.prNumber);
  if (i < 0) rows.push(record); else rows[i] = record;
  const file = path.join(dir, ".loom", "prs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** Record immediately after creation, including each slice of a PR stack. The
 * first owning chat wins, so pushing a fix cannot move feedback to another chat.
 */
export function recordOpenedPr(dir: string, url: string, owner: Pick<TrackedPr, "chat" | "agentId" | "source">): PrRecord {
  const identity = prFromUrl(url);
  const prior = readPrRecords(dir).find(p => p.repo === identity.repo && p.prNumber === identity.prNumber);
  if (prior) { recordIntakePr(dir, prior.chat, url); return prior; }
  const row: PrRecord = { ...identity, ...owner, url, openedAt: Date.now(), state: "OPEN", signatures: [] };
  savePrRecord(dir, row);
  recordIntakePr(dir, row.chat, url);
  return row;
}

export function trackedPrs(dir: string): TrackedPr[] {
  return readPrRecords(dir).map(({ signatures: _signatures, ...row }) => row);
}
