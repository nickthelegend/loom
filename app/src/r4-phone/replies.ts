import { backgroundMachines } from "./push-state";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { kv, listMachines, type Creds } from "../api";
import { credsOf } from "../machines-model";
import { registerPush } from "../push";
import { outbox } from "../outbox";
import { notificationReply, notificationMachine, rotateReply, type ReplyAction } from "./model";

const errorListeners = new Set<() => void>();
export const lastReplyError = {
  value: "",
  set(value: string) { this.value = value; for (const listener of errorListeners) listener(); },
  subscribe(listener: () => void) { errorListeners.add(listener); return () => { errorListeners.delete(listener); }; },
  getSnapshot: () => lastReplyError.value,
};
export const useLastReplyError = () => useSyncExternalStore(lastReplyError.subscribe, lastReplyError.getSnapshot);

export function useNotificationReplies(ready: boolean, locked: boolean) {
  const [pending, setPending] = useState<ReplyAction[]>([]);
  const allowed = useRef(false); allowed.current = ready && !locked;
  useEffect(() => {
    if (ready && !locked) void listMachines().then(({ machines, activeId }) => Promise.all(backgroundMachines(machines, activeId).map(m => registerPush(credsOf(m) as Creds)))).catch(() => {});
  }, [ready, locked]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    void Notifications.setNotificationCategoryAsync("loom-reply", [{ identifier: "reply", buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Reply to this chat" }, options: { opensAppToForeground: true, isAuthenticationRequired: true } }]).catch(() => {});
    const seen = new Set<string>();
    const receive = (r: Notifications.NotificationResponse | null) => {
      if (!r || r.actionIdentifier !== "reply" || !r.userText?.trim()) return;
      const id = r.notification.request.identifier;
      if (seen.has(id)) return; seen.add(id);
      setPending(p => [...p, { id, text: r.userText!, data: r.notification.request.content.data }]);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(receive);
    void Notifications.getLastNotificationResponseAsync().then(receive).catch(() => {});
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!allowed.current || !pending.length) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const later = () => { retry = setTimeout(() => { if (live) setPending(rotateReply); }, 4000); };
    void (async () => {
      const action = pending[0]!;
      const { machines } = await listMachines();
      const identities = await Promise.all(machines.map(async m => ({ m, id: await kv.get("loom.push-client." + m.token) })));
      const machine = notificationMachine(identities, action.data);
      if (!live || !allowed.current) return;
      if (!machine) {
        lastReplyError.set("Couldn't match this reply to a paired computer: " + action.text.slice(0, 80));
        later(); return;
      }
      // The resolver validated this pairing, including the unique-name upgrade fallback.
      const id = String(action.data.clientId ?? machine.token);
      const item = notificationReply({ ...action, data: { ...action.data, clientId: id } }, id);
      if (!item) throw new Error("Unsupported notification reply");
      const q = await outbox(credsOf(machine) as Creds);
      if (!live || !allowed.current) return;
      item.id = "notification-" + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, id + ":" + action.id);
      if (!live || !allowed.current) return;
      if (!q.items.some(i => i.id === item.id)) await q.add(item);
      await q.flush(() => live && allowed.current && AppState.currentState === "active");
      if (live) {
        lastReplyError.set("");
        setPending(p => p.slice(1));
        void Notifications.clearLastNotificationResponseAsync().catch(() => {});
      }
    })().catch(e => { if (live) { lastReplyError.set("Reply saved for retry: " + String(e)); later(); } });
    return () => { live = false; clearTimeout(retry); };
  }, [pending, ready, locked]);
  // Replies to a non-active computer need the same reconnect retries as the
  // selected computer. Each queue retains its own credentials and receipts.
  useEffect(() => {
    if (!ready || locked) return;
    let live = true;
    const flush = () => { if (AppState.currentState !== "active") return; void listMachines().then(({ machines }) => Promise.all(machines.map(async m => {
      const q = await outbox(credsOf(m) as Creds); await q.flush(() => live && allowed.current && AppState.currentState === "active");
    }))).catch(() => {}); };
    flush(); const timer = setInterval(flush, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [ready, locked]);
}
