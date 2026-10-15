/**
 * Brand marks and the connection badge.
 *
 * LoomMark is assets/icon.svg drawn live (the weave: three warp threads, three
 * weft threads, interlaced) so it stays crisp at any size and can sit on the
 * welcome screen without a bitmap. GitHubMark matches the hosted account provider.
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

export function GitHubMark(props: { size?: number }) {
  const size = props.size ?? 18;
  return <Svg width={size} height={size} viewBox="0 0 16 16"><Path fill={T.onBright} d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></Svg>;
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
