/**
 * The team policy in effect for a project (`loom.team.json`), read-only. It is
 * policy as code: the reviewed copy on origin's default branch, which a local
 * copy may only make stricter. Changing it is a pull request, not a phone tap,
 * so this card only says what the rules are and where they came from.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { getTeamPolicy, type Creds, type TeamPolicy } from "./api";
import { agentLabel } from "./agents";
import { Panel, SectionLabel } from "./components";
import { T, radii } from "./theme";

const SOURCE: Record<TeamPolicy["source"], string> = {
  origin: "From loom.team.json on origin's default branch (reviewed). A local copy can only tighten it.",
  local: "From a local loom.team.json only. Nothing reviewed on origin yet, so treat it as a draft.",
  none: "No loom.team.json in this repo, so the team's rules are open.",
};

/** The permission picker's own names, so the ceiling reads the same as the chip it caps. */
const CEILING: Record<string, string> = {
  ask: "Always ask: no agent runs looser than that",
  auto: "Auto: no agent runs in Bypass",
  bypass: "Bypass: no ceiling",
};

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

function Globs(props: { items: string[]; tint?: string; empty: string }) {
  if (!props.items.length) return <Text style={{ color: T.faint, fontSize: 12 }}>{props.empty}</Text>;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {props.items.map((g) => (
        <View
          key={g}
          style={{
            borderWidth: 1,
            borderColor: props.tint ?? T.line2,
            backgroundColor: T.raised,
            borderRadius: radii.row,
            paddingHorizontal: 6,
            paddingVertical: 1,
            maxWidth: "100%",
          }}
        >
          <Text style={{ color: props.tint ?? T.dim, fontSize: 10.5, fontFamily: T.mono }} numberOfLines={1}>
            {g}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: T.dim, fontSize: 11, fontWeight: "600", letterSpacing: 0.3 }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

const cap = (n: number | null) => (n === null ? "no cap" : String(n));

export function TeamPolicyCard(props: { creds: Creds; projectId: string }) {
  const [policy, setPolicy] = useState<TeamPolicy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getTeamPolicy(props.creds, props.projectId);
      setPolicy(r.policy);
      setErr(null);
    } catch (e) {
      // an older daemon has no policy route: the card just doesn't show
      if (statusOf(e) === 404) setGone(true);
      else setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.creds, props.projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (gone) return null;

  const p = policy;
  const summary = !p
    ? ""
    : p.source === "none"
      ? "open · no loom.team.json"
      : [
          p.hardZones.length ? `${p.hardZones.length} hard zone${p.hardZones.length === 1 ? "" : "s"}` : null,
          `ceiling ${p.permissions.ceiling}`,
          p.agents.allow ? `${p.agents.allow.length} agent${p.agents.allow.length === 1 ? "" : "s"} allowed` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <View style={{ gap: 6 }}>
      <SectionLabel text="Team policy" />
      <Panel>
        {!p ? (
          err ? (
            <View style={{ gap: 6 }}>
              <Text style={{ color: T.err, fontSize: 12 }}>Couldn&apos;t read the team policy: {err}</Text>
              <TouchableOpacity onPress={() => void load()} accessibilityRole="button" style={{ minHeight: 32, justifyContent: "center" }}>
                <Text style={{ color: T.text, fontSize: 12.5, fontWeight: "600" }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ActivityIndicator color={T.dim} />
          )
        ) : (
          <>
            <TouchableOpacity
              onPress={() => setOpen((o) => !o)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`Team policy, ${summary}. ${open ? "Hide" : "Show"} the rules`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}
            >
              <Text style={{ color: T.text, fontSize: 12.5, fontFamily: T.mono, flex: 1 }} numberOfLines={2}>
                {summary}
              </Text>
              <Text style={{ color: T.faint, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
            </TouchableOpacity>
            {open ? (
              <View style={{ gap: 12 }}>
                <Row label="Hard zones · one member at a time">
                  <Globs items={p.hardZones} tint={T.warn} empty="none" />
                </Row>
                <Row label="Permission ceiling">
                  <Text style={{ color: T.text, fontSize: 12.5 }}>
                    {CEILING[p.permissions.ceiling] ?? p.permissions.ceiling}
                    {p.permissions.bypassRequiresPlan ? " · bypass only with a plan" : ""}
                  </Text>
                </Row>
                <Row label="Agents allowed">
                  {p.agents.allow ? (
                    <Globs items={p.agents.allow.map((a) => agentLabel(a))} empty="none: no agent may run" />
                  ) : (
                    <Text style={{ color: T.text, fontSize: 12.5 }}>any agent</Text>
                  )}
                </Row>
                <Row label="Protected branches · delivered by PR only">
                  <Globs items={p.delivery.protected} empty="none" />
                </Row>
                <Row label="Orchestra caps">
                  <Text style={{ color: T.text, fontSize: 12.5, fontFamily: T.mono }}>
                    per member {cap(p.orchestra.maxParallelPerMember)} · team {cap(p.orchestra.teamMaxConcurrentAgents)}
                  </Text>
                </Row>
              </View>
            ) : null}
            <Text style={{ color: T.faint, fontSize: 11, lineHeight: 16 }}>{SOURCE[p.source] ?? p.source}</Text>
          </>
        )}
      </Panel>
    </View>
  );
}
