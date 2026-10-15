import type { PermissionMode } from "./permissions.js";
import { CREW_ROLES, type CrewRole } from "./crew-protocol.js";

export interface CrewPolicy {
  maxPerMember: number;
  maxTeammates: number;
  reviewerMustDifferFromBuilders: boolean;
  planApproval: "required" | "optional";
  budgets: { perCrewDailyUsd: number | null };
  roles: Partial<Record<CrewRole, { permissions: PermissionMode }>>;
}
export const DEFAULT_CREW_POLICY: CrewPolicy = {
  maxPerMember: 1, maxTeammates: 6, reviewerMustDifferFromBuilders: true, planApproval: "required",
  budgets: { perCrewDailyUsd: null },
  roles: { lead: { permissions: "ask" }, builder: { permissions: "auto" }, reviewer: { permissions: "ask" }, tester: { permissions: "ask" }, researcher: { permissions: "ask" } },
};
const rank: Record<PermissionMode, number> = { ask: 0, auto: 1, bypass: 2 };
const smaller = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.min(a, b);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function parseCrewPolicy(value: unknown): CrewPolicy {
  const raw = record(value), budgets = record(raw.budgets), roles = record(raw.roles);
  const int = (n: unknown, fallback: number, cap: number) => Number.isInteger(n) && Number(n) > 0 ? Math.min(Number(n), cap) : fallback;
  const parsed: CrewPolicy = { maxPerMember: int(raw.maxPerMember, 1, 20), maxTeammates: int(raw.maxTeammates, 6, 8),
    reviewerMustDifferFromBuilders: raw.reviewerMustDifferFromBuilders !== false,
    planApproval: raw.planApproval === "optional" ? "optional" : "required",
    budgets: { perCrewDailyUsd: typeof budgets.perCrewDailyUsd === "number" && Number.isFinite(budgets.perCrewDailyUsd) && budgets.perCrewDailyUsd > 0 ? budgets.perCrewDailyUsd : null },
    roles: structuredClone(DEFAULT_CREW_POLICY.roles) };
  for (const role of CREW_ROLES) {
    const permissions = record(roles[role]).permissions;
    if (permissions === "ask" || permissions === "auto" || permissions === "bypass") parsed.roles[role] = { permissions };
  }
  return parsed;
}
export function stricterCrewPolicy(a: CrewPolicy, b: CrewPolicy): CrewPolicy {
  const roles: CrewPolicy["roles"] = {};
  for (const role of CREW_ROLES) {
    const left = a.roles[role]?.permissions ?? "bypass", right = b.roles[role]?.permissions ?? "bypass";
    roles[role] = { permissions: rank[left] < rank[right] ? left : right };
  }
  return { maxPerMember: Math.min(a.maxPerMember, b.maxPerMember), maxTeammates: Math.min(a.maxTeammates, b.maxTeammates),
    reviewerMustDifferFromBuilders: a.reviewerMustDifferFromBuilders || b.reviewerMustDifferFromBuilders,
    planApproval: a.planApproval === "required" || b.planApproval === "required" ? "required" : "optional",
    budgets: { perCrewDailyUsd: smaller(a.budgets.perCrewDailyUsd, b.budgets.perCrewDailyUsd) }, roles };
}
export function capCrewPermission(policy: CrewPolicy, role: string | undefined, wanted: PermissionMode): PermissionMode {
  const cap = role ? policy.roles[role as CrewRole]?.permissions : undefined;
  return cap && rank[cap] < rank[wanted] ? cap : wanted;
}
