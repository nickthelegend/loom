/**
 * Charts drawn out of plain Views.
 *
 * The app has no `react-native-svg` and this is not the place to add a charting
 * dependency — a phone panel that shows six numbers does not justify shipping a
 * renderer. So: proportional stacked bars for composition, and a real polyline
 * built from rotated 1.5pt segments for the duration series. Both read the same
 * data the Observatory reads, and neither has a decorative mode — an empty
 * series renders an empty state, never a placeholder curve.
 */

import { useState } from "react";
import { Text, View } from "react-native";
import { Empty } from "./components";
import { T, hue, radii } from "./theme";

export interface Slice {
  key: string;
  value: number;
  /** Shown in the legend instead of the raw value, e.g. "12.4k" or "$3.64". */
  display: string;
}

/**
 * Composition as one proportional bar plus a legend — the honest phone-sized
 * substitute for a donut. Each agent keeps the same hue it wears everywhere
 * else in the app, so the bar and the fleet list agree without a key.
 */
export function StackedBar(props: { title: string; total: string; slices: Slice[]; emptyText: string }) {
  const real = props.slices.filter((s) => s.value > 0);
  const sum = real.reduce((a, s) => a + s.value, 0);

  if (!sum) {
    return (
      <View style={{ gap: 8 }}>
        <ChartHead title={props.title} value="—" />
        <Empty text={props.emptyText} />
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <ChartHead title={props.title} value={props.total} />
      <View
        style={{
          flexDirection: "row",
          height: 14,
          borderRadius: radii.pill,
          overflow: "hidden",
          backgroundColor: T.raised,
        }}
      >
        {real.map((s) => (
          <View key={s.key} style={{ flex: s.value, backgroundColor: hue(s.key) }} />
        ))}
      </View>
      <View style={{ gap: 4 }}>
        {real
          .slice()
          .sort((a, b) => b.value - a.value)
          .map((s) => (
            <View key={s.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: hue(s.key) }} />
              <Text style={{ color: T.dim, fontSize: 11.5, flex: 1 }} numberOfLines={1}>
                {s.key}
              </Text>
              <Text style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>
                {Math.round((s.value / sum) * 100)}%
              </Text>
              <Text style={{ color: T.text, fontSize: 11.5, fontFamily: T.mono, minWidth: 52, textAlign: "right" }}>
                {s.display}
              </Text>
            </View>
          ))}
      </View>
    </View>
  );
}

function ChartHead(props: { title: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text
        style={{
          color: T.faint,
          fontSize: 10,
          fontFamily: T.mono,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          flex: 1,
        }}
        numberOfLines={1}
      >
        {props.title}
      </Text>
      <Text style={{ color: T.text, fontSize: 12, fontFamily: T.mono }}>{props.value}</Text>
    </View>
  );
}

export interface LinePoint {
  ts: number;
  value: number;
  /** Whatever the point is about — the agent that ran the turn. Colours the dot. */
  tag?: string;
}

/**
 * A polyline over a series, drawn as rotated segments.
 *
 * Each segment is a thin View placed centred on the midpoint of the pair it
 * joins and rotated to its angle — rotating about the default centre origin
 * avoids depending on `transformOrigin`, which is newer than the RN floor this
 * app targets.
 *
 * x is the point's ORDER, not its timestamp: a run spanning three days would
 * otherwise pile forty turns into one pixel and call it a chart. The axis says
 * so, and the span is printed underneath.
 */
