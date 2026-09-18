/**
 * Brand marks and the connection badge.
 *
 * LoomMark is assets/icon.svg drawn live (the weave: three warp threads, three
 * weft threads, interlaced) so it stays crisp at any size and can sit on the
 * welcome screen without a bitmap. GoogleMark is Google's own four-colour "G",
 * as their sign-in branding rules require.
 */

import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import Svg, { Defs, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { connection, type ConnRoute } from "./api";
import { T, radii } from "./theme";

export function LoomMark(props: { size: number; plate?: boolean }) {
  const { size } = props;
  const plate = props.plate ?? true;
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024" fill="none">
      <Defs>
        <LinearGradient id="bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#2A2D32" />
          <Stop offset="1" stopColor="#16181B" />
        </LinearGradient>
        <LinearGradient id="warp" x1="512" y1="180" x2="512" y2="844" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#FAFAFA" stopOpacity={0.95} />
          <Stop offset="1" stopColor="#FAFAFA" stopOpacity={0.6} />
        </LinearGradient>
        <LinearGradient id="weft" x1="180" y1="512" x2="844" y2="512" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#E8A87C" />
          <Stop offset="1" stopColor="#C9743C" />
        </LinearGradient>
      </Defs>
      {plate && <Rect width={1024} height={1024} rx={228} fill="url(#bg)" />}
      <G stroke="url(#warp)" strokeWidth={44} strokeLinecap="round">
        <Path d="M368 200 V824" />
        <Path d="M512 200 V824" />
        <Path d="M656 200 V824" />
      </G>
      <G stroke="url(#weft)" strokeWidth={44} strokeLinecap="round">
        <Path d="M200 344 H824" />
        <Path d="M200 512 H824" />
        <Path d="M200 680 H824" />
      </G>
      {/* the warp patched back over alternate crossings: the interlace */}
      <G stroke="url(#warp)" strokeWidth={44} strokeLinecap="butt">
        <Path d="M368 320 V368" />
        <Path d="M656 320 V368" />
        <Path d="M512 488 V536" />
        <Path d="M368 656 V704" />
        <Path d="M656 656 V704" />
      </G>
    </Svg>
  );
}

export function GoogleMark(props: { size?: number }) {
  const s = props.size ?? 18;
  return (
    <Svg width={s} height={s} viewBox="0 0 48 48">
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

/** The route the app is using to reach the daemon, live. */
export function useConnRoute(): ConnRoute {
  const [route, setRoute] = useState<ConnRoute>(connection.route);
  useEffect(() => {
    setRoute(connection.route);
    return connection.subscribe(setRoute);
  }, []);
  return route;
}

const ROUTE_LOOK: Record<ConnRoute, { label: string; color: string; hint: string }> = {
  direct: { label: "Direct", color: T.ok, hint: "talking to the daemon over your network" },
  cloud: { label: "Loom Cloud", color: T.thread, hint: "through the encrypted relay" },
  offline: { label: "Offline", color: T.err, hint: "the daemon isn't reachable" },
  checking: { label: "Checking", color: T.faint, hint: "finding the daemon" },
};

export function routeHint(route: ConnRoute): string {
  return ROUTE_LOOK[route].hint;
}

/** "● Direct" / "● Loom Cloud" / "● Offline" — a hairline pill, colour only on the dot. */
export function ConnectionBadge() {
  const route = useConnRoute();
  const look = ROUTE_LOOK[route];
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Connection: ${look.label}, ${look.hint}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderWidth: 1,
        borderColor: T.line2,
        borderRadius: radii.pill,
        paddingHorizontal: 9,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: look.color }} />
      <Text style={{ color: T.dim, fontSize: 10.5, fontFamily: T.mono, letterSpacing: 0.3 }}>{look.label}</Text>
    </View>
  );
}
