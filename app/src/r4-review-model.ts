export interface ReviewFile { path: string; version: string; patch: string; viewed: boolean }
export interface ReviewView { files: ReviewFile[]; viewed: number; total: number }
export interface InboxItem extends ReviewView { project: string; projectName: string; chat: string; run?: string; title: string }
export function viewedRequest(file: ReviewFile, chat: string, run?: string) {
  return { chat, ...(run ? { run } : {}), path: file.path, version: file.version, viewed: !file.viewed };
}
export function reviewProgress(view: Pick<ReviewView, "viewed" | "total">) { return `${view.viewed} of ${view.total} viewed`; }
export function hunkRequest(path: string, version: string, id: string, action: "stage" | "discard") {
  return { path, version, id, action };
}

/** Background refreshes are deliberately infrequent; both screens also expose Refresh. */
export const REVIEW_REFRESH_MS = 60_000;
