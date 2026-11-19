import { useEffect, useState } from "react";
import { Platform, ScrollView, Switch, TextInput, TouchableOpacity, View } from "react-native";
import * as Notifications from "expo-notifications";
import { api, type Creds } from "../api";
import { T } from "../theme";
import { morning, localQuiet } from "./model";
import { Text, savePreferences, usePhonePreferences } from "./preferences";
export interface Quiet { enabled: boolean; start: string; end: string; timeZone: string; allowApprovals: boolean; snoozeUntil: number }
export function Button({ title, onPress }: { title: string; onPress: () => void }) { return <TouchableOpacity accessibilityRole="button" onPress={onPress} style={{ padding: 12, minHeight: 44 }}><Text style={{ color: T.thread }}>{title}</Text></TouchableOpacity>; }
export function PhoneSettings({ creds }: { creds: Creds }) {
  const prefs = usePhonePreferences(), [quiet, setQuiet] = useState<Quiet | null>(null), [error, setError] = useState(""), [time, setTime] = useState(prefs.briefTime ?? "07:00");
  useEffect(() => { let live = true; void api<{ quiet: Quiet }>(creds, "/api/push/quiet").then(r => { if (live) setQuiet(localQuiet(r.quiet)); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [creds]);
  const saveQuiet = async (q: Quiet) => { try { const r = await api<{ quiet: Quiet }>(creds, "/api/push/quiet", { method: "PUT", body: JSON.stringify(q) }); setQuiet(r.quiet); setError(""); } catch (e) { setError(String(e)); } };
  const save = (p: Parameters<typeof savePreferences>[0]) => void savePreferences(p).catch(e => setError(String(e)));
  const schedule = async (enabled: boolean) => {
    try {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Use HH:MM for the morning brief");
      if (Platform.OS === "web") throw new Error("Local reminders are available in the phone app");
      if (enabled && !(await Notifications.requestPermissionsAsync()).granted) throw new Error("Allow notifications in your phone settings");
      await Notifications.cancelScheduledNotificationAsync("loom-morning-brief");
      if (enabled) { const [hour, minute] = time.split(":").map(Number); await Notifications.scheduleNotificationAsync({ identifier: "loom-morning-brief", content: { title: "Your Loom morning brief", body: "See yesterday’s turns, spend and PRs waiting on the Board.", data: { screen: "phone-brief" } }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: hour!, minute: minute! } }); }
      await savePreferences({ briefTime: enabled ? time : null }); setError("");
    } catch (e) { setError(String(e)); }
  };
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
    <Text style={{ color: T.text, fontSize: 20 }}>Phone preferences</Text><Text style={{ color: T.err }}>{error}</Text>
    {quiet && <View style={{ gap: 8 }}><Text style={{ color: T.text }}>Quiet hours for your phones on this computer</Text><Switch accessibilityLabel="Nightly quiet hours" value={quiet.enabled} onValueChange={enabled => void saveQuiet({ ...quiet, enabled })} />
      {(["start", "end", "timeZone"] as const).map(key => <TextInput key={key} accessibilityLabel={`Quiet ${key}`} value={quiet[key]} onChangeText={v => setQuiet({ ...quiet, [key]: v })} style={{ color: T.text, padding: 12, borderWidth: 1, borderColor: T.line }} />)}
      <Button title="Use phone timezone" onPress={() => setQuiet({ ...quiet, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })} />
      <Button title="Save quiet hours" onPress={() => void saveQuiet(quiet)} /><Text style={{ color: T.text }}>Hold approvals too (shown in Now until answered or timed out)</Text><Switch accessibilityLabel="Hold approvals too" value={!quiet.allowApprovals} onValueChange={hold => void saveQuiet({ ...quiet, allowApprovals: !hold })} />
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}><Button title="Snooze 1h" onPress={() => void saveQuiet({ ...quiet, snoozeUntil: Date.now() + 3600000 })} /><Button title="Until morning" onPress={() => void saveQuiet({ ...quiet, snoozeUntil: morning() })} /><Button title="End snooze" onPress={() => void saveQuiet({ ...quiet, snoozeUntil: 0 })} /></View>
      {quiet.snoozeUntil > Date.now() && <Text style={{ color: T.dim }}>Snoozed until {new Date(quiet.snoozeUntil).toLocaleString()}</Text>}
    </View>}
    <Text style={{ color: T.text }}>Text size</Text><View style={{ flexDirection: "row", flexWrap: "wrap" }}>{[0.85, 1, 1.15, 1.3, 1.5].map(textScale => <Button key={textScale} title={`${Math.round(textScale * 100)}%${prefs.textScale === textScale ? " ✓" : ""}`} onPress={() => save({ textScale })} />)}</View>
    <Text style={{ color: T.text }}>High contrast</Text><Switch accessibilityLabel="High contrast" value={prefs.highContrast} onValueChange={highContrast => save({ highContrast })} />
    <Text style={{ color: T.text }}>Morning brief reminder (phone time)</Text><TextInput accessibilityLabel="Morning brief time" value={time} onChangeText={setTime} style={{ padding: 12, color: T.text, borderColor: T.line, borderWidth: 1 }} />
    <Button title={prefs.briefTime ? `Update reminder (${prefs.briefTime})` : "Enable reminder"} onPress={() => void schedule(true)} />{prefs.briefTime && <Button title="Disable reminder" onPress={() => void schedule(false)} />}
  </ScrollView>;
}
