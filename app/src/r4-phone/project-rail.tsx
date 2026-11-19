import { createContext, useContext, useEffect, useRef } from "react";
export interface RailState {
  tabs: ReadonlyArray<{ key: string; label: string }>;
  tab: string;
  chat: string;
  selectTab: (tab: string) => void;
  selectChat: (chat: string) => void;
  seen: Record<string, number>;
  saveSeen: (seen: Record<string, number>) => void;
}
export const ProjectRailContext = createContext<((state: RailState) => void) | null>(null);
/** The shell drives the existing screen's state, so switching panes preserves drafts. */
export function useProjectRail<T extends string>(state: Omit<RailState, "selectTab" | "tab" | "tabs"> & { tab: T; tabs: ReadonlyArray<{ key: T; label: string }>; selectTab: (tab: T) => void }) {
  const register = useContext(ProjectRailContext), latest = useRef(state); latest.current = state;
  const signature = state.tabs.map(t => t.key).join(",");
  useEffect(() => {
    register?.({ ...state, selectTab: tab => latest.current.selectTab(tab as T), selectChat: chat => latest.current.selectChat(chat), saveSeen: seen => latest.current.saveSeen(seen) });
  }, [register, state.tab, state.chat, state.seen, signature]);
}
