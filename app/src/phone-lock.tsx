import { PhoneLock, type LockState } from "./phone-lock-model";
import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useRef, useState } from "react";
import { AppState, Modal, Platform, Text, TouchableOpacity, View } from "react-native";
import { kv } from "./api";
import { LOCK_KEY } from "./phone-preferences";
import { T } from "./theme";

export function usePhoneLock() {
  const [state, setState] = useState<LockState>({ ready: false, enabled: false, locked: true, error: "" });
  const model = useRef<PhoneLock | null>(null);
  if (!model.current) model.current = new PhoneLock(
    async () => Platform.OS !== "web" && await kv.get(LOCK_KEY) === "on",
    on => kv.set(LOCK_KEY, on ? "on" : "off"),
    async () => Platform.OS !== "web" && await LocalAuthentication.hasHardwareAsync() && await LocalAuthentication.isEnrolledAsync(),
    async () => (await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Loom", disableDeviceFallback: true, cancelLabel: "Cancel" })).success,
    setState,
  );
  useEffect(() => {
    const lock = model.current!;
    void lock.start();
    const sub = AppState.addEventListener("change", state => lock.activity(state));
    return () => sub.remove();
  }, []);
  return { ...state, toggle: (on: boolean) => model.current!.toggle(on), unlock: () => model.current!.unlock() };
}
export function LockScreen(props: { visible: boolean; error: string; onUnlock: () => void }) {
  return <Modal visible={props.visible} animationType="none" onRequestClose={() => {}}>
    <View style={{ flex: 1, backgroundColor: T.bg, justifyContent: "center", alignItems: "center", padding: 24, gap: 16 }}>
      <Text style={{ color: T.text, fontSize: 24 }}>Loom is locked</Text>
      <Text style={{ color: T.dim }}>{props.error}</Text>
      <TouchableOpacity accessibilityRole="button" onPress={props.onUnlock} style={{ padding: 16 }}><Text style={{ color: T.thread }}>Unlock with biometrics</Text></TouchableOpacity>
    </View>
  </Modal>;
}
