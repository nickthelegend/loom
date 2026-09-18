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
import type { Creds } from "./api";
import { ConnectionBadge, GoogleMark, routeHint, useConnRoute } from "./brand";
import { Panel, SectionLabel, TAP } from "./components";
import { Sheet } from "./observatory";
import {
  loadUsageStatsEnabled,
  profileOf,
  setUsageStatsEnabled,
  signInWithGoogle,
  signOut,
  supabaseConfigured,
} from "./supabase";
import { T, radii } from "./theme";

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
}) {
  const profile = profileOf(props.user);
  const route = useConnRoute();
  const [stats, setStats] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) void loadUsageStatsEnabled().then(setStats);
  }, [props.visible]);

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
        {!profile && (
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
        {!profile && !supabaseConfigured && (
          <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17 }}>
            Sign-in isn&apos;t set up in this build (no Supabase keys).
          </Text>
        )}
        {err && <Text style={{ color: T.err, fontSize: 12.5 }}>{err}</Text>}
      </Panel>

      {/* privacy */}
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
              thumbColor={T.bright}
              accessibilityLabel="Anonymous usage stats, country only"
            />
          </View>
          <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
            At most once a day: your phone&apos;s region setting, the platform and the app version. No account, no
            device id, no location, no IP lookup.
          </Text>
        </Panel>
      </View>

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
