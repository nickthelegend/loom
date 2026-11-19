/** Send on chat open, typing changes and every 20 seconds on /ws?project=<id>.
 * A socket views one chat at a time; a new chat replaces its previous view.
 * Omitted typing preserves the current value (false on entry). Close the
 * socket when leaving the view. Unscoped sockets receive updates only.
 */
export interface PresenceMessage {
  type: "presence";
  chat: string;
  typing?: boolean;
  following?: boolean;
  view?: { scroll: number; file?: string; preview?: string };
}

export interface PresencePerson {
  /** Opaque per-socket id, unrelated to tokens, addresses or pairing ids. */
  id: string;
  /** Share-live name, "you" for the owner, or the paired device's name. */
  name: string;
  kind: "owner" | "device" | "guest";
  typing: boolean;
  following?: boolean;
  view?: { chat: string; scroll: number; file?: string; preview?: string };
  /** Unix milliseconds when this socket entered this chat; heartbeats preserve it. */
  since: number;
}

/** Full replacement, including an empty people array when everyone leaves.
 * Used for WS broadcasts, GET /api/projects/:id/chats/:chat/presence and the
 * `presence` field of GET /api/guest. Guests receive only their own chat.
 * Guest sockets enter automatically; every socket expires after 45 seconds
 * without a presence message, even if it still answers WebSocket pings.
 */
export interface PresenceSnapshot {
  type: "presence";
  projectId: string;
  chat: string;
  people: PresencePerson[];
}

export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_TTL_MS = 45_000;
export const PRESENCE_BROADCAST_MS = 250;
