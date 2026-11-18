import fs from "node:fs";
import path from "node:path";
import { projectLoomDir } from "./registry.js";

export const SHARE_PRESETS = { "1h": 1, "1d": 24, "7d": 168 } as const;
export function shareHours(input: { preset?: unknown; hours?: unknown }): number {
  if (input.preset !== undefined) {
    if (typeof input.preset !== "string" || !Object.hasOwn(SHARE_PRESETS, input.preset)) throw new Error("expiry must be 1h, 1d or 7d");
    return SHARE_PRESETS[input.preset as keyof typeof SHARE_PRESETS];
  }
  const hours = input.hours === undefined ? 24 : Number(input.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new Error("hours must be from 1 to 720");
  return hours;
}

/** Match whole GitHub logins; email addresses and repeated mentions don't notify. */
export function mentionLogins(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[\s(])@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)(?=$|[^a-z\d_-])/gi)].map(m => m[1]!.toLowerCase()))];
}

export interface ApprovalRoles { mode: "everyone" | "selected"; approvers: string[] }
const rolesFile = (dir: string) => path.join(projectLoomDir(dir), "approval-roles.json");
export function readApprovalRoles(dir: string): ApprovalRoles {
  try { return JSON.parse(fs.readFileSync(rolesFile(dir), "utf8")) as ApprovalRoles; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { mode: "everyone", approvers: [] }; throw e; }
}
export function writeApprovalRoles(dir: string, value: unknown): ApprovalRoles {
  const v = value as ApprovalRoles;
  if (!v || !["everyone", "selected"].includes(v.mode) || !Array.isArray(v.approvers) || v.approvers.length > 200 ||
      v.approvers.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new Error("expected mode everyone/selected and approver device ids");
  const roles = { mode: v.mode, approvers: [...new Set(v.approvers)] };
  fs.mkdirSync(projectLoomDir(dir), { recursive: true });
  fs.writeFileSync(rolesFile(dir) + ".tmp", JSON.stringify(roles) + "\n", { mode: 0o600 });
  fs.renameSync(rolesFile(dir) + ".tmp", rolesFile(dir));
  return roles;
}
export function mayApprove(roles: ApprovalRoles, owner: boolean, clientId?: string): boolean {
  return owner || roles.mode === "everyone" || Boolean(clientId && roles.approvers.includes(clientId));
}

/** Quote every cell, including newlines; neutralize spreadsheet formula prefixes. */
export function auditCsv(entries: Array<{ at: number; project: string; projectName: string; chat?: string; what: string; who: string; detail?: string }>): string {
  const cell = (v: unknown) => '"' + String(v ?? "").replace(/^[\s]*[=+@-]/, m => "'" + m).replaceAll('"', '""') + '"';
  return "\uFEFF" + [["at", "project", "projectName", "chat", "what", "who", "detail"],
    ...entries.map(e => [new Date(e.at).toISOString(), e.project, e.projectName, e.chat, e.what, e.who, e.detail])]
    .map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
