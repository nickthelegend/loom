/**
 * Git delivery — what happens to finished work, as one setting. A compact chip
 * in the project header; the sheet explains each choice in a line.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { getProjectConfig, setGitDelivery, type Creds, type GitDelivery } from "./api";
import { TAP } from "./components";
import { Sheet } from "./observatory";
import { T, radii } from "./theme";

const OPTIONS: ReadonlyArray<{ key: GitDelivery; label: string; short: string; sub: string }> = [
  { key: "push", label: "Commit & push", short: "push", sub: "Each turn is committed and pushed; a finished orchestra merges into your branch and pushes." },
  { key: "pr", label: "Commit & open PR", short: "PR", sub: "Each turn is committed; a finished orchestra pushes its own branch and opens a pull request." },
  { key: "commit", label: "Commit only", short: "commit", sub: "Each turn is committed locally; a finished orchestra merges into your branch. Nothing is pushed." },
  { key: "none", label: "No commit", short: "no commit", sub: "Nothing is committed for you; orchestra work waits on its own branch until you apply it." },
];

export function DeliveryChip(props: { creds: Creds; projectId: string }) {
  const [mode, setMode] = useState<GitDelivery | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<GitDelivery | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getProjectConfig(props.creds, props.projectId)
      .then((c) => live && setMode(c.git?.delivery ?? "none"))
      .catch(() => {}); // an older daemon: the chip just doesn't show
    return () => {
      live = false;
    };
  }, [props.creds, props.projectId]);

  if (!mode) return null;
  const current = OPTIONS.find((o) => o.key === mode) ?? OPTIONS[3]!;

  const pick = async (key: GitDelivery) => {
    if (key === mode || busy) return setOpen(false);
    setErr(null);
    setBusy(key);
    try {
      const c = await setGitDelivery(props.creds, props.projectId, key);
      setMode(c.git?.delivery ?? key);
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
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Git delivery: ${current.label}. Change`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          minHeight: 28,
          paddingHorizontal: 8,
          borderRadius: radii.pill,
          borderWidth: 1,
          borderColor: T.line2,
        }}
      >
        <Text style={{ color: mode === "none" ? T.faint : T.dim, fontSize: 11, fontFamily: T.mono }}>
          ⑂ {current.short}
        </Text>
      </TouchableOpacity>

      <Sheet title="When work is finished" visible={open} onClose={() => setOpen(false)}>
        {OPTIONS.map((o) => {
          const on = o.key === mode;
          return (
            <TouchableOpacity
              key={o.key}
              onPress={() => void pick(o.key)}
              disabled={!!busy}
              activeOpacity={0.7}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: on }}
              style={{
                gap: 3,
                minHeight: TAP + 8,
                paddingVertical: 11,
                paddingHorizontal: 12,
                borderRadius: radii.card,
                borderWidth: 1,
                borderColor: on ? T.line2 : T.line,
                backgroundColor: on ? T.raised : T.panel,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: T.text, fontSize: 14.5, fontWeight: "600", flex: 1 }}>{o.label}</Text>
                {busy === o.key ? <ActivityIndicator size="small" color={T.dim} /> : null}
                {on ? <Text style={{ color: T.text, fontSize: 15, fontWeight: "700" }}>✓</Text> : null}
              </View>
              <Text style={{ color: T.dim, fontSize: 12.5, lineHeight: 18 }}>{o.sub}</Text>
            </TouchableOpacity>
          );
        })}
        {err ? <Text style={{ color: T.err, fontSize: 13 }}>{err}</Text> : null}
      </Sheet>
    </>
  );
}
