import { useEffect, useState } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { useShareIntent } from "expo-share-intent";
import { quickAction, sharedText, type QuickAction } from "./phone-batch-model";

export function usePhoneEntry() {
  const [action, setAction] = useState<QuickAction | null>(null);
  const [text, setText] = useState("");
  const share = useShareIntent({ disabled: Platform.OS === "web" || Constants.appOwnership === "expo", resetOnBackground: false });
  useEffect(() => {
    if (!share.hasShareIntent) return;
    const incoming = sharedText(share.shareIntent);
    if (incoming) setText(incoming);
    share.resetShareIntent();
  }, [share.hasShareIntent, share.shareIntent]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    let live = true;
    let sub: { remove: () => void } | undefined;
    // Older binaries and Expo Go may not contain this native module yet.
    void (async () => {
      const actions = require("expo-quick-actions") as typeof import("expo-quick-actions");
      if (!live) return;
      setAction(quickAction(actions.initial?.id));
      sub = actions.addListener(item => setAction(quickAction(item.id)));
      if (await actions.isSupported()) await actions.setItems([
        { id: "new-chat", title: "New chat", icon: "compose" },
        { id: "approvals", title: "Approvals", icon: "task" },
        { id: "projects", title: "Projects", icon: "home" },
      ]);
    })().catch(() => {});
    return () => { live = false; sub?.remove(); };
  }, []);
  return { action, clearAction: () => setAction(null), text, clearText: () => setText("") };
}
