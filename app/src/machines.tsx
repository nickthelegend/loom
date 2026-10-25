/**
 * Computers: every Loom this phone is paired with — your desktop, your laptop, a box in the
 * cloud — live: reachable or not, how fast, and one tap to switch. Loom Cloud gives each its own
 * route, so any of them answers from any network. See machines-model.ts.
 */

import { useEffect, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import { forgetMachine, listMachines, pingDaemon, renamePairedMachine, switchMachine, type Creds } from "./api";
import { Panel, SectionLabel, TAP } from "./components";
import { credsOf, type Machine } from "./machines-model";
import { T, radii } from "./theme";

type Live = { reachable: boolean; latencyMs?: number } | "checking";

export function MachinesSection(props: { visible: boolean; onSwitch: (c: Creds | null) => void; onAdd: () => void }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});

  const reload = () => listMachines().then(({ machines: m, activeId: a }) => { setMachines(m); setActiveId(a); return m; });

  useEffect(() => {
    if (!props.visible) return;
    let gone = false;
    void reload().then((m) => {
      setLive(Object.fromEntries(m.map((x) => [x.id, "checking" as Live])));
      for (const x of m) void pingDaemon(credsOf(x) as Creds).then((r) => { if (!gone) setLive((cur) => ({ ...cur, [x.id]: r })); });
    });
    return () => { gone = true; };
  }, [props.visible]);

  const pick = async (m: Machine) => {
    if (m.id === activeId) return;
    const c = await switchMachine(m.id);
    setActiveId(m.id);
    props.onSwitch(c);
  };
  const more = (m: Machine) => {
    Alert.alert(m.name, m.url.replace(/^\w+:\/\//, ""), [
      { text: "Rename", onPress: () => Alert.prompt?.("Rename", "What do you call this computer?", (name) => { if (name) void renamePairedMachine(m.id, name).then(reload); }, "plain-text", m.name) },
      { text: "Forget on this phone", style: "destructive", onPress: () => void forgetMachine(m.id).then((next) => { void reload(); if (m.id === activeId) props.onSwitch(next); }) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <View style={{ gap: 6 }}>
      <SectionLabel text={machines.length > 1 ? `Computers · ${machines.length}` : "Computers"} />
      <Panel>
        {machines.map((m) => {
          const l = live[m.id];
          const on = m.id === activeId;
          const dot = l === "checking" || !l ? T.dim : l.reachable ? T.ok : T.err;
          const where = m.relay ? "anywhere · Loom Cloud" : m.url.replace(/^\w+:\/\//, "").replace(/:\d+$/, "");
          return (
            <TouchableOpacity
              key={m.id}
              onPress={() => void pick(m)}
              onLongPress={() => more(m)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${m.name}${on ? ", in use" : ""}`}
              accessibilityHint="Switch to this computer. Long-press to rename or forget it."
              style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: TAP, paddingVertical: 4 }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: T.text, fontSize: 14, fontWeight: on ? "700" : "600" }} numberOfLines={1}>{m.name}</Text>
                <Text style={{ color: T.dim, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                  {l === "checking" || !l ? "checking…" : l.reachable ? `${where} · ${l.latencyMs ?? "?"} ms` : `${where} · not answering`}
                </Text>
              </View>
              {on ? <Text style={{ color: T.ok, fontSize: 12, fontWeight: "700" }}>In use</Text>
                : <Text style={{ color: T.dim, fontSize: 12 }}>Switch</Text>}
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          onPress={props.onAdd}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={{ minHeight: TAP, borderRadius: radii.key, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center", marginTop: machines.length ? 4 : 0 }}
        >
          <Text style={{ color: T.text, fontSize: 13.5, fontWeight: "600" }}>{machines.length ? "Pair another computer" : "Pair a computer"}</Text>
        </TouchableOpacity>
        <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
          Each computer runs its own Loom. With Loom Cloud on, each one answers from any network.
        </Text>
      </Panel>
    </View>
  );
}
