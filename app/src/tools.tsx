/**
 * Tools — the three project surfaces the phone was missing entirely:
 *
 *   skills  the SKILL.md context blocks discoverable from this project, from
 *           all four roots (project, ~/.claude, plugin caches, bundled). A real
 *           machine has ~74 of them, which is why this is a virtualised list
 *           with a filter and not a column of cards.
 *   mcp     the MCP servers this project is wired to, plus the public registry
 *           to install from. `connected` is measured by the daemon's own probe
 *           and is reported as it comes — a configured url is not evidence that
 *           anything is listening on it.
 *   agents  which agents are on, and what role each one plays.
 *
 * Every write here is a real mutation of the project's config on the daemon's
 * machine, so every one of them either succeeds visibly or shows the daemon's
 * own refusal text. The daemon says useful things ("that repo has no SKILL.md",
 * "the baton holder can't be disabled") and swallowing those for a generic
 * "failed" would be the worst thing this screen could do.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  getMcpCatalog,
  getMcps,
  getSkillsCatalog,
  installMcp,
  installSkill,
  removeMcp,
  setAgentEnabled,
  setAgentRole,
  setSkillEnabled,
  type Creds,
  type McpCatalogEntry,
  type McpServer,
  type Project,
  type SkillEntry,
  type SkillOrigin,
} from "./api";
import {
  Badge,
  Empty,
  Panel,
  SectionLabel,
  Segmented,
  TAP,
  Unreachable,
  field,
  trunc,
} from "./components";
import { Sheet } from "./observatory";
import { T, radii, spacing } from "./theme";

type ToolsTab = "skills" | "mcp" | "agents";

const TOOLS_TABS: ReadonlyArray<{ key: ToolsTab; label: string }> = [
  { key: "skills", label: "Skills" },
  { key: "mcp", label: "MCP servers" },
  { key: "agents", label: "Agents" },
];

export function ToolsView(props: { creds: Creds; project: Project; onAgentsChanged: () => void }) {
  const [tab, setTab] = useState<ToolsTab>("skills");
  return (
    <View style={{ flex: 1 }}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.panel }}>
        <Segmented options={TOOLS_TABS} value={tab} onChange={setTab} accent={T.line2} />
      </View>
      {tab === "skills" ? (
        <SkillsPanel creds={props.creds} projectId={props.project.id} />
      ) : tab === "mcp" ? (
        <McpPanel creds={props.creds} projectId={props.project.id} />
      ) : (
        <AgentsPanel creds={props.creds} project={props.project} onChanged={props.onAgentsChanged} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const ORIGIN_ORDER: SkillOrigin[] = ["project", "user", "plugin", "bundled"];
const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  project: "In this project",
  user: "Your machine (~/.claude)",
  plugin: "From plugins",
  bundled: "Bundled with Loom",
};

type SkillRow = { kind: "header"; id: string; label: string; n: number } | { kind: "skill"; id: string; skill: SkillEntry };

function SkillsPanel(props: { creds: Creds; projectId: string }) {
  const { creds, projectId } = props;
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [installOpen, setInstallOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void getSkillsCatalog(creds, projectId)
      .then(({ skills: s }) => setSkills(s))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [creds, projectId]);

  useEffect(load, [load]);

  const toggle = (s: SkillEntry) => {
    const next = !s.enabled;
    // Optimistic: a switch that waits a round-trip to move feels broken. The
    // daemon's answer is authoritative, so a failure snaps it back and says why.
    setSkills((prev) => prev?.map((x) => (x.id === s.id ? { ...x, enabled: next } : x)) ?? prev);
    setPending((p) => ({ ...p, [s.id]: true }));
    void setSkillEnabled(creds, projectId, s.id, next)
      .catch((e: unknown) => {
        setSkills((prev) => prev?.map((x) => (x.id === s.id ? { ...x, enabled: s.enabled } : x)) ?? prev);
        Alert.alert("Couldn't change that skill", e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPending((p) => ({ ...p, [s.id]: false })));
  };

  const rows: SkillRow[] = useMemo(() => {
    if (!skills) return [];
    const q = filter.trim().toLowerCase();
    const matched = q
      ? skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      : skills;
    const out: SkillRow[] = [];
    for (const origin of ORIGIN_ORDER) {
      const group = matched.filter((s) => s.origin === origin);
      if (!group.length) continue;
      out.push({ kind: "header", id: `h:${origin}`, label: ORIGIN_LABEL[origin], n: group.length });
      for (const s of group) out.push({ kind: "skill", id: s.id, skill: s });
    }
    // Anything with an origin the app doesn't know about still has to appear —
    // a skill silently missing from the list is worse than an odd heading.
    const known = new Set<string>(ORIGIN_ORDER);
    const rest = matched.filter((s) => !known.has(s.origin));
    if (rest.length) {
      out.push({ kind: "header", id: "h:other", label: "Elsewhere", n: rest.length });
      for (const s of rest) out.push({ kind: "skill", id: s.id, skill: s });
    }
    return out;
  }, [skills, filter]);

  if (!skills) {
    return (
      <View style={{ padding: spacing.md }}>
        {error ? (
          <Unreachable what="the skill catalog" detail={error} onRetry={load} />
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 40, gap: 10 }}>
            <ActivityIndicator color={T.primary} />
            <Text style={{ color: T.dim, fontSize: 12 }}>loading skills…</Text>
          </View>
        )}
      </View>
    );
  }

  const on = skills.filter((s) => s.enabled).length;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: spacing.md, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: T.line }}>
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
          <TextInput
            style={{ ...field, flex: 1, paddingVertical: 10, fontSize: 14 }}
            value={filter}
            onChangeText={setFilter}
            placeholder={`Filter ${skills.length} skills…`}
            placeholderTextColor={T.faint}
            selectionColor={T.accentBlue}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            onPress={() => setInstallOpen(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Install a skill"
            style={{
              minHeight: TAP,
              paddingHorizontal: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: T.raised,
              borderWidth: 1,
              borderColor: T.line,
              borderRadius: radii.key,
            }}
          >
            <Text style={{ color: T.text, fontSize: 13, fontWeight: "600" }}>+ Install</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>
          {on} enabled of {skills.length}
          {filter.trim() ? ` · ${rows.filter((r) => r.kind === "skill").length} match` : ""}
        </Text>
      </View>

      {!rows.length ? (
        <View style={{ padding: spacing.md }}>
          <Empty text={`Nothing matches “${filter.trim()}”.`} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing.md, paddingBottom: 40, gap: 6 }}
          initialNumToRender={14}
          windowSize={9}
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <View style={{ paddingTop: 12, paddingBottom: 2 }}>
                <SectionLabel text={`${item.label} · ${item.n}`} />
              </View>
            ) : (
              <SkillRowView skill={item.skill} busy={!!pending[item.skill.id]} onToggle={() => toggle(item.skill)} />
            )
          }
        />
      )}

      <InstallSkillSheet
        visible={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstall={async (from) => {
          const { skills: next } = await installSkill(creds, projectId, from);
          setSkills(next);
        }}
      />
    </View>
  );
}

function SkillRowView(props: { skill: SkillEntry; busy: boolean; onToggle: () => void }) {
  const s = props.skill;
  return (
    <TouchableOpacity
      onPress={props.onToggle}
      disabled={props.busy}
      activeOpacity={0.7}
      accessibilityRole="switch"
      accessibilityState={{ checked: s.enabled, disabled: props.busy }}
      accessibilityLabel={`${s.name}: ${s.enabled ? "enabled" : "disabled"}`}
      style={{
        minHeight: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        backgroundColor: T.panel,
        borderWidth: 1,
        borderColor: s.enabled ? T.primaryDim : T.line,
        borderRadius: radii.card,
        paddingVertical: 10,
        paddingHorizontal: 12,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
            {s.name}
          </Text>
          {s.installed ? <Badge text="installed here" tint={T.thread} /> : null}
        </View>
        <Text style={{ color: T.dim, fontSize: 11.5, lineHeight: 17 }} numberOfLines={2}>
          {s.description || "No description."}
        </Text>
        <Text style={{ color: T.faint, fontSize: 9.5, fontFamily: T.mono }} numberOfLines={1}>
          {trunc(s.source, 46)}
        </Text>
      </View>
      {/* The row is the target; the switch is the readout. Tapping either works
          because the switch inherits the row's press through its own handler. */}
      <Switch
        value={s.enabled}
        onValueChange={props.onToggle}
        disabled={props.busy}
        trackColor={{ false: T.raised, true: T.primaryDim }}
        thumbColor={s.enabled ? T.primary : T.dim}
      />
    </TouchableOpacity>
  );
}

