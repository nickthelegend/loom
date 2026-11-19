export type GitDraftKind = "pr" | "changelog" | "message";

/** Keep the active chat on drafts even when the user switches project tabs. */
export function gitDraftRequest(kind: GitDraftKind, chat: string, template: string, branch: string) {
  if (kind === "pr") return { route: "/git/pr-description", body: { chat, template }, field: "description" as const };
  if (kind === "message") return { route: "/git/suggest-message", body: { chat }, field: "message" as const };
  if (!branch.trim()) throw new Error("Choose a merged branch first");
  return { route: "/git/changelog", body: { branch: branch.trim() }, field: "entry" as const };
}

export function diffSummary(diff?: { added: number; removed: number; files: number }): string {
  return diff ? `+${diff.added} / −${diff.removed} · ${diff.files} files` : "No diff statistics yet";
}
