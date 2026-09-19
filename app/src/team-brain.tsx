/**
 * The team brain on the phone (Loom Teams Phase 3): what the team's agents
 * have learned about this repo, by tier, and the inbox of what needs a human.
 *
 * The inbox is the reason this is on a phone at all: a contradiction, a
 * near-duplicate, a memory learned from outside content, one confirmed enough
 * to become canon. Each is a one-tap decision you can make on the go; every
 * action answers with the brain as it now stands, so there's no refetch.
 *
 * Pull to refresh syncs with the team first (sync=1). The daemon keeps the
 * team's memories sealed; the phone only ever sees what the daemon opens.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  getTeamBrain,
  teamBrainAction,
  type BrainInboxItem,
  type BrainMemory,
  type BrainTier,
  type Creds,
  type Project,
  type PromoteResult,
  type TeamBrain,
} from "./api";
import { Badge, Btn, Empty, Panel, SectionLabel, TAP, Unreachable, field } from "./components";
import {
  INBOX_LABEL,
  TIER_HINT,
  attribution,
  groupMemories,
  historyOf,
  inboxActions,
  openableUrl,
  type InboxAction,
} from "./team-brain-model";
import { T, radii, spacing } from "./theme";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

export const TIER_TINT: Record<BrainTier, string> = {
  canon: T.ok,
  confirmed: T.thread,
  own: T.primary,
  proposed: T.dim,
};

const INBOX_TINT: Record<BrainInboxItem["type"], string> = {
  correction: T.warn,
  contradiction: T.err,
  duplicate: T.dim,
  untrusted: T.warn,
  promote: T.ok,
};

function TierChip(props: { tier: BrainTier }) {
  return <Badge text={props.tier === "own" ? "yours" : props.tier} tint={TIER_TINT[props.tier]} />;
}

/** One side of an inbox pair, or a memory on its own. */
function MemoryQuote(props: { m: BrainMemory; tag?: string }) {
  const { m } = props;
  return (
    <View
      style={{
        gap: 4,
        padding: 10,
        borderRadius: radii.key,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: TIER_TINT[m.tier],
        backgroundColor: T.raised,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {props.tag ? <Text style={{ color: T.text, fontSize: 11, fontFamily: T.mono, fontWeight: "700" }}>{props.tag}</Text> : null}
        <TierChip tier={m.tier} />
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, flexShrink: 1 }} numberOfLines={1}>
          {attribution(m)}
        </Text>
      </View>
      <Text style={{ color: T.text, fontSize: 13, lineHeight: 19 }} selectable>
        {m.text}
      </Text>
    </View>
  );
}

