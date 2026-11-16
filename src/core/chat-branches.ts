import { MAIN_CHAT, type ChatBranch, type ChatInfo, type LoomEvent } from "../types.js";

export const ROOT_BRANCH = "0";

export function chatBranches(chat: ChatInfo): ChatBranch[] {
  return chat.branches ?? [{ id: ROOT_BRANCH, parent: null, forkEventId: 0, createdAt: chat.createdAt }];
}

/** One predicate for history, replay, extraction and paging. Cutoffs are inclusive;
 * an absent event branch is root, including events written before chats existed. */
export function chatLineage(chat: ChatInfo): (event: LoomEvent) => boolean {
  const branches = new Map(chatBranches(chat).map(branch => [branch.id, branch]));
  const limits = new Map<string, number>();
  let id: string | null = chat.activeBranch ?? ROOT_BRANCH;
  let through = Infinity;
  while (id !== null && !limits.has(id)) {
    limits.set(id, through);
    const branch = branches.get(id);
    if (!branch) break;
    through = Math.min(through, branch.forkEventId);
    id = branch.parent;
  }
  return event => (event.chat ?? MAIN_CHAT) === chat.id &&
    event.id <= (limits.get(event.branch ?? ROOT_BRANCH) ?? -1);
}

/** Replay only retained prose, excluding the prompt being dispatched and private reasoning. */
export function branchBriefing(chat: ChatInfo, events: LoomEvent[], promptEventId: number): string {
  const history = events.filter(chatLineage(chat)).filter(e => e.id < promptEventId && e.kind === "message" && !e.payload.reasoning && typeof e.payload.text === "string")
    .map(e => `${e.agentId ?? e.payload.author ?? "loom"}: ${e.payload.text}`).join("\n\n");
  return `Conversation branch ${chat.activeBranch ?? ROOT_BRANCH}. The active history below is the authoritative divergence point. Disregard any native session messages beyond it; do not repeat old requests. Files may differ from this history; check them before acting.\n\n${history || "(No earlier messages.)"}`;
}

/** Root keeps its legacy session key; branch keys cannot collide with generated chat ids. */
export function branchSessionKey(chat: string, branch = ROOT_BRANCH): string {
  return branch === ROOT_BRANCH ? chat : `${chat}:branch:${branch}`;
}

export interface BranchSource {
  promptEventId: number;
  checkpointId?: string;
  /** Cursors are captured when branching, so later parent turns cannot move the fork. */
  resumes: Record<string, { resumeCursor: string; lastTurnId?: string; resumeSessionAt?: string }>;
}

/** Ordered choices for a message's ‹ n/m › control. The parent represents the original. */
export interface BranchListing {
  branches: ChatBranch[];
  active: string;
  siblingsByEventId: Record<string, string[]>;
}

export class ChatBranchError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