function InstallSkillSheet(props: {
  visible: boolean;
  onClose: () => void;
  onInstall: (from: { gitUrl?: string; dir?: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"gitUrl" | "dir">("gitUrl");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    void props
      .onInstall(mode === "gitUrl" ? { gitUrl: v } : { dir: v })
      .then(() => {
        setValue("");
        props.onClose();
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Sheet title="Install a skill" visible={props.visible} onClose={props.onClose}>
      <Segmented
        options={[
          { key: "gitUrl", label: "From git" },
          { key: "dir", label: "From a folder" },
        ]}
        value={mode}
        onChange={setMode}
      />
      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
        {mode === "gitUrl"
          ? "A git remote containing a SKILL.md. It is cloned into this project's skills/ directory on the machine running the daemon."
          : "A path on the machine running the daemon — not on this phone. The folder must contain a SKILL.md."}
      </Text>
      <TextInput
        style={{ ...field, fontSize: 14 }}
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={mode === "gitUrl" ? "https://github.com/user/skill" : "/Users/you/skills/my-skill"}
        placeholderTextColor={T.faint}
        selectionColor={T.accentBlue}
      />
      {err ? (
        <Text style={{ color: T.err, fontSize: 12.5, lineHeight: 19 }}>{err}</Text>
      ) : null}
      <TouchableOpacity
        onPress={go}
        disabled={busy || !value.trim()}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Install this skill"
        style={{
          minHeight: TAP,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: value.trim() && !busy ? T.bright : T.raised,
          borderWidth: 1,
          borderColor: value.trim() && !busy ? T.bright : T.line,
          borderRadius: radii.key,
        }}
      >
        {busy ? (
          <ActivityIndicator color={T.dim} size="small" />
        ) : (
          <Text style={{ color: value.trim() ? T.onBright : T.dim, fontSize: 14, fontWeight: "700" }}>Install</Text>
        )}
      </TouchableOpacity>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function McpPanel(props: { creds: Creds; projectId: string }) {
  const { creds, projectId } = props;
  const [installed, setInstalled] = useState<McpServer[] | null>(null);
  const [instErr, setInstErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [catalog, setCatalog] = useState<{ servers: McpCatalogEntry[]; featured: McpCatalogEntry[]; degraded: boolean } | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<McpCatalogEntry | null>(null);

  const loadInstalled = useCallback(() => {
    setInstErr(null);
    void getMcps(creds, projectId)
      .then(({ mcps }) => setInstalled(mcps))
      .catch((e: unknown) => setInstErr(e instanceof Error ? e.message : String(e)));
  }, [creds, projectId]);

  useEffect(loadInstalled, [loadInstalled]);

  // Search the registry as the user types. Debounced because this is somebody
  // else's public service and a keystroke is not a query.
  const seq = useRef(0);
  const loadCatalog = useCallback(
    (query: string) => {
      const mine = ++seq.current;
      setSearching(true);
      setCatErr(null);
      void getMcpCatalog(creds, query)
        .then((c) => {
          if (seq.current === mine) setCatalog(c);
        })
        .catch((e: unknown) => {
          if (seq.current === mine) setCatErr(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq.current === mine) setSearching(false);
        });
    },
    [creds],
  );

  useEffect(() => {
    const t = setTimeout(() => loadCatalog(q.trim()), q.trim() ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, loadCatalog]);

  const uninstall = (m: McpServer) => {
    Alert.alert(`Remove ${m.name}?`, "Agents in this project will stop being handed this server.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          void removeMcp(creds, projectId, m.name)
            .then(({ mcps }) => setInstalled(mcps))
            .catch((e: unknown) => Alert.alert("Couldn't remove it", e instanceof Error ? e.message : String(e)));
        },
      },
    ]);
  };

  const installedNames = new Set((installed ?? []).map((m) => m.name.toLowerCase()));
  const results = q.trim() ? (catalog?.servers ?? []) : (catalog?.featured ?? []);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 40 }}>
      <SectionLabel text="Configured for this project" />
      {!installed ? (
        instErr ? (
          <Unreachable what="the installed servers" detail={instErr} onRetry={loadInstalled} />
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 26 }}>
            <ActivityIndicator color={T.primary} />
          </View>
        )
      ) : !installed.length ? (
        <Empty text="No MCP servers configured. Install one below and agents in this project get handed it on every turn." />
      ) : (
        installed.map((m) => (
          <View
            key={m.name}
            style={{
              backgroundColor: T.panel,
              borderWidth: 1,
              borderColor: T.line,
              borderRadius: radii.card,
              padding: 12,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                {m.name}
              </Text>
              {/* Measured by the daemon's probe. Never derived from the url. */}
              <Badge
                text={m.connected ? "reachable" : "unreachable"}
                tint={m.connected ? T.ok : T.err}
              />
            </View>
            {m.description ? (
              <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }} numberOfLines={2}>
                {m.description}
              </Text>
            ) : null}
            <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
              {m.url ? trunc(m.url, 48) : m.command ? trunc(`${m.command} ${(m.args ?? []).join(" ")}`, 48) : "no endpoint configured"}
              {m.probedAt ? ` · probed ${new Date(m.probedAt).toLocaleTimeString()}` : ""}
            </Text>
            <TouchableOpacity
              onPress={() => uninstall(m)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${m.name}`}
              style={{
                alignSelf: "flex-start",
                minHeight: TAP,
                justifyContent: "center",
                paddingHorizontal: 16,
                borderWidth: 1,
                borderColor: T.line,
                backgroundColor: T.raised,
                borderRadius: radii.key,
              }}
            >
              <Text style={{ color: T.err, fontSize: 12.5, fontWeight: "600" }}>Remove</Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      <View style={{ height: 1, backgroundColor: T.line, marginVertical: 4 }} />

      <SectionLabel text="Add a server" />
      <TextInput
        style={{ ...field, paddingVertical: 10, fontSize: 14 }}
        value={q}
        onChangeText={setQ}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Search the MCP registry…"
        placeholderTextColor={T.faint}
        selectionColor={T.accentBlue}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 16 }}>
        <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono, flex: 1 }}>
          {searching
            ? "searching the registry…"
            : q.trim()
              ? `${results.length} result${results.length === 1 ? "" : "s"}`
              : "hand-verified servers — search to see the whole registry"}
        </Text>
        {searching ? <ActivityIndicator color={T.dim} size="small" /> : null}
      </View>

      {/* `degraded` is the registry not answering. That is a different thing
          from "nothing matched", and conflating them would be a lie. */}
      {catalog?.degraded ? (
        <Panel tint={T.warn}>
          <Text style={{ color: T.warn, fontSize: 12.5, lineHeight: 19 }}>
            The public MCP registry didn&apos;t answer, so search results are empty for that reason — not because
            nothing matched. The verified servers below need no network.
          </Text>
        </Panel>
      ) : null}

      {catErr ? (
        <Unreachable what="the registry" detail={catErr} onRetry={() => loadCatalog(q.trim())} />
      ) : !results.length && !searching ? (
        <Empty text={q.trim() ? `Nothing in the registry matches “${q.trim()}”.` : "No servers to show."} />
      ) : (
        results.map((e) => {
          const already = installedNames.has(e.name.toLowerCase());
          return (
            <TouchableOpacity
              key={e.id ?? e.slug ?? e.name}
              onPress={() => !already && setPicked(e)}
              disabled={already}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={already ? `${e.name} is already installed` : `Install ${e.title ?? e.name}`}
              style={{
                minHeight: TAP,
                backgroundColor: T.panel,
                borderWidth: 1,
                borderColor: T.line,
                borderRadius: radii.card,
                padding: 12,
                gap: 5,
                opacity: already ? 0.5 : 1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                  {e.title ?? e.name}
                </Text>
                {already ? <Badge text="installed" tint={T.ok} /> : <Text style={{ color: T.faint, fontSize: 12 }}>install ›</Text>}
              </View>
              {e.description ? (
                <Text style={{ color: T.dim, fontSize: 11.5, lineHeight: 17 }} numberOfLines={2}>
                  {e.description}
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {e.transport ? <Badge text={e.transport} /> : null}
                {e.maintainer ? <Badge text={e.maintainer} tint={T.thread} /> : null}
                {e.needsUrl ? <Badge text="needs a url" tint={T.warn} /> : null}
                {e.command && !e.url ? <Badge text="runs a command" /> : null}
              </View>
            </TouchableOpacity>
          );
        })
      )}

      <InstallMcpSheet
        entry={picked}
        onClose={() => setPicked(null)}
        onInstall={async (body) => {
          const { mcps } = await installMcp(creds, projectId, body);
          setInstalled(mcps);
        }}
      />
    </ScrollView>
  );
}

function InstallMcpSheet(props: {
  entry: McpCatalogEntry | null;
  onClose: () => void;
  onInstall: (body: Partial<McpCatalogEntry> & { name: string }) => Promise<void>;
}) {
  const e = props.entry;
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset per entry: the url typed for one server must never be carried into
  // the install of a different one.
  useEffect(() => {
    setUrl(e?.url ?? "");
    setErr(null);
  }, [e]);

  if (!e) {
    return (
      <Sheet title="" visible={false} onClose={props.onClose}>
        {null}
      </Sheet>
    );
  }

  const needsUrl = !e.command && (e.needsUrl || !e.url);
  const ready = !needsUrl || url.trim().length > 0;

  const go = () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    void props
      .onInstall({
        name: e.name,
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(e.command ? { command: e.command, args: e.args } : {}),
        ...(e.transport ? { transport: e.transport } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.slug ? { slug: e.slug } : {}),
      })
      .then(props.onClose)
      .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))
      .finally(() => setBusy(false));
  };

  return (
    <Sheet title={e.title ?? e.name} visible onClose={props.onClose}>
      {e.description ? (
        <Text style={{ color: T.dim, fontSize: 13, lineHeight: 20 }}>{e.description}</Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Badge text={e.name} />
        {e.transport ? <Badge text={e.transport} /> : null}
        {e.version ? <Badge text={`v${e.version}`} /> : null}
        {e.maintainer ? <Badge text={e.maintainer} tint={T.thread} /> : null}
      </View>
      {e.requires ? (
        <Text style={{ color: T.warn, fontSize: 12, lineHeight: 18 }}>Requires: {e.requires}</Text>
      ) : null}

      {e.command ? (
        <View style={{ gap: 5 }}>
          <SectionLabel text="Runs on the daemon's machine" />
          <Text style={{ color: T.dim, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={2}>
            {e.command} {(e.args ?? []).join(" ")}
          </Text>
        </View>
      ) : (
        <View style={{ gap: 5 }}>
          <SectionLabel text={needsUrl ? "Endpoint (required)" : "Endpoint"} />
          {needsUrl ? (
            <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
              The registry lists this server but not an address for it. Paste the http(s) endpoint you were given.
            </Text>
          ) : null}
          <TextInput
            style={{ ...field, fontSize: 13 }}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://…"
            placeholderTextColor={T.faint}
            selectionColor={T.accentBlue}
          />
        </View>
      )}

      {err ? <Text style={{ color: T.err, fontSize: 12.5, lineHeight: 19 }}>{err}</Text> : null}

      <TouchableOpacity
        onPress={go}
        disabled={!ready || busy}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Install ${e.name}`}
        style={{
          minHeight: TAP,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: ready && !busy ? T.bright : T.raised,
          borderWidth: 1,
          borderColor: ready && !busy ? T.bright : T.line,
          borderRadius: radii.key,
        }}
      >
        {busy ? (
          <ActivityIndicator color={T.dim} size="small" />
        ) : (
          <Text style={{ color: ready ? T.onBright : T.dim, fontSize: 14, fontWeight: "700" }}>Install</Text>
        )}
      </TouchableOpacity>
      <Text style={{ color: T.faint, fontSize: 10.5, lineHeight: 16 }}>
        The daemon probes the endpoint after saving, so the reachable/unreachable badge is measured — a server that
        fails its probe is still installed.
      </Text>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** The roles the router already understands. Free text still works. */
const ROLE_PRESETS = ["planner", "builder", "reviewer", "researcher", "tester"];

function AgentsPanel(props: { creds: Creds; project: Project; onChanged: () => void }) {
  const { creds, project } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; role: string } | null>(null);

  const toggle = (agentId: string, enabled: boolean) => {
    setBusy(agentId);
    void setAgentEnabled(creds, project.id, agentId, enabled)
      .then(props.onChanged)
      // The daemon 409s for the baton holder and for an agent mid-turn, with the
      // reason in the message. That reason is the whole answer — show it.
      .catch((e: unknown) => Alert.alert("Couldn't change that agent", e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const saveRole = (agentId: string, role: string) => {
    const clean = role.trim();
    if (!clean) return;
    setBusy(agentId);
    void setAgentRole(creds, project.id, agentId, clean)
      .then(() => {
        setEditing(null);
        props.onChanged();
      })
      .catch((e: unknown) => Alert.alert("Couldn't change that role", e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.sm, paddingBottom: 40 }}>
      <Panel>
        <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
          An agent that is off stays in the roster but is never spawned and can&apos;t hold the baton. The daemon
          refuses to switch off whoever holds it or is mid-turn.
        </Text>
      </Panel>

      {!project.agents.length ? (
        <Empty text="No agents configured for this project." />
      ) : (
        project.agents.map((a) => {
          const enabled = a.enabled !== false;
          return (
            <View
              key={a.id}
              style={{
                backgroundColor: T.panel,
                borderWidth: 1,
                borderColor: a.holdsBaton ? T.primaryDim : T.line,
                borderRadius: radii.card,
                padding: 12,
                gap: 9,
                opacity: enabled ? 1 : 0.6,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
                    {a.holdsBaton ? "◆ " : ""}
                    {trunc(a.id, 22)}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
                    {a.kind}
                    {a.model ? ` · ${trunc(a.model, 24)}` : ""}
                    {a.tier === "bridge" ? " · bridge" : ""}
                  </Text>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={(v) => toggle(a.id, v)}
                  disabled={busy === a.id}
                  trackColor={{ false: T.raised, true: T.primaryDim }}
                  thumbColor={enabled ? T.primary : T.dim}
                />
              </View>
              <TouchableOpacity
                onPress={() => setEditing({ id: a.id, role: a.role })}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Change ${a.id}'s role, currently ${a.role || "unset"}`}
                style={{
                  minHeight: TAP,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 12,
                  backgroundColor: T.raised,
                  borderWidth: 1,
                  borderColor: T.line,
                  borderRadius: radii.key,
                }}
              >
                <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>role</Text>
                <Text style={{ color: T.text, fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                  {a.role || "unset"}
                </Text>
                <Text style={{ color: T.faint, fontSize: 12 }}>change ›</Text>
              </TouchableOpacity>
            </View>
          );
        })
      )}

      <RoleSheet
        editing={editing}
        busy={busy !== null}
        onClose={() => setEditing(null)}
        onSave={saveRole}
      />
    </ScrollView>
  );
}

function RoleSheet(props: {
  editing: { id: string; role: string } | null;
  busy: boolean;
  onClose: () => void;
  onSave: (agentId: string, role: string) => void;
}) {
  const [value, setValue] = useState("");
  const e = props.editing;
  useEffect(() => setValue(e?.role ?? ""), [e]);

  return (
    <Sheet title={e ? `Role · ${trunc(e.id, 20)}` : ""} visible={e !== null} onClose={props.onClose}>
      <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 19 }}>
        The role is what the router matches on when it picks who should take the next hop. Anything up to 40
        characters works — the presets are only the ones already in use.
      </Text>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {ROLE_PRESETS.map((r) => (
          <TouchableOpacity
            key={r}
            onPress={() => setValue(r)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Use the role ${r}`}
            style={{
              minHeight: 38,
              justifyContent: "center",
              paddingHorizontal: 14,
              borderRadius: radii.pill,
              borderWidth: 1,
              borderColor: value === r ? T.primary : T.line,
              backgroundColor: value === r ? T.primaryDim : T.raised,
            }}
          >
            <Text style={{ color: value === r ? T.primary : T.dim, fontSize: 12.5, fontWeight: "600" }}>{r}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        style={{ ...field, fontSize: 14 }}
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={40}
        placeholder="role"
        placeholderTextColor={T.faint}
        selectionColor={T.accentBlue}
      />
      <TouchableOpacity
        onPress={() => e && props.onSave(e.id, value)}
        disabled={props.busy || !value.trim()}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Save this role"
        style={{
          minHeight: TAP,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: value.trim() && !props.busy ? T.bright : T.raised,
          borderWidth: 1,
          borderColor: value.trim() && !props.busy ? T.bright : T.line,
          borderRadius: radii.key,
        }}
      >
        <Text style={{ color: value.trim() ? T.onBright : T.dim, fontSize: 14, fontWeight: "700" }}>Save</Text>
      </TouchableOpacity>
    </Sheet>
  );
}
