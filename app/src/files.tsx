/**
 * Files on the phone (#380): the project's tree, read-only, with each file shown in a light syntax
 * colouring (code-model.ts) and line numbers. Folders the desktop's Explorer hides stay hidden.
 */

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { listFiles, readFile, type Creds, type FileEntry } from "./api";
import { tokenizeLine, type TokenKind } from "./code-model";
import { TAP } from "./components";
import { T, radii, spacing } from "./theme";

const COLOR: Record<TokenKind, string> = { plain: T.text, comment: T.faint, string: T.ok, number: T.warn, keyword: T.thread };

function Code(props: { text: string; ext: string }) {
  const rows = useMemo(() => {
    let inBlock = false;
    return props.text.split("\n").slice(0, 4000).map((l) => { const r = tokenizeLine(l, props.ext, inBlock); inBlock = r.inBlock; return r.tokens; });
  }, [props.text, props.ext]);
  const gutter = String(rows.length).length;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View>
        {rows.map((toks, i) => (
          <Text key={i} selectable style={{ fontFamily: T.mono, fontSize: 12, lineHeight: 17 }}>
            <Text style={{ color: T.faint }}>{String(i + 1).padStart(gutter, " ")}  </Text>
            {toks.map((t, j) => <Text key={j} style={{ color: COLOR[t.kind] }}>{t.text}</Text>)}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

export function FilesView(props: { creds: Creds; projectId: string }) {
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [file, setFile] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    setEntries(null); setErr(null);
    listFiles(props.creds, props.projectId, dir)
      .then((r) => { if (!gone) setEntries(r.entries); })
      .catch((e: Error) => { if (!gone) setErr(e.message); });
    return () => { gone = true; };
  }, [props.projectId, dir]);

  const open = (e: FileEntry) => {
    if (e.dir) return setDir(e.path);
    setFile({ path: e.path, content: "", truncated: false });
    readFile(props.creds, props.projectId, e.path)
      .then((r) => setFile({ path: r.path, content: r.content, truncated: r.truncated }))
      .catch((x: Error) => { setFile(null); setErr(x.message); });
  };
  const crumbs = dir === "." || dir === "" ? [] : dir.split("/");

  if (file) {
    const ext = file.path.split(".").pop() ?? "";
    return (
      <View style={{ flex: 1 }}>
        <TouchableOpacity onPress={() => setFile(null)} accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: spacing.sm, borderBottomWidth: 1, borderBottomColor: T.line }}>
          <Text style={{ color: T.dim, fontSize: 16 }}>‹</Text>
          <Text style={{ color: T.text, fontFamily: T.mono, fontSize: 12.5, flex: 1 }} numberOfLines={1}>{file.path}</Text>
        </TouchableOpacity>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.sm }}>
          {!file.content && !file.truncated ? <ActivityIndicator color={T.dim} /> : <Code text={file.content} ext={ext} />}
          {file.truncated ? <Text style={{ color: T.faint, fontSize: 12, marginTop: 8 }}>Showing the first 400 KB.</Text> : null}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 4, padding: spacing.sm, alignItems: "center" }}>
        <TouchableOpacity onPress={() => setDir(".")} accessibilityRole="button"><Text style={{ color: crumbs.length ? T.dim : T.text, fontWeight: "700" }}>project</Text></TouchableOpacity>
        {crumbs.map((c, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 4 }}>
            <Text style={{ color: T.faint }}>/</Text>
            <TouchableOpacity onPress={() => setDir(crumbs.slice(0, i + 1).join("/"))} accessibilityRole="button">
              <Text style={{ color: i === crumbs.length - 1 ? T.text : T.dim, fontWeight: i === crumbs.length - 1 ? "700" : "500" }}>{c}</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
      {err ? <Text style={{ color: T.err, padding: spacing.sm }}>{err}</Text> : entries === null ? <ActivityIndicator color={T.dim} style={{ marginTop: 20 }} /> : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.path}
          contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingBottom: spacing.lg }}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => open(item)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${item.dir ? "folder" : "file"} ${item.name}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: TAP - 6, borderBottomWidth: 1, borderBottomColor: T.line }}>
              <Text style={{ color: item.dir ? T.thread : T.faint, width: 16, textAlign: "center" }}>{item.dir ? "▸" : "·"}</Text>
              <Text style={{ color: T.text, fontSize: 14, flex: 1, fontFamily: item.dir ? undefined : T.mono }} numberOfLines={1}>{item.name}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={{ color: T.dim, padding: spacing.md }}>Empty folder.</Text>}
        />
      )}
    </View>
  );
}
