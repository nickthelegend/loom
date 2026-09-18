/**
 * Welcome — the first thing a signed-out phone sees.
 *
 * One primary action (Continue with Google, the near-white key) and one quiet
 * way past it. An account is only for cloud features; Loom itself runs on your
 * own network with none, and the screen says so rather than implying a wall.
 *
 * Motion is kept to what reads as care, not decoration: the mark settles in,
 * the copy rises after it, and the warm halo behind the weave breathes slowly.
 * Everything runs on the native driver and respects Reduce Motion.
 */

import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { GoogleMark, LoomMark } from "./brand";
import { signInWithGoogle, supabaseConfigured } from "./supabase";
import { T, spacing } from "./theme";

const AGENTS = ["Claude Code", "Codex", "Antigravity", "Grok", "OpenCode"];

export function WelcomeScreen(props: { onSignedIn: () => void; onSkip: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mark = useRef(new Animated.Value(0)).current;
  const copy = useRef(new Animated.Value(0)).current;
  const actions = useRef(new Animated.Value(0)).current;
  const halo = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (!live) return;
        if (reduce) {
          mark.setValue(1);
          copy.setValue(1);
          actions.setValue(1);
          halo.setValue(0.5);
          return;
        }
        const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
        Animated.stagger(140, [
          Animated.timing(mark, { toValue: 1, duration: 700, easing: ease, useNativeDriver: true }),
          Animated.timing(copy, { toValue: 1, duration: 600, easing: ease, useNativeDriver: true }),
          Animated.timing(actions, { toValue: 1, duration: 600, easing: ease, useNativeDriver: true }),
        ]).start();
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(halo, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(halo, { toValue: 0, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ]),
        );
        loop.start();
      });
    return () => {
      live = false;
      loop?.stop();
    };
  }, [mark, copy, actions, halo]);

  const google = async () => {
    if (busy || !supabaseConfigured) return;
    setErr(null);
    setBusy(true);
    const r = await signInWithGoogle();
    setBusy(false);
    if (r.ok) props.onSignedIn();
    else if (!r.cancelled) setErr(r.error);
  };

  const rise = (v: Animated.Value, from = 14) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }],
  });

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      {/* a warm, very low glow behind the mark — the weft's colour, barely there */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="34%" rx="70%" ry="45%">
            <Stop offset="0" stopColor="#E8A87C" stopOpacity={0.1} />
            <Stop offset="0.55" stopColor="#E8A87C" stopOpacity={0.025} />
            <Stop offset="1" stopColor="#111111" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow)" />
      </Svg>

      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: spacing.xl }}>
        <Animated.View
          style={{
            alignItems: "center",
            justifyContent: "center",
            opacity: mark,
            transform: [{ scale: mark.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
          }}
        >
          {/* the halo: a soft radial falloff, not a disc — it should read as light */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              width: 260,
              height: 260,
              opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }),
              transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.06] }) }],
            }}
          >
            <Svg width={260} height={260}>
              <Defs>
                <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
                  <Stop offset="0" stopColor="#E8A87C" stopOpacity={0.22} />
                  <Stop offset="0.45" stopColor="#E8A87C" stopOpacity={0.07} />
                  <Stop offset="1" stopColor="#E8A87C" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Rect x="0" y="0" width={260} height={260} fill="url(#halo)" />
            </Svg>
          </Animated.View>
          <View
            style={{
              borderRadius: 24,
              shadowColor: "#000",
              shadowOpacity: 0.5,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 12 },
              elevation: 12,
            }}
          >
            <LoomMark size={104} />
          </View>
        </Animated.View>

        <Animated.View style={[{ alignItems: "center", marginTop: 30, gap: 12 }, rise(copy)]}>
          <Text
            accessibilityRole="header"
            style={{ color: T.text, fontSize: 38, fontWeight: "800", letterSpacing: -1 }}
          >
            loom
          </Text>
          <View style={{ height: 2, width: 44, borderRadius: 1, backgroundColor: T.thread, opacity: 0.8 }} />
          <Text
            style={{
              color: T.bright,
              fontSize: 21,
              fontWeight: "700",
              letterSpacing: -0.4,
              textAlign: "center",
              marginTop: 10,
              lineHeight: 27,
            }}
          >
            One brain for all your{"\n"}coding agents
          </Text>
          <Text style={{ color: T.dim, fontSize: 14, lineHeight: 21, textAlign: "center", maxWidth: 320 }}>
            Shared memory, one thread, and the baton in your pocket — for every agent on your machine.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 8, maxWidth: 330 }}>
            {AGENTS.map((a) => (
              <View
                key={a}
                style={{
                  borderWidth: 1,
                  borderColor: T.line,
                  backgroundColor: "rgba(26,26,26,0.7)",
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }}>{a}</Text>
              </View>
            ))}
          </View>
        </Animated.View>
      </View>

      <Animated.View style={[{ paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: 14 }, rise(actions, 20)]}>
        <Animated.View style={{ transform: [{ scale: press }] }}>
          <Pressable
            onPress={google}
            onPressIn={() => Animated.spring(press, { toValue: 0.97, useNativeDriver: true, speed: 40 }).start()}
            onPressOut={() => Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 30 }).start()}
            disabled={!supabaseConfigured || busy}
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            accessibilityState={{ disabled: !supabaseConfigured, busy }}
            style={{
              height: 54,
              borderRadius: 14,
              backgroundColor: T.bright,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: supabaseConfigured ? 1 : 0.38,
            }}
          >
            {busy ? (
              <ActivityIndicator color={T.onBright} />
            ) : (
              <>
                <GoogleMark size={20} />
                <Text style={{ color: T.onBright, fontSize: 16, fontWeight: "700", letterSpacing: -0.2 }}>
                  Continue with Google
                </Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        {!supabaseConfigured && (
          <Text style={{ color: T.faint, fontSize: 12, lineHeight: 18, textAlign: "center" }}>
            Sign-in isn&apos;t set up in this build (no Supabase keys). Everything else works without an account.
          </Text>
        )}
        {err && (
          <Text style={{ color: T.err, fontSize: 13, lineHeight: 19, textAlign: "center" }} accessibilityLiveRegion="polite">
            {err}
          </Text>
        )}

        <TouchableOpacity
          onPress={props.onSkip}
          activeOpacity={0.6}
          accessibilityRole="button"
          style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: T.text, fontSize: 14.5, fontWeight: "600" }}>Continue without an account</Text>
        </TouchableOpacity>

        <Text style={{ color: T.faint, fontSize: 11.5, lineHeight: 17, textAlign: "center" }}>
          Loom runs fully on your own network. An account only turns on cloud features.
        </Text>
      </Animated.View>
    </View>
  );
}
