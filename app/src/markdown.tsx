/** An agent's reply on a phone: the blocks markdown-model.ts parses, drawn. */

import { Linking, ScrollView, Text, View } from "react-native";
import { type Block, type Inline, parse } from "./markdown-model";
import { T, radii } from "./theme";

const PLAN_VERB: Record<string, string> = {
  spawn: "Start",
  send: "Tell",
  cancel: "Stop",
  ask: "Ask you",
  done: "Done",
};

function Inl(props: { parts: Inline[]; size?: number }) {
  const size = props.size ?? 14;
  return (
    <>
      {props.parts.map((p, i) => {
        if (p.t === "bold") return <Text key={i} style={{ fontWeight: "700", color: T.text }}>{p.s}</Text>;
        if (p.t === "italic") return <Text key={i} style={{ fontStyle: "italic" }}>{p.s}</Text>;
        if (p.t === "code")
          return (
            <Text key={i} style={{ fontFamily: T.mono, fontSize: size - 1.5, color: T.thread, backgroundColor: T.raised }}>
              {` ${p.s} `}
            </Text>
          );
        if (p.t === "link")
          return (
            <Text
              key={i}
              style={{ color: T.accentBlue, textDecorationLine: "underline" }}
              onPress={() => {
                if (/^https?:\/\//.test(p.href)) void Linking.openURL(p.href);
              }}
            >
              {p.s}
            </Text>
          );
        return <Text key={i}>{p.s}</Text>;
      })}
    </>
  );
}

function BlockView(props: { b: Block }) {
  const { b } = props;
  const body = { color: T.text, fontSize: 14, lineHeight: 21 } as const;
  if (b.t === "p") return <Text style={body}><Inl parts={b.inl} /></Text>;
  if (b.t === "h")
    return (
      <Text style={{ ...body, fontSize: b.level <= 2 ? 16 : 15, fontWeight: "700", marginTop: 2 }}>
        <Inl parts={b.inl} size={b.level <= 2 ? 16 : 15} />
      </Text>
    );
  if (b.t === "li")
    return (
      <View style={{ flexDirection: "row", paddingLeft: b.depth * 14, gap: 7 }}>
        <Text style={{ ...body, color: T.dim, minWidth: b.ordered ? 18 : 8 }}>{b.ordered ? `${b.n}.` : "•"}</Text>
        <Text style={{ ...body, flexShrink: 1 }}><Inl parts={b.inl} /></Text>
      </View>
    );
  if (b.t === "quote")
    return (
      <View style={{ borderLeftWidth: 2, borderLeftColor: T.line, paddingLeft: 10 }}>
        <Text style={{ ...body, color: T.dim }}><Inl parts={b.inl} /></Text>
      </View>
    );
  if (b.t === "hr") return <View style={{ height: 1, backgroundColor: T.line, marginVertical: 4 }} />;
  if (b.t === "plan")
    return (
      <View style={{ borderWidth: 1, borderColor: T.line, borderRadius: radii.row, padding: 10, gap: 6, backgroundColor: T.raised }}>
        <Text style={{ color: T.dim, fontSize: 11, fontFamily: T.mono, letterSpacing: 0.4 }}>
          {b.actions.length ? "PLAN" : "PLAN · no tasks this round — still looking"}
        </Text>
        {b.actions.map((a, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ color: a.type === "done" ? T.gitAdd : T.thread, fontSize: 12, fontWeight: "700", minWidth: 52 }}>
              {PLAN_VERB[a.type] ?? a.type}
            </Text>
            <Text style={{ color: T.text, fontSize: 13, lineHeight: 19, flexShrink: 1 }}>{a.text}</Text>
          </View>
        ))}
      </View>
    );
  // code
  return (
    <View style={{ backgroundColor: T.editor, borderRadius: radii.row, borderWidth: 1, borderColor: T.line, overflow: "hidden" }}>
      {!!b.lang && (
        <Text style={{ color: T.faint, fontSize: 10, fontFamily: T.mono, paddingHorizontal: 10, paddingTop: 6 }}>{b.lang}</Text>
      )}
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <Text style={{ color: T.text, fontFamily: T.mono, fontSize: 12, lineHeight: 18, padding: 10 }}>{b.s}</Text>
      </ScrollView>
    </View>
  );
}

export function Markdown(props: { text: string }) {
  const blocks = parse(props.text);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </View>
  );
}
