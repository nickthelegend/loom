import { swipeOpensActions, readChange } from "./model";
import { useEffect, useState } from "react";
import { Modal, PanResponder, ScrollView, TouchableOpacity, View } from "react-native";
import { api, getChats, kv, setChatFlags, type Chat, type Creds } from "../api";
import { haptic } from "../haptics";
import { T } from "../theme";
import { Button } from "./settings";
import { Text } from "./preferences";
type Level = "all" | "needs-you" | "none";
function SwipeRow({ chat, open, menu }: { chat: Chat; open: () => void; menu: () => void }) {
  const pan = PanResponder.create({ onMoveShouldSetPanResponder: (_, g) => swipeOpensActions(g.dx, g.dy, 24), onPanResponderRelease: (_, g) => { if (swipeOpensActions(g.dx, g.dy)) { haptic.tap(); menu(); } } });
  return <View {...pan.panHandlers}><TouchableOpacity onPress={open} onLongPress={menu} accessibilityRole="button" accessibilityHint="Swipe or long press for pin, read and notification actions" style={{ padding: 16, borderBottomWidth: 1, borderColor: T.line }}><Text style={{ color: T.text }}>{chat.pinned ? "📌 " : ""}{chat.title || chat.id}</Text></TouchableOpacity></View>;
}
export function PhoneChats({ creds, project, onOpen, onSeen }: { onSeen?: (seen: Record<string, number>) => void; creds: Creds; project: string; onOpen: (chat: Chat) => void }) {
  const [chats, setChats] = useState<Chat[]>([]), [selected, setSelected] = useState<Chat | null>(null), [level, setLevel] = useState<Level>("all"), [error, setError] = useState("");
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void> } | null>(null), [seen, setSeen] = useState<Record<string, number>>({});
  const key = `loomSeen:${project}`;
  const load = async () => { setChats((await getChats(creds, project)).chats.filter(c => !c.archived)); const value = JSON.parse(await kv.get(key) ?? "{}"); setSeen(value); onSeen?.(value); };
  useEffect(() => { void load().catch(e => setError(String(e))); }, [creds, project]);
  useEffect(() => { if (!undo) return; const timer = setTimeout(() => setUndo(null), 8000); return () => clearTimeout(timer); }, [undo]);
  const path = (chat: string) => `/api/projects/${project}/chats/${encodeURIComponent(chat)}/notification-level`;
  const menu = async (chat: Chat) => { try { const r = await api<{ level: Level }>(creds, path(chat.id)); setLevel(r.level); setSelected(chat); } catch (e) { setError(String(e)); } };
  const change = async (label: string, apply: () => Promise<unknown>, revert: () => Promise<unknown>) => {
    try { await apply(); haptic.success(); setSelected(null); await load(); setUndo({ label, run: async () => { await revert(); await load(); } }); } catch (e) { setError(String(e)); }
  };
  const notify = (chat: string, l: Level) => api(creds, path(chat), { method: "PUT", body: JSON.stringify({ level: l }) });
  return <View style={{ flex: 1 }}><Text style={{ color: T.err }}>{error}</Text><ScrollView>
    {[...chats].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).map(chat => <View key={chat.id}><SwipeRow chat={chat} open={() => onOpen(chat)} menu={() => void menu(chat)} />{(seen[chat.id] ?? chat.lastReplyId ?? 0) < (chat.lastReplyId ?? 0) && <Text style={{ color: T.thread, paddingLeft: 16 }}>Unread</Text>}</View>)}
  </ScrollView>
  {undo && <View accessibilityLiveRegion="polite" style={{ backgroundColor: T.raised, padding: 8 }}><Text style={{ color: T.text }}>{undo.label}</Text><Button title="Undo" onPress={() => { const item = undo; setUndo(null); void item.run().catch(e => setError(String(e))); }} /></View>}
  <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}><View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "#0006" }}><ScrollView style={{ maxHeight: "80%", backgroundColor: T.panel }} contentContainerStyle={{ padding: 20 }}>
    {selected && <><Text style={{ color: T.text }}>{selected.title}</Text>
      <Button title={selected.pinned ? "Unpin" : "Pin"} onPress={() => { const c = selected; void change("Pin updated", () => setChatFlags(creds, project, c.id, { pinned: !c.pinned }), () => setChatFlags(creds, project, c.id, { pinned: !!c.pinned })); }} />
      {[true, false].map(read => <Button key={String(read)} title={read ? "Mark read" : "Mark unread"} onPress={() => { const c = selected, before = { ...seen }; void change(read ? "Marked read" : "Marked unread", () => kv.set(key, JSON.stringify(readChange(seen, c, read))), () => kv.set(key, JSON.stringify(before))); }} />)}
      <Text style={{ color: T.dim }}>Notifications for this chat on this device</Text>
      {(["all", "needs-you", "none"] as const).map(l => <Button key={l} title={`${l === "all" ? "All" : l === "needs-you" ? "Only when it needs you" : "Mute (approvals still notify)"}${level === l ? " ✓" : ""}`} onPress={() => { const c = selected, previous = level; void change("Notifications updated", () => notify(c.id, l), () => notify(c.id, previous)); }} />)}
    </>}<Button title="Cancel" onPress={() => setSelected(null)} />
  </ScrollView></View></Modal></View>;
}
