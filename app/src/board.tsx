/**
 * The desktop's Board on the phone: the project's tasks (and its PRs, when
 * the repo is on GitHub) in four columns — Working, Needs you, In review,
 * Ready to merge. Add a task, hand one to an agent, move it along, delete it.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import { AgentIcon, agentLabel } from "./agents";
import { createBoardTask, deleteBoardTask, dispatchBoardTask, getBoard, moveBoardTask, type BoardCard, type Creds, type Project } from "./api";
import { Empty } from "./components";
import { T, radii, spacing } from "./theme";

export const BOARD_COLS: ReadonlyArray<{ key: string; label: string; color: () => string }> = [
  { key: "working", label: "Working", color: () => T.warn },
  { key: "needs-you", label: "Needs you", color: () => T.warn },
  { key: "in-review", label: "In review", color: () => T.dim },
  { key: "ready", label: "Ready to merge", color: () => T.ok },
];

export function BoardView(props: { creds: Creds; project: Project; onOpenChat?: (chat: string, title: string) => void }) {
  const { creds, project } = props;
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const b = await getBoard(creds, project.id);
      setCards(b.cards ?? []);
      setNote(b.ghError ? (b.ghError.reason === "no-remote" ? "Not on GitHub, so only your own tasks show." : b.ghError.detail ?? null) : null);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [creds, project.id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const run = (fn: () => Promise<unknown>) =>
    void fn().then(load).catch((e) => setErr(e instanceof Error ? e.message : String(e)));

  const add = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await createBoardTask(creds, project.id, draft.trim(), "needs-you");
      setDraft("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const actions = (c: BoardCard) => {
    if (!c.own) return; // a PR or issue lives on GitHub; the board only shows it
    const moves = BOARD_COLS.filter((col) => col.key !== c.column).map((col) => ({ text: `Move to ${col.label}`, onPress: () => run(() => moveBoardTask(creds, project.id, c.id, col.key)) }));
    Alert.alert(c.title.slice(0, 80), undefined, [
      ...(c.column !== "working" ? [{ text: c.agent ? `Start with ${agentLabel(c.kind ?? c.agent)}` : "Hand to an agent", onPress: () => run(() => dispatchBoardTask(creds, project.id, c.id)) }] : []),
      ...moves,
      {
        text: "Delete task",
        style: "destructive" as const,
        onPress: () =>
          Alert.alert("Delete this task?", c.title.slice(0, 120), [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => run(() => deleteBoardTask(creds, project.id, c.id)) },
          ]),
      },
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput value={draft} onChangeText={setDraft} placeholder="New task…" placeholderTextColor={T.faint} returnKeyType="done" onSubmitEditing={() => void add()}
          style={{ flex: 1, color: T.text, backgroundColor: T.raised, borderRadius: radii.key, paddingHorizontal: 12, height: 40, fontSize: 14 }} />
        <TouchableOpacity onPress={() => void add()} disabled={!draft.trim() || busy} activeOpacity={0.75} accessibilityRole="button"
          style={{ paddingHorizontal: 14, borderRadius: radii.key, backgroundColor: T.bright, justifyContent: "center", opacity: !draft.trim() ? 0.4 : 1 }}>
          {busy ? <ActivityIndicator color={T.onBright} /> : <Text style={{ color: T.onBright, fontWeight: "700" }}>Add</Text>}
        </TouchableOpacity>
      </View>
      {note ? <Text style={{ color: T.faint, fontSize: 11.5 }}>{note}</Text> : null}
      {err ? <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text> : null}
      {!cards ? (
        <ActivityIndicator color={T.dim} style={{ marginTop: 20 }} />
      ) : !cards.length ? (
        <Empty text="No tasks yet. Add one above, or start a crew goal — its cards land here." />
      ) : (
        BOARD_COLS.map((col) => {
          const here = cards.filter((c) => c.column === col.key);
          return (
            <View key={col.key} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: col.color() }} />
                <Text style={{ color: T.dim, fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4 }}>{col.label.toUpperCase()}</Text>
                <Text style={{ color: T.faint, fontSize: 11.5 }}>{here.length}</Text>
              </View>
              {here.length ? (
                here.map((c) => (
                  <TouchableOpacity key={c.id} onPress={() => actions(c)} disabled={!c.own} activeOpacity={0.7} accessibilityRole="button"
                    accessibilityHint={c.own ? "start it, move it or delete it" : undefined}
                    style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: T.panel, borderWidth: 1, borderColor: T.line, borderRadius: radii.card, padding: 11 }}>
                    {c.agent ? <AgentIcon kind={c.kind ?? c.agent} size={22} /> : <View style={{ width: 22, height: 22, borderRadius: 7, borderWidth: 1, borderColor: T.line2, borderStyle: "dashed" }} />}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: T.text, fontSize: 13.5, lineHeight: 19 }} numberOfLines={3}>{c.title}</Text>
                      <Text style={{ color: T.faint, fontSize: 11, marginTop: 2 }}>
                        {c.own ? (c.agent ? agentLabel(c.kind ?? c.agent) : "unassigned") : c.pr ? `PR #${c.pr}` : "GitHub"}
                        {c.priority ? ` · ${c.priority}` : ""}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={{ color: T.faint, fontSize: 12, paddingLeft: 14 }}>—</Text>
              )}
            </View>
          );
        })
      )}
    </View>
  );
}