export function LineChart(props: {
  title: string;
  points: LinePoint[];
  height?: number;
  format: (v: number) => string;
  emptyText: string;
  color?: string;
}) {
  const [w, setW] = useState(0);
  const h = props.height ?? 104;
  const pts = props.points;
  const color = props.color ?? T.thread;

  if (pts.length < 2) {
    return (
      <View style={{ gap: 8 }}>
        <ChartHead title={props.title} value={pts.length === 1 ? props.format(pts[0]!.value) : "—"} />
        <Empty text={props.emptyText} />
      </View>
    );
  }

  const values = pts.map((p) => p.value);
  const max = Math.max(...values);
  // Floor the baseline at zero: a duration chart whose y-axis starts at 8s makes
  // a 9s turn look like a spike, which is a shape the data does not have.
  const min = 0;
  const span = max - min || 1;
  const PAD = 8;
  const innerW = Math.max(0, w - PAD * 2);
  const innerH = h - PAD * 2;
  const x = (i: number) => PAD + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const y = (v: number) => PAD + (1 - (v - min) / span) * innerH;

  const avg = values.reduce((a, v) => a + v, 0) / values.length;
  const first = pts[0]!.ts;
  const last = pts[pts.length - 1]!.ts;
  const showDots = pts.length <= 48;

  return (
    <View style={{ gap: 8 }}>
      <ChartHead title={props.title} value={`peak ${props.format(max)}`} />
      <View
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        style={{
          height: h,
          backgroundColor: T.editor,
          borderWidth: 1,
          borderColor: T.line,
          borderRadius: radii.row,
          overflow: "hidden",
        }}
      >
        {/* the mean, so a reader can see which turns ran long without arithmetic */}
        {w > 0 && (
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: y(avg),
              height: 1,
              backgroundColor: T.line2,
            }}
          />
        )}
        {w > 0 &&
          pts.slice(0, -1).map((p, i) => {
            const x1 = x(i);
            const y1 = y(p.value);
            const x2 = x(i + 1);
            const y2 = y(pts[i + 1]!.value);
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.hypot(dx, dy);
            return (
              <View
                key={i}
                style={{
                  position: "absolute",
                  left: (x1 + x2) / 2 - len / 2,
                  top: (y1 + y2) / 2 - 0.75,
                  width: len,
                  height: 1.5,
                  backgroundColor: color,
                  transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
                }}
              />
            );
          })}
        {w > 0 &&
          showDots &&
          pts.map((p, i) => (
            <View
              key={`d${i}`}
              style={{
                position: "absolute",
                left: x(i) - 2.5,
                top: y(p.value) - 2.5,
                width: 5,
                height: 5,
                borderRadius: 2.5,
                backgroundColor: p.tag ? hue(p.tag) : color,
              }}
            />
          ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, flex: 1 }} numberOfLines={1}>
          {pts.length} turns · oldest → newest
        </Text>
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }}>mean {props.format(avg)}</Text>
      </View>
      <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }} numberOfLines={1}>
        {new Date(first).toLocaleString()} → {new Date(last).toLocaleString()}
      </Text>
    </View>
  );
}

const GRADE_COLOR: Record<string, string> = {
  healthy: T.ok,
  degraded: T.warn,
  unhealthy: T.err,
};

export function gradeColor(grade?: string): string {
  return GRADE_COLOR[grade ?? ""] ?? T.dim;
}

/** A 0–100 meter. Used for health, and for confidence when one was measured. */
export function Meter(props: { value: number; max?: number; tint: string; height?: number }) {
  const max = props.max ?? 100;
  const pct = Math.max(0, Math.min(1, props.value / max));
  return (
    <View
      style={{
        height: props.height ?? 6,
        backgroundColor: T.raised,
        borderRadius: radii.pill,
        overflow: "hidden",
      }}
    >
      <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: props.tint }} />
    </View>
  );
}

/**
 * A ranked list of routes/agents as proportional bars. The count is the point —
 * a path the baton walked twelve times and one walked once are not the same
 * fact, and thickness is the only way to say that without a graph engine.
 */
export function RankedBars(props: {
  rows: Array<{ key: string; label: string; n: number; highlight?: boolean; sub?: string }>;
  unit: string;
}) {
  const max = props.rows.reduce((m, r) => Math.max(m, r.n), 1);
  return (
    <View style={{ gap: 10 }}>
      {props.rows.map((r) => (
        <View key={r.key} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              style={{ color: r.highlight ? T.shuttle : T.text, fontSize: 12.5, flex: 1, fontFamily: T.mono }}
              numberOfLines={1}
            >
              {r.label}
            </Text>
            <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono }}>
              ×{r.n} {props.unit}
            </Text>
          </View>
          <View style={{ height: 6, backgroundColor: T.raised, borderRadius: radii.pill, overflow: "hidden" }}>
            <View
              style={{
                width: `${(r.n / max) * 100}%`,
                height: "100%",
                backgroundColor: r.highlight ? T.shuttle : T.primary,
                opacity: r.highlight ? 1 : 0.65,
              }}
            />
          </View>
          {r.sub ? (
            <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono }} numberOfLines={1}>
              {r.sub}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
