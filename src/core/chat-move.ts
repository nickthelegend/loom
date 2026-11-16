import { z } from "zod";
import type { ChatInfo, LoomEvent } from "../types.js";

/** Plaintext budget before sealing; leaves room for encryption/base64 in the hub's HTTP limit. */
export const CHAT_MOVE_MAX_BYTES = 2 * 1024 * 1024;

/** Sealed chat_move job body. Agent kind is portable; agentId is only a source roster id.
 * Native cursors are hints, never credentials or session files. Only send them to the same owner.
 */
export interface ChatMovePayload {
  chat: ChatInfo & { instructions?: string };
  kind: string;
  events: LoomEvent[];
  resume: { kind: string; nativeSessionId?: string; resumeCursor?: unknown } | null;
  dropped: number;
}

export class ChatMoveError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** Keep complete message text when possible. Discard raw tool blobs first, then oldest events. */
export function packChatMove(input: Omit<ChatMovePayload, "dropped">): ChatMovePayload {
  const out: ChatMovePayload = { ...input, events: input.events.filter(e => e.kind === "message" || e.kind === "tool_call"), dropped: 0 };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (bytes(out) <= CHAT_MOVE_MAX_BYTES) return out;
  out.events = out.events.map(e => {
    if (e.kind !== "tool_call") return e;
    const { tool, summary, ok, author, by } = e.payload;
    return { ...e, payload: { tool, summary, ok, author, by, outputOmitted: true } };
  });
  let size = bytes(out);
  while (size > CHAT_MOVE_MAX_BYTES - 64 && out.dropped < out.events.length) {
    size -= bytes(out.events[out.dropped]) + 1;
    out.dropped++;
  }
  out.events = out.events.slice(out.dropped);
  if (bytes(out) > CHAT_MOVE_MAX_BYTES) throw new ChatMoveError("chat metadata exceeds the move size limit", 413);
  return out;
}

/** Validate decrypted team input before it can enter a local log or project state. */
export function parseChatMove(value: unknown): ChatMovePayload {
  if (Buffer.byteLength(JSON.stringify(value)) > CHAT_MOVE_MAX_BYTES) throw new ChatMoveError("chat move exceeds the size limit", 413);
  return z.object({
    chat: z.object({ id: z.string().min(1), title: z.string(), createdAt: z.number().finite(),
      agentId: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), instructions: z.string().optional() }),
    kind: z.string().min(1),
    events: z.array(z.object({ id: z.number().int(), ts: z.number().finite(), kind: z.enum(["message", "tool_call"]),
      chat: z.string().optional(), agentId: z.string().optional(), payload: z.record(z.string(), z.unknown()) })),
    resume: z.object({ kind: z.string(), nativeSessionId: z.string().optional(), resumeCursor: z.unknown().optional() }).nullable(),
    dropped: z.number().int().nonnegative(),
  }).parse(value);
}