function InboxCard(props: {
  item: BrainInboxItem;
  busy: boolean;
  onAction: (item: BrainInboxItem, a: InboxAction) => void;
}) {
  const { item } = props;
  const actions = inboxActions(item);
  const tint = INBOX_TINT[item.type];
  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: T.line,
        borderLeftWidth: 2,
        borderLeftColor: tint,
        backgroundColor: T.panel,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Badge text={INBOX_LABEL[item.type]} tint={tint} />
        <Text style={{ color: T.dim, fontSize: 12, flex: 1 }} numberOfLines={2}>
          {item.detail}
        </Text>
      </View>
      <MemoryQuote m={item.a} tag={item.b ? "A" : undefined} />
      {item.b ? <MemoryQuote m={item.b} tag="B" /> : null}
      {props.busy ? (
        <View style={{ minHeight: 34, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={T.dim} />
        </View>
      ) : actions.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {actions.map((a) => (
            <Btn key={a.label} small primary={a.primary} label={a.label} onPress={() => props.onAction(item, a)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A memory in the list; non-canon ones can be corrected in place. */
function MemoryRow(props: { m: BrainMemory; onCorrect: (m: BrainMemory, text: string) => Promise<boolean> }) {
  const { m } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const t = text.trim();
    if (!t || t === m.text) return setEditing(false);
    setBusy(true);
    const ok = await props.onCorrect(m, t);
    setBusy(false);
    if (ok) setEditing(false);
  };
  return (
    <View
      accessible={!editing}
      accessibilityLabel={`${m.text}. ${m.tier === "own" ? "yours" : m.tier}, ${attribution(m)}${m.untrusted ? ", untrusted" : ""}`}
      style={{ gap: 5, paddingVertical: 8, borderTopWidth: 1, borderTopColor: T.line }}
    >
      {editing ? (
        <View style={{ gap: 6 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            accessibilityLabel="Corrected memory"
            placeholderTextColor={T.faint}
            style={{ ...field, fontSize: 13, minHeight: 64, textAlignVertical: "top" }}
          />
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            {busy ? (
              <ActivityIndicator color={T.dim} />
            ) : (
              <>
                <Btn
                  small
                  label="Cancel"
                  onPress={() => {
                    setText(m.text);
                    setEditing(false);
                  }}
                />
                <Btn small primary label="Save correction" onPress={() => void save()} />
              </>
            )}
          </View>
          <Text style={{ color: T.faint, fontSize: 11, lineHeight: 16 }}>
            A correction is shared as a new memory that supersedes this one; teammates see it in their inbox.
          </Text>
        </View>
      ) : (
        <>
          <Text style={{ color: T.text, fontSize: 13, lineHeight: 19 }} selectable>
            {m.text}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }}>{m.kind}</Text>
            <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, flexShrink: 1 }} numberOfLines={1}>
              · {attribution(m)}
            </Text>
            {m.untrusted ? <Badge text="untrusted" tint={T.warn} /> : null}
            {m.tier !== "canon" ? (
              <TouchableOpacity
                onPress={() => setEditing(true)}
                accessibilityRole="button"
                accessibilityLabel="Correct this memory"
                hitSlop={8}
                style={{ marginLeft: "auto" }}
              >
                <Text style={{ color: T.dim, fontSize: 11.5, fontWeight: "600" }}>Correct</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

function PromotedNote(props: { r: PromoteResult; onDismiss: () => void }) {
  const url = openableUrl(props.r.prUrl);
  return (
    <Panel tint={T.ok}>
      <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>
        {props.r.added ? `Proposed ${props.r.added} memor${props.r.added === 1 ? "y" : "ies"} as canon` : "Nothing new to propose"}
      </Text>
      <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={1}>
        {props.r.branch}
      </Text>
      {props.r.note ? <Text style={{ color: T.dim, fontSize: 12, lineHeight: 17 }}>{props.r.note}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {url ? (
          <View style={{ flex: 1 }}>
            <Btn small primary label="Open the PR" onPress={() => void Linking.openURL(url).catch(() => {})} />
          </View>
        ) : null}
        <Btn small label="Dismiss" onPress={props.onDismiss} />
      </View>
    </Panel>
  );
}

/**
 * The project's Team brain tab. `onChanged` hands every fresh brain up so the
 * tab strip's inbox badge stays in step with what's on screen.
 */
export function TeamBrainView(props: { creds: Creds; project: Project; onChanged?: (b: TeamBrain) => void }) {
  const { creds, project } = props;
  const [brain, setBrain] = useState<TeamBrain | null>(null);
  const [history, setHistory] = useState<BrainMemory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<PromoteResult | null>(null);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  const take = useCallback((b: TeamBrain, withHistory: boolean) => {
    setBrain(b);
    if (withHistory) setHistory(historyOf(b.memories));
    setErr(null);
    onChanged.current?.(b);
  }, []);

  const load = useCallback(
    async (sync: boolean) => {
      try {
        take(await getTeamBrain(creds, project.id, { sync, history: true }), true);
      } catch (e) {
        setErr(statusOf(e) === 404 ? "This daemon has no team brain yet. Update Loom on your computer." : errText(e));
      }
    },
    [creds, project.id, take],
  );

  // First paint from what the daemon already has, then a sync in the background.
  useEffect(() => {
    void load(false).then(() => load(true));
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const run = async (key: string, action: InboxAction["action"], body: Record<string, unknown>) => {
    setBusy(key);
    try {
      const out = await teamBrainAction<unknown>(creds, project.id, action, body);
      take(out, false);
      if (action === "promote") setPromoted(out.result as PromoteResult);
      return true;
    } catch (e) {
      Alert.alert("Couldn't do that", errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onAction = (item: BrainInboxItem, a: InboxAction) => {
    if (!a.confirm) return void run(item.id, a.action, a.body);
    Alert.alert(`${a.label}?`, a.confirm, [
      { text: "Cancel", style: "cancel" },
      { text: a.label, onPress: () => void run(item.id, a.action, a.body) },
    ]);
  };

  const correct = (m: BrainMemory, text: string) => run(`correct:${m.id}`, "correct", { id: m.id, text });

  const s = brain?.status;
  const sections = brain ? groupMemories(brain.memories) : [];

  let body: React.ReactNode;
  if (err && !brain) {
    body = <Unreachable what="the team brain" detail={err} onRetry={() => void load(false)} />;
  } else if (!brain || !s) {
    body = <ActivityIndicator color={T.dim} style={{ marginVertical: 24 }} />;
  } else if (!s.shared) {
    body = (
      <Empty
        text={`${project.name} isn't shared with a team, so there's no team brain here. On your computer, in this repo: loom team share. Your own memories stay on this machine until you do.`}
      />
    );
  } else {
    body = (
      <View style={{ gap: spacing.md }}>
        <View style={{ gap: 4 }}>
          <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", fontFamily: T.mono }} numberOfLines={1}>
            {s.repo ?? project.name}
          </Text>
          <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }} numberOfLines={2}>
            {s.canon} canon · {s.confirmed} confirmed · {s.mine} yours · {s.team} shared · {brain.inbox.length} to review
          </Text>
          {s.lastError ? (
            <Text style={{ color: T.warn, fontSize: 11.5, lineHeight: 16 }} numberOfLines={3}>
              Last sync failed: {s.lastError}
            </Text>
          ) : null}
        </View>

        {promoted ? <PromotedNote r={promoted} onDismiss={() => setPromoted(null)} /> : null}

        <View style={{ gap: 6 }}>
          <SectionLabel text={`Inbox · ${brain.inbox.length}`} />
          {brain.inbox.length ? (
            brain.inbox.map((item) => (
              <InboxCard key={item.id} item={item} busy={busy === item.id} onAction={onAction} />
            ))
          ) : (
            <Empty text="Nothing to review. Contradictions, duplicates and memories ready for canon land here." />
          )}
        </View>

        {sections.length ? (
          sections.map((sec) => (
            <View key={sec.tier} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                <SectionLabel text={`${sec.label} · ${sec.items.length}`} />
                <Text style={{ color: T.faint, fontSize: 10.5, flexShrink: 1 }} numberOfLines={1}>
                  {TIER_HINT[sec.tier]}
                </Text>
              </View>
              <Panel>
                <View style={{ marginTop: -8 }}>
                  {sec.items.map((m) => (
                    <MemoryRow key={m.id} m={m} onCorrect={correct} />
                  ))}
                </View>
              </Panel>
            </View>
          ))
        ) : (
          <Empty text="No team memories yet. Once your team's agents learn durable facts, decisions and conventions, they show up here." />
        )}

        {history.length ? (
          <View style={{ gap: 6 }}>
            <TouchableOpacity
              onPress={() => setShowHistory((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showHistory }}
              style={{ minHeight: TAP, flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <SectionLabel text={`Resolved · ${history.length}`} />
              <Text style={{ color: T.faint, fontSize: 12 }}>{showHistory ? "▾" : "▸"}</Text>
            </TouchableOpacity>
            {showHistory
              ? history.map((m) => (
                  <View key={m.id} style={{ opacity: 0.6, gap: 3 }}>
                    <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18, textDecorationLine: "line-through" }}>
                      {m.text}
                    </Text>
                    <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
                      {m.state}
                      {m.resolvedBy ? ` by @${m.resolvedBy}` : ""}
                      {m.resolvedReason ? ` · ${m.resolvedReason}` : ""}
                    </Text>
                  </View>
                ))
              : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: 32, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={T.dim} />}
      keyboardShouldPersistTaps="handled"
    >
      {body}
      {err && brain ? <Text style={{ color: T.err, fontSize: 12, textAlign: "center" }}>{err}</Text> : null}
    </ScrollView>
  );
}

/**
 * The inbox count for the tab badge, from what the daemon already has (no
 * sync): once on open, then every 30s. `hidden` is true when this daemon
 * predates the team brain or won't show it to this pairing.
 */
export function useBrainSummary(creds: Creds, projectId: string) {
  const [summary, setSummary] = useState<{ shared: boolean; inbox: number; hidden: boolean }>({
    shared: false,
    inbox: 0,
    hidden: false,
  });
  const update = useCallback((b: TeamBrain) => {
    setSummary({ shared: Boolean(b.status?.shared), inbox: b.inbox?.length ?? 0, hidden: false });
  }, []);
  useEffect(() => {
    let live = true;
    let gone = false;
    const tick = () => {
      if (gone) return;
      getTeamBrain(creds, projectId)
        .then((b) => {
          if (live) update(b);
        })
        .catch((e) => {
          const st = statusOf(e);
          if (st === 404 || st === 403) {
            gone = true;
            if (live) setSummary({ shared: false, inbox: 0, hidden: true });
          }
        });
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [creds, projectId, update]);
  return { summary, update };
}
