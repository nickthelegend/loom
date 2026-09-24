/**
 * Which chats have replies this phone hasn't seen. A chat never opened here
 * takes its newest reply as the baseline, so a fresh install doesn't light up
 * every thread you ever had. Pure; the screen keeps the map in the keychain.
 */

export type SeenMap = Record<string, number>;
export type ChatLike = { id: string; lastReplyId?: number };

/** The chats with unseen replies, and the map with any new baselines added. */
export function unreadChats(chats: ChatLike[], seen: SeenMap, current: string): { unread: Set<string>; seen: SeenMap } {
  const next: SeenMap = { ...seen };
  const unread = new Set<string>();
  for (const c of chats) {
    if (!c.lastReplyId) continue;
    if (next[c.id] === undefined) next[c.id] = c.lastReplyId;
    else if (c.id !== current && c.lastReplyId > next[c.id]!) unread.add(c.id);
  }
  return { unread, seen: next };
}

/** Mark a chat read up to an event id (never backwards). */
export function markRead(seen: SeenMap, chat: string, id: number): SeenMap {
  return (seen[chat] ?? 0) >= id ? seen : { ...seen, [chat]: id };
}
