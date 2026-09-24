/**
 * Per-agent permissions: Bypass / Auto / Always ask, one chip in the composer.
 *
 * Every CLI Loom drives says "may I?" differently; the daemon maps three words
 * onto each and publishes the table at /api/permissions. The sheet reads that
 * table rather than hard-coding it, so the labels are the daemon's own, and a
 * cell measured not to work (OpenCode "ask", Antigravity "auto") shows disabled
 * with the reason instead of a switch that lies.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import {
  PERMISSION_MODES,
  getPermissionProfiles,
  setAgentPermissions,
  type AgentStatus,
  type Creds,
  type PermissionMode,
  type PermissionProfile,
} from "./api";
import { agentLabel } from "./agents";
import { TAP } from "./components";
import { Sheet } from "./observatory";
import { T, radii } from "./theme";

const MODE_NAME: Record<PermissionMode, string> = { bypass: "Bypass", auto: "Auto", ask: "Always ask" };
const MODE_COLOR: Record<PermissionMode, string> = {
  get bypass() {
    return T.warn;
  },
  get auto() {
    return T.dim;
  },
  get ask() {
    return T.thread;
  },
};

/** The profile table is the same for every project on a daemon: fetch it once. */
let cache: { url: string; p: Promise<Record<string, PermissionProfile>> } | null = null;
export function usePermissionProfiles(creds: Creds): Record<string, PermissionProfile> | null {
  const [profiles, setProfiles] = useState<Record<string, PermissionProfile> | null>(null);
  useEffect(() => {
    let live = true;
    if (!cache || cache.url !== creds.url) {
      const p = getPermissionProfiles(creds).then((r) => r.profiles ?? {});
      cache = { url: creds.url, p };
      p.catch(() => {
        if (cache?.p === p) cache = null; // an older daemon, or a blip: try again next mount
      });
    }
    cache.p.then((p) => live && setProfiles(p)).catch(() => {});
    return () => {
      live = false;
    };
  }, [creds]);
  return profiles;
}

/** The mode in effect: what the daemon reports, else the kind's default. */
export function modeOf(agent: { kind: string; permissions?: PermissionMode }, profiles: Record<string, PermissionProfile> | null) {
  return agent.permissions ?? profiles?.[agent.kind]?.default ?? null;
}

/** A small read-only mode tag, used by the Fleet rows. */
export function PermissionTag(props: { mode: PermissionMode | null | undefined }) {
  if (!props.mode) return null;
  const c = MODE_COLOR[props.mode];
  return (
    <View style={{ borderWidth: 1, borderColor: T.line2, borderRadius: radii.pill, paddingHorizontal: 7, paddingVertical: 1 }}>
      <Text style={{ color: c, fontSize: 10, fontFamily: T.mono }}>{MODE_NAME[props.mode].toLowerCase()}</Text>
    </View>
  );
}

/**
 * The composer chip next to the agent picker. Hidden when the daemon has no
 * profile for this agent's kind (an older daemon, or a bridge agent).
 */
export function PermissionChip(props: {
  creds: Creds;
  projectId: string;
  agent: AgentStatus | null;
  onChanged: () => void;
}) {
  const profiles = usePermissionProfiles(props.creds);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<PermissionMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // optimistic: the roster poll catches up a few seconds later
  const [pending, setPending] = useState<{ agent: string; mode: PermissionMode } | null>(null);

  const agent = props.agent;
  const profile = agent ? profiles?.[agent.kind] : undefined;
  useEffect(() => {
    if (pending && agent && (agent.id !== pending.agent || agent.permissions === pending.mode)) setPending(null);
  }, [agent, pending]);
  if (!agent || !profile) return null;

  const current: PermissionMode =
    pending?.agent === agent.id ? pending.mode : (agent.permissions ?? profile.default);

  const pick = async (mode: PermissionMode) => {
    if (mode === current || busy) return setOpen(false);
    setErr(null);
    setBusy(mode);
    try {
      await setAgentPermissions(props.creds, props.projectId, agent.id, mode);
      setPending({ agent: agent.id, mode });
      props.onChanged();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TouchableOpacity
        onPress={() => {
          setErr(null);
          setOpen(true);
        }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Permissions: ${MODE_NAME[current]}. Change`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 34,
          paddingHorizontal: 10,
          borderRadius: radii.pill,
          borderWidth: 1,
          borderColor: T.line2,
          backgroundColor: T.raised,
        }}
      >
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: MODE_COLOR[current] }} />
        <Text style={{ color: T.text, fontSize: 12, fontWeight: "600" }}>{MODE_NAME[current]}</Text>
        <Text style={{ color: T.dim, fontSize: 10 }}>▼</Text>
      </TouchableOpacity>

      <Sheet title={`${agentLabel(agent.kind)} · permissions`} visible={open} onClose={() => setOpen(false)}>
        {PERMISSION_MODES.map((mode) => {
          const cell = profile.modes[mode];
          if (!cell) return null;
          const on = mode === current;
          const off = !!cell.unsupported;
          return (
            <TouchableOpacity
              key={mode}
              onPress={() => void pick(mode)}
              disabled={off || !!busy}
              activeOpacity={0.7}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: on, disabled: off }}
              accessibilityHint={off ? cell.unsupported : undefined}
              style={{
                gap: 4,
                minHeight: TAP + 8,
                paddingVertical: 11,
                paddingHorizontal: 12,
                borderRadius: radii.card,
                borderWidth: 1,
                borderColor: on ? T.line2 : T.line,
                backgroundColor: on ? T.raised : T.panel,
                opacity: off ? 0.5 : 1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: off ? T.faint : MODE_COLOR[mode] }} />
                <Text style={{ color: T.text, fontSize: 14.5, fontWeight: "600", flex: 1 }}>
                  {MODE_NAME[mode]}
                  {mode === profile.default ? <Text style={{ color: T.faint, fontWeight: "400" }}> · default</Text> : null}
                </Text>
                {busy === mode ? <ActivityIndicator size="small" color={T.dim} /> : null}
                {on ? <Text style={{ color: T.text, fontSize: 15, fontWeight: "700" }}>✓</Text> : null}
              </View>
              <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>{cell.label}</Text>
              {mode === "ask" && cell.ask === "read-only" && !off ? (
                <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17 }}>
                  This agent can't route prompts to Loom, so "ask" runs it read-only instead.
                </Text>
              ) : null}
              {off ? (
                <Text style={{ color: T.warn, fontSize: 11.5, lineHeight: 17 }}>Unavailable: {cell.unsupported}</Text>
              ) : (
                <Text style={{ color: T.faint, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={2}>
                  {cell.flags}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
        {err ? <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text> : null}
        <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17 }}>
          Takes effect on {agent.id}&apos;s next turn.
        </Text>
      </Sheet>
    </>
  );
}
