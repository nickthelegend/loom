/**
 * Account & privacy — the profile sheet behind the avatar on the board.
 *
 * Who you're signed in as (if anyone), the one analytics switch, and how the
 * phone is reaching the daemon right now. The stats switch describes exactly
 * what is sent, because "anonymous analytics" alone is a claim, not a fact.
 */

import type { User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Switch, Text, TouchableOpacity, View } from "react-native";
import { getUpdates, type Creds, type UpdateStatus } from "./api";
import { DESKTOP_URL, INSTALL_URL, REPO_URL, appVersion, canRate, open as openLink, rateLoom } from "./links";
import { PUSH_KINDS, loadPushKinds, setPushKinds, type PushKind, type PushState } from "./push";
import { ConnectionBadge, GoogleMark, routeHint, useConnRoute } from "./brand";
import { Panel, SectionLabel, TAP } from "./components";
import { Sheet } from "./observatory";
import { useTeamSummary } from "./team";
import {
  loadUsageStatsEnabled,
  profileOf,
  setUsageStatsEnabled,
  signInWithGoogle,
  signOut,
  supabaseConfigured,
} from "./supabase";
import { T, pickTheme, radii, type ThemePref } from "./theme";

/** The round avatar: Google's picture when there is one, otherwise an initial. */
export function Avatar(props: { user: User | null; size?: number }) {
  const size = props.size ?? 32;
  const p = profileOf(props.user);
  const [broken, setBroken] = useState(false);
  if (p?.avatarUrl && !broken) {
    return (
      <Image
        source={{ uri: p.avatarUrl }}
        onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: T.raised }}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: T.raised,
        borderWidth: 1,
        borderColor: T.line2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {p ? (
        <Text style={{ color: T.text, fontSize: size * 0.42, fontWeight: "700" }}>
          {(p.name[0] ?? "?").toUpperCase()}
        </Text>
      ) : (
        // signed out: a hollow head-and-shoulders, drawn from two views
        <View style={{ alignItems: "center", gap: size * 0.05 }}>
          <View
            style={{
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: size * 0.15,
              borderWidth: 1.5,
              borderColor: T.dim,
            }}
          />
          <View
            style={{
              width: size * 0.5,
              height: size * 0.2,
              borderTopLeftRadius: size * 0.25,
              borderTopRightRadius: size * 0.25,
              borderWidth: 1.5,
              borderBottomWidth: 0,
              borderColor: T.dim,
            }}
          />
        </View>
      )}
    </View>
  );
}

