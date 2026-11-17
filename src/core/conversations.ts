/** Conversation metadata only. Native sessions and event history have separate owners.
 * Keep state.json compatibility until the continuity schema migration is designed.
 */
import { newId, readProjectState, writeProjectState } from "./registry.js";
import { MAIN_CHAT, type ChatInfo } from "../types.js";

export class ConversationStore {
  constructor(private readonly projectDir: string) {}

  chats(): ChatInfo[] {
    const stored = readProjectState(this.projectDir).chats ?? [];
    return [
      { id: MAIN_CHAT, title: "Main", createdAt: 0, ...stored.find(c => c.id === MAIN_CHAT) },
      ...stored.filter((c) => c.id !== MAIN_CHAT),
    ];
  }

  createChat(title: string, opts: { agentId?: string; model?: string; effort?: string } = {}): ChatInfo {
    const bound = opts.agentId ? opts : null;
    const state = readProjectState(this.projectDir);
    const chat: ChatInfo = {
      id: newId(4),
      // numbered, not "New chat" — the button already says New chat, and a
      // sidebar of identical rows tells you nothing
      title: title.trim().slice(0, 60) || `Chat ${(state.chats ?? []).length + 2}`,
      titleSource: title.trim() ? "user" : "default",
      createdAt: Date.now(),
      ...(bound ? { agentId: bound.agentId } : {}),
      ...(bound?.model ? { model: bound.model } : {}),
      ...(bound?.effort ? { effort: bound.effort } : {}),
    };
    state.chats = [...(state.chats ?? []), chat];
    writeProjectState(this.projectDir, state);
    return chat;
  }

  setChatAgent(id: string, agentId: string | null, model?: string, effort?: string): ChatInfo | null {
    if (id === MAIN_CHAT) {
      // Main is where the baton answers; that's what makes it Main.
      throw new Error("the main thread follows the baton — make a new thread to pin an agent");
    }
    const bound = agentId ? { agentId, model, effort } : null;
    const state = readProjectState(this.projectDir);
    const chat = (state.chats ?? []).find((c) => c.id === id);
    if (!chat) return null;
    if (bound) {
      chat.agentId = bound.agentId;
      if (bound.model) chat.model = bound.model;
      else delete chat.model;
      if (bound.effort) chat.effort = bound.effort;
      else delete chat.effort;
    } else {
      delete chat.agentId;
      delete chat.model;
      delete chat.effort;
    }
    writeProjectState(this.projectDir, state);
    return chat;
  }

  hasDefaultTitle(id: string): boolean {
    const chat = this.chats().find(c => c.id === id);
    return !!chat && id !== MAIN_CHAT && (chat.titleSource === "default" ||
      chat.titleSource === undefined && /^Chat \d+$/.test(chat.title));
  }

  renameChat(id: string, title: string, automatic = false): ChatInfo | null {
    if (automatic && !this.hasDefaultTitle(id)) return null;
    if (id === MAIN_CHAT) return null; // main's name is not yours to change
    const state = readProjectState(this.projectDir);
    const chat = (state.chats ?? []).find((c) => c.id === id);
    if (!chat) return null;
    chat.title = title.trim().slice(0, 60) || chat.title;
    chat.titleSource = automatic ? "auto" : "user";
    writeProjectState(this.projectDir, state);
    return chat;
  }

  /**
   * Forget a conversation. Its events stay in the log — it's append-only, and
   * the brain is built from all of them; deleting the thread you had with an
   * agent shouldn't quietly rewrite what the project decided. The chat just
   * stops being listed.
   */
  deleteChat(id: string): boolean {
    if (id === MAIN_CHAT) return false; // there is always a main chat
    const state = readProjectState(this.projectDir);
    const before = (state.chats ?? []).length;
    state.chats = (state.chats ?? []).filter((c) => c.id !== id);
    if (state.chats.length === before) return false;
    if (state.branchSources) delete state.branchSources[id];
    writeProjectState(this.projectDir, state);
    return true;
  }

}
