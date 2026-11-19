import { useState, type ComponentProps } from "react";
import { Modal, ScrollView, useWindowDimensions, View } from "react-native";
import { ProjectScreen } from "../screens";
import { T } from "../theme";
import { PhoneChats } from "./chats";
import { Button } from "./settings";
import { ProjectRailContext, type RailState } from "./project-rail";
import { wideLayout } from "./model";
export function PhoneProject(props: ComponentProps<typeof ProjectScreen>) {
  const wide = wideLayout(useWindowDimensions().width);
  const [list, setList] = useState(false), [rail, setRail] = useState<RailState | null>(null);
  const chats = <PhoneChats creds={props.creds} project={props.project.id} onSeen={seen => rail?.saveSeen(seen)} onOpen={c => { rail?.selectChat(c.id); rail?.selectTab("thread"); setList(false); }} />;
  return <ProjectRailContext.Provider value={setRail}><View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
    {wide ? <View style={{ width: 118, backgroundColor: T.panel, borderRightWidth: 1, borderColor: T.line }}><ScrollView>{rail?.tabs.map(t => <Button key={t.key} title={`${t.label}${rail.tab === t.key ? " ✓" : ""}`} onPress={() => rail.selectTab(t.key)} />)}<Button title="Board" onPress={props.onBack} /></ScrollView></View> : <Button title="Chats · swipe actions" onPress={() => setList(true)} />}
    {wide && <View style={{ width: 250, borderRightWidth: 1, borderColor: T.line }}>{chats}</View>}
    <View style={{ flex: 1 }}><ProjectScreen {...props} /></View>
    <Modal visible={list && !wide} animationType="slide" onRequestClose={() => setList(false)}><View style={{ flex: 1, backgroundColor: T.bg, paddingTop: 40 }}><Button title="Back to chat" onPress={() => setList(false)} />{chats}</View></Modal>
  </View></ProjectRailContext.Provider>;
}