export function AccountSheet(props: {
  visible: boolean;
  onClose: () => void;
  user: User | null;
  creds: Creds | null;
  onSignedOut: () => void;
  /** Open the Fleet screen's Team section. */
  onOpenTeam?: () => void;
  themePref: ThemePref;
}) {
  const profile = profileOf(props.user);
  const team = useTeamSummary(props.creds, props.visible);
  const route = useConnRoute();
  const [stats, setStats] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) void loadUsageStatsEnabled().then(setStats);
  }, [props.visible]);

  // which notifications this phone wants, and whether the computer's Loom is current
  const [kinds, setKinds] = useState<PushKind[] | null>(null);
  const [pushState, setPushState] = useState<PushState>("on");
  const [upd, setUpd] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!props.visible) return;
    void loadPushKinds().then(setKinds);
    if (props.creds) void getUpdates(props.creds).then(setUpd).catch(() => setUpd(null));
  }, [props.visible, props.creds]);
  const toggleKind = (k: PushKind, on: boolean) => {
    if (!kinds || !props.creds) return;
    const next = on ? [...kinds, k] : kinds.filter((x) => x !== k);
    setKinds(next);
    void setPushKinds(props.creds, next).then(setPushState);
  };

  const toggleStats = (on: boolean) => {
    setStats(on);
    void setUsageStatsEnabled(on);
  };

  const google = async () => {
    setErr(null);
    setBusy(true);
    const r = await signInWithGoogle();
    setBusy(false);
    if (!r.ok && !r.cancelled) setErr(r.error);
  };

  return (
    <Sheet title="Account" visible={props.visible} onClose={props.onClose}>
      {/* who */}
      <Panel>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Avatar user={props.user} size={48} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: T.text, fontSize: 16, fontWeight: "700" }} numberOfLines={1}>
              {profile ? profile.name : "Not signed in"}
            </Text>
            <Text
              style={{ color: T.dim, fontSize: 12.5, fontFamily: profile ? T.mono : undefined, marginTop: 2 }}
              numberOfLines={1}
            >
              {profile ? profile.email : "Loom works fully without one"}
            </Text>
          </View>
        </View>
        {/* a build without sign-in (the store build, a fork) just doesn't offer it */}
        {!profile && supabaseConfigured && (
          <TouchableOpacity
            onPress={google}
            disabled={!supabaseConfigured || busy}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            style={{
              minHeight: TAP,
              marginTop: 4,
              borderRadius: 10,
              backgroundColor: T.bright,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              opacity: supabaseConfigured ? 1 : 0.38,
            }}
          >
            {busy ? (
              <ActivityIndicator color={T.onBright} />
            ) : (
              <>
                <GoogleMark size={18} />
                <Text style={{ color: T.onBright, fontSize: 14.5, fontWeight: "700" }}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>
        )}
        {err && <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text>}
      </Panel>

      {/* appearance — the desktop's three choices */}
      <View style={{ gap: 6 }}>
        <SectionLabel text="Appearance" />
        <Panel>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["dark", "light", "system"] as const).map((p) => {
              const on = props.themePref === p;
              return (
                <TouchableOpacity
                  key={p}
                  onPress={() => pickTheme(p)}
                  activeOpacity={0.7}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={{ flex: 1, minHeight: 38, borderRadius: radii.key, borderWidth: 1, borderColor: on ? T.line2 : T.line,
                    backgroundColor: on ? T.raised : "transparent", alignItems: "center", justifyContent: "center" }}
                >
                  <Text style={{ color: on ? T.text : T.dim, fontSize: 13, fontWeight: "600" }}>
                    {p === "dark" ? "Dark" : p === "light" ? "Light" : "Match phone"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Panel>
      </View>

      {/* privacy — only a build that can send the stats (Supabase configured) asks about them */}
      {supabaseConfigured && (
      <View style={{ gap: 6 }}>
        <SectionLabel text="Privacy" />
        <Panel>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: TAP }}>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: "600", flex: 1 }}>
              Anonymous usage stats (country only)
            </Text>
            <Switch
              value={stats}
              onValueChange={toggleStats}
              trackColor={{ false: T.raised, true: T.ok }}
              thumbColor="#ffffff"
              accessibilityLabel="Anonymous usage stats, country only"
            />
          </View>
          <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
            At most once a day: your phone&apos;s region setting, the platform and the app version. No account, no
            device id, no location, no IP lookup.
          </Text>
        </Panel>
      </View>
      )}

      {/* notifications: one switch per kind the daemon pushes */}
      {props.creds && kinds && (
        <View style={{ gap: 6 }}>
          <SectionLabel text="Notifications" />
          <Panel>
            {PUSH_KINDS.map((k) => (
              <View key={k.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: TAP }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>{k.label}</Text>
                  <Text style={{ color: T.dim, fontSize: 12, marginTop: 1 }} numberOfLines={2}>{k.hint}</Text>
                </View>
                <Switch
                  value={kinds.includes(k.id)}
                  onValueChange={(on) => toggleKind(k.id, on)}
                  trackColor={{ false: T.raised, true: T.ok }}
                  thumbColor="#ffffff"
                  accessibilityLabel={`${k.label} notifications`}
                />
              </View>
            ))}
            {pushState !== "on" && (
              <Text style={{ color: T.warn, fontSize: 12, lineHeight: 17 }}>
                {pushState === "denied"
                  ? "Notifications are off for Loom in your phone's settings, so these can't reach you yet."
                  : "This device can't get push notifications (a simulator, or a build without push). Your choices are kept for when it can."}
              </Text>
            )}
          </Panel>
        </View>
      )}

      {/* team: a pointer to the Fleet's Team section, not a second copy of it */}
      {props.creds && team && props.onOpenTeam && (
        <View style={{ gap: 6 }}>
          <SectionLabel text="Team" />
          <TouchableOpacity
            onPress={props.onOpenTeam}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={
              team.kind === "team"
                ? `Team ${team.name}, ${team.members} members. Open the team view`
                : team.kind === "none"
                  ? "Not on a team. Join a team"
                  : "Team view needs a full pairing"
            }
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: TAP + 8,
              paddingHorizontal: 12,
              borderRadius: radii.card,
              borderWidth: 1,
              borderColor: T.line,
              backgroundColor: T.panel,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
                {team.kind === "team" ? team.name : team.kind === "none" ? "Join a team" : "Team"}
              </Text>
              <Text style={{ color: T.dim, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                {team.kind === "team"
                  ? `${team.members} member${team.members === 1 ? "" : "s"}${team.more > 0 ? ` · +${team.more} more team${team.more === 1 ? "" : "s"}` : ""}`
                  : team.kind === "none"
                    ? "See your teammates' live agents"
                    : "Needs a full (unscoped) pairing"}
              </Text>
            </View>
            <Text style={{ color: T.faint, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* connection */}
      {props.creds && (
        <View style={{ gap: 6 }}>
          <SectionLabel text="Connection" />
          <Panel>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ConnectionBadge />
              <Text style={{ color: T.dim, fontSize: 12, flex: 1 }} numberOfLines={2}>
                {routeHint(route)}
              </Text>
            </View>
            <Text style={{ color: T.faint, fontSize: 11.5, fontFamily: T.mono }} numberOfLines={1}>
              {props.creds.url.replace(/^https?:\/\//, "")}
              {props.creds.relay ? " · Loom Cloud paired" : " · direct only"}
            </Text>
          </Panel>
        </View>
      )}

      {/* about: Loom is open source and runs on your computer; this app is its remote */}
      <View style={{ gap: 6 }}>
        <SectionLabel text="About" />
        <Panel>
          {props.creds && upd && (
            <TouchableOpacity
              onPress={() => upd.behindRelease && openLink(upd.release?.url ?? DESKTOP_URL)}
              disabled={!upd.behindRelease}
              activeOpacity={0.7}
              accessibilityRole={upd.behindRelease ? "link" : "text"}
              style={{ minHeight: TAP, justifyContent: "center" }}
            >
              <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>
                Loom on your computer · {upd.version}
              </Text>
              <Text style={{ color: upd.behindRelease ? T.warn : T.dim, fontSize: 12, marginTop: 1 }}>
                {upd.behindRelease
                  ? `${upd.latest} is out — update from Loom's Settings there, or run loom update →`
                  : upd.latest ? "Up to date" : "Couldn't check for a newer release"}
              </Text>
            </TouchableOpacity>
          )}
          <AboutRow label="Install Loom on a computer" hint="macOS, Linux and Windows · npm, one-liner or Loom Desktop" onPress={() => openLink(INSTALL_URL)} />
          <AboutRow label="Source code on GitHub" hint="Loom is open source — star it, file an issue, send a fix" onPress={() => openLink(REPO_URL)} />
          {canRate && <AboutRow label="Rate Loom" hint="On Google Play — it helps other people find it" onPress={rateLoom} />}
          <Text style={{ color: T.faint, fontSize: 11.5, fontFamily: T.mono }}>app {appVersion()}</Text>
        </Panel>
      </View>

      {profile && (
        <TouchableOpacity
          onPress={() => {
            void signOut().then(props.onSignedOut);
          }}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={{
            minHeight: TAP,
            borderRadius: radii.key,
            borderWidth: 1,
            borderColor: T.line2,
            backgroundColor: T.raised,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: T.err, fontSize: 14, fontWeight: "600" }}>Sign out</Text>
        </TouchableOpacity>
      )}
    </Sheet>
  );
}

function AboutRow(props: { label: string; hint: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={props.onPress} activeOpacity={0.7} accessibilityRole="link" accessibilityLabel={props.label}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: TAP }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: T.text, fontSize: 14, fontWeight: "600" }}>{props.label}</Text>
        <Text style={{ color: T.dim, fontSize: 12, marginTop: 1 }} numberOfLines={2}>{props.hint}</Text>
      </View>
      <Text style={{ color: T.faint, fontSize: 18 }}>›</Text>
    </TouchableOpacity>
  );
}
