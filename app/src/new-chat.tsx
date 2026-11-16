/**
 * New chat, on the phone: a title (optional), who answers, and which model — so a chat on
 * Opus 5.5 and another on GPT‑5.6 can sit side by side in one project. The daemon already takes
 * both on POST /api/projects/:id/chats; this is the sheet that asks.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { createChat, getAgentModels, type AgentStatus, type Chat, type Creds, type Project } from "./api";
import { TAP } from "./components";
import { Sheet } from "./observatory";
import { T, radii, spacing } from "./theme";

/** Agents a chat can be bound to: ones that take turns and are switched on. */
const answerers = (agents: AgentStatus[]) => agents.filter((a) => a.tier === "adapter" && a.enabled !== false);

export function NewChatSheet(props: {
  visible: boolean;
  creds: Creds;
  project: Project;
  onClose: () => void;
  onCreated: (chat: Chat) => void;
}) {
  const agents = answerers(props.project.agents);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [model, setModel] = useState(""); // "" = the agent's own default
  const [custom, setCustom] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // a fresh sheet each time it opens, starting on whoever holds the baton
  useEffect(() => {
    if (!props.visible) return;
    setTitle(""); setModel(""); setCustom(""); setErr(null); setBusy(false);
    setAgentId(agents.find((a) => a.holdsBaton)?.id ?? agents[0]?.id ?? null);
  }, [props.visible]);

  // what the chosen agent can run — its CLI's own list
  useEffect(() => {
    if (!props.visible || !agentId) return;
    let gone = false;
    setModels(null);
    void getAgentModels(props.creds, props.project.id, agentId)
      .then((r) => { if (!gone) setModels(r.models.slice(0, 12)); })
      .catch(() => { if (!gone) setModels([]); });
    return () => { gone = true; };
  }, [props.visible, agentId]);

  const chosen = custom.trim() || model;
  const create = async () => {
    if (!agentId) return;
    setBusy(true);
    setErr(null);
    try {
      const { chat } = await createChat(props.creds, props.project.id, title.trim(), { agentId, ...(chosen ? { model: chosen } : {}) });
      props.onCreated(chat);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const chip = (label: string, on: boolean, onPress: () => void, key: string) => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={{ minHeight: 36, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: on ? T.line2 : T.line,
        backgroundColor: on ? T.raised : "transparent", justifyContent: "center" }}
    >
      <Text style={{ color: on ? T.text : T.dim, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <Sheet title="New chat" visible={props.visible} onClose={props.onClose}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="What's it about? (optional)"
          placeholderTextColor={T.faint}
          returnKeyType="done"
          accessibilityLabel="Chat title"
          style={{ color: T.text, backgroundColor: T.raised, borderRadius: radii.input, paddingHorizontal: 12, height: 44, fontSize: 15 }}
        />

        <View style={{ gap: 6 }}>
          <Text style={{ color: T.dim, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>WHO ANSWERS</Text>
          {agents.length ? agents.map((a) => {
            const on = a.id === agentId;
            return (
              <TouchableOpacity
                key={a.id}
                onPress={() => { setAgentId(a.id); setModel(""); setCustom(""); }}
                activeOpacity={0.7}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: TAP, paddingHorizontal: 12, borderRadius: radii.key,
                  borderWidth: 1, borderColor: on ? T.line2 : T.line, backgroundColor: on ? T.raised : "transparent" }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: a.busy ? T.warn : a.available ? T.ok : T.faint }} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: T.text, fontSize: 14.5, fontWeight: on ? "700" : "600" }} numberOfLines={1}>{a.id}</Text>
                  <Text style={{ color: T.dim, fontSize: 12 }} numberOfLines={1}>{a.kind}{a.model ? ` · ${a.model}` : ""}{a.busy ? " · working" : ""}</Text>
                </View>
              </TouchableOpacity>
            );
          }) : (
            <Text style={{ color: T.dim, fontSize: 13 }}>This project has no agents that take turns yet — add one on your computer.</Text>
          )}
        </View>

        {agentId && (
          <View style={{ gap: 8 }}>
            <Text style={{ color: T.dim, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>MODEL</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {chip("Agent's default", !chosen, () => { setModel(""); setCustom(""); }, "default")}
              {models === null ? <ActivityIndicator color={T.dim} /> : models.map((m) => chip(m, chosen === m, () => { setModel(m); setCustom(""); }, m))}
            </View>
            <TextInput
              value={custom}
              onChangeText={setCustom}
              placeholder="or type a model id, e.g. claude-opus-5-5"
              placeholderTextColor={T.faint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Model id"
              style={{ color: T.text, backgroundColor: T.raised, borderRadius: radii.input, paddingHorizontal: 12, height: 40, fontSize: 14 }}
            />
          </View>
        )}

        {err && <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text>}

        <TouchableOpacity
          onPress={() => void create()}
          disabled={!agentId || busy}
          activeOpacity={0.8}
          accessibilityRole="button"
          style={{ minHeight: TAP, borderRadius: radii.key, backgroundColor: T.bright, alignItems: "center", justifyContent: "center", opacity: !agentId || busy ? 0.5 : 1 }}
        >
          {busy ? <ActivityIndicator color={T.onBright} /> : (
            <Text style={{ color: T.onBright, fontSize: 15, fontWeight: "700" }}>
              Start chat{agentId ? ` with ${agentId}` : ""}{chosen ? ` · ${chosen}` : ""}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </Sheet>
  );
}
