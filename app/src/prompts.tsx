/**
 * The prompt manager, clipboard-manager style: search on top, Pinned and Saved
 * below, then what you recently sent from any client. Tap inserts into the
 * composer; long-press opens the row's actions (pin, delete, or save a recent
 * one). The library lives on the daemon, so the desktop and phone share it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  deletePrompt,
  getPrompts,
  savePrompt,
  updatePrompt,
  type Creds,
  type RecentPrompt,
  type SavedPrompt,
} from "./api";
import { Empty, SectionLabel, TAP, Unreachable, ago, field } from "./components";
import { Sheet } from "./observatory";
import { T, radii } from "./theme";

type Action = { label: string; tint?: string; run: () => Promise<unknown> };

function PromptRow(props: {
  title?: string;
  text: string;
  meta?: string;
  pinned?: boolean;
  open: boolean;
  onPress: () => void;
  onLongPress: () => void;
  actions: Action[];
  busy: boolean;
}) {
  return (
    <View
      style={{
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: props.open ? T.line2 : T.line,
        backgroundColor: props.open ? T.raised : T.panel,
        overflow: "hidden",
      }}
    >
      <TouchableOpacity
        onPress={props.onPress}
        onLongPress={props.onLongPress}
        delayLongPress={350}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityHint="Inserts into the message. Long-press for actions"
        style={{ minHeight: TAP, paddingVertical: 10, paddingHorizontal: 12, gap: 3 }}
      >
        {props.title ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {props.pinned ? <Text style={{ color: T.shuttle, fontSize: 11 }}>◆</Text> : null}
            <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", flex: 1 }} numberOfLines={1}>
              {props.title}
            </Text>
          </View>
        ) : null}
        <Text
          style={{ color: props.title ? T.dim : T.text, fontSize: 12.5, lineHeight: 18 }}
          numberOfLines={props.open ? 8 : 2}
        >
          {props.text}
        </Text>
        {props.meta ? (
          <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
            {props.meta}
          </Text>
        ) : null}
      </TouchableOpacity>
      {props.open ? (
        <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: T.line }}>
          {props.actions.map((a, i) => (
            <TouchableOpacity
              key={a.label}
              onPress={() => void a.run()}
              disabled={props.busy}
              accessibilityRole="button"
              style={{
                flex: 1,
                minHeight: TAP,
                alignItems: "center",
                justifyContent: "center",
                borderLeftWidth: i ? 1 : 0,
                borderLeftColor: T.line,
              }}
            >
              <Text style={{ color: a.tint ?? T.text, fontSize: 13, fontWeight: "600" }}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function PromptsSheet(props: {
  creds: Creds;
  visible: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
  /** What's in the composer now — offered as "Save current message". */
  draft: string;
}) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ saved: SavedPrompt[]; recent: RecentPrompt[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qRef = useRef(q);
  qRef.current = q;

  const load = useCallback(async () => {
    try {
      const r = await getPrompts(props.creds, qRef.current);
      setErr(null);
      setData({ saved: r.saved ?? [], recent: r.recent ?? [] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.creds]);

  // debounce the search; reload fresh every time the sheet opens
  useEffect(() => {
    if (!props.visible) return;
    const t = setTimeout(() => void load(), q ? 220 : 0);
    return () => clearTimeout(t);
  }, [props.visible, q, load]);

  useEffect(() => {
    if (!props.visible) setOpen(null);
  }, [props.visible]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setOpen(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const insert = (text: string, saved?: SavedPrompt) => {
    if (saved) void updatePrompt(props.creds, saved.id, { used: true }).catch(() => {});
    props.onInsert(text);
    props.onClose();
  };

  const pinned = data?.saved.filter((p) => p.pinned) ?? [];
  const saved = data?.saved.filter((p) => !p.pinned) ?? [];
  const savedTexts = new Set(data?.saved.map((p) => p.text) ?? []);
  const recent = (data?.recent ?? []).filter((r) => !savedTexts.has(r.text)).slice(0, 20);
  const draft = props.draft.trim();

  const savedRow = (p: SavedPrompt) => (
    <PromptRow
      key={p.id}
      title={p.title}
      text={p.text}
      pinned={p.pinned}
      meta={p.uses ? `used ${p.uses}×` : undefined}
      open={open === p.id}
      busy={busy}
      onPress={() => insert(p.text, p)}
      onLongPress={() => setOpen((o) => (o === p.id ? null : p.id))}
      actions={[
        { label: p.pinned ? "Unpin" : "Pin", run: act(() => updatePrompt(props.creds, p.id, { pinned: !p.pinned })) },
        { label: "Delete", tint: T.err, run: act(() => deletePrompt(props.creds, p.id)) },
        { label: "Cancel", tint: T.dim, run: async () => setOpen(null) },
      ]}
    />
  );

  return (
    <Sheet title="Prompts" visible={props.visible} onClose={props.onClose}>
      <TextInput
        style={{ ...field, paddingVertical: 10, fontSize: 14 }}
        value={q}
        onChangeText={setQ}
        placeholder="Search prompts"
        placeholderTextColor={T.faint}
        selectionColor={T.accentBlue}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      {draft && !savedTexts.has(draft) ? (
        <TouchableOpacity
          onPress={act(() => savePrompt(props.creds, { text: draft }))}
          disabled={busy}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={{
            minHeight: TAP,
            borderRadius: radii.key,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: T.line2,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 12,
          }}
        >
          <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
            ＋ Save current message
          </Text>
        </TouchableOpacity>
      ) : null}

      {err && !data ? (
        <Unreachable what="prompts" detail={err} onRetry={() => void load()} />
      ) : !data ? (
        <ActivityIndicator color={T.dim} style={{ marginVertical: 20 }} />
      ) : (
        <>
          {err ? <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text> : null}
          {pinned.length ? (
            <View style={{ gap: 6 }}>
              <SectionLabel text="Pinned" />
              {pinned.map(savedRow)}
            </View>
          ) : null}
          {saved.length ? (
            <View style={{ gap: 6 }}>
              <SectionLabel text="Saved" />
              {saved.map(savedRow)}
            </View>
          ) : null}
          {recent.length ? (
            <View style={{ gap: 6 }}>
              <SectionLabel text="Recent" />
              {recent.map((r, i) => {
                const key = `r${i}:${r.at}`;
                return (
                  <PromptRow
                    key={key}
                    text={r.text}
                    meta={`${ago(new Date(r.at).toISOString())}${r.mode && r.mode !== "chat" ? ` · ${r.mode}` : ""}`}
                    open={open === key}
                    busy={busy}
                    onPress={() => insert(r.text)}
                    onLongPress={() => setOpen((o) => (o === key ? null : key))}
                    actions={[
                      { label: "Save", run: act(() => savePrompt(props.creds, { text: r.text })) },
                      { label: "Save & pin", run: act(() => savePrompt(props.creds, { text: r.text, pinned: true })) },
                      { label: "Cancel", tint: T.dim, run: async () => setOpen(null) },
                    ]}
                  />
                );
              })}
            </View>
          ) : null}
          {!pinned.length && !saved.length && !recent.length ? (
            <Empty
              text={
                q
                  ? `Nothing matches "${q}".`
                  : "No prompts yet. What you send shows up under Recent; long-press one to save or pin it."
              }
            />
          ) : (
            <Text style={{ color: T.faint, fontSize: 11.5, textAlign: "center" }}>
              Tap to insert · long-press for pin, save, delete
            </Text>
          )}
        </>
      )}
    </Sheet>
  );
}
