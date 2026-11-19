import type { mission, inbox } from "../../daemon/routes/workspace-r4.js";
import type { ChatFile } from "./projections.js";
import type { notes } from "./store.js";

type Request = <T>(method: string, path: string, body?: Record<string, unknown>) => Promise<T>;
export function workspaceClient(request: Request) {
  const project = (id: string) => '/api/projects/' + encodeURIComponent(id);
  return {
    mission: () => request<ReturnType<typeof mission>>('GET', '/api/mission'),
    inbox: () => request<Awaited<ReturnType<typeof inbox>>>('GET', '/api/inbox'),
    notes: (id: string) => request<ReturnType<typeof notes>>('GET', project(id) + '/notes'),
    saveNotes: (id: string, text: string, revision?: string) => request<ReturnType<typeof notes>>('PUT', project(id) + '/notes', { text, ...(revision === undefined ? {} : { revision }) }),
    files: (id: string, chat: string) => request<{ files: ChatFile[] }>('GET', project(id) + '/chats/' + encodeURIComponent(chat) + '/files'),
  };
}
