import * as FileSystem from "expo-file-system";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { api, kv, type Creds } from "./api";
import { Outbox } from "./phone-batch-model";

const boxes = new Map<string, Promise<Outbox>>();
export function outbox(creds: Creds): Promise<Outbox> {
  const scope = `${creds.url}\0${creds.token}`;
  let box = boxes.get(scope);
  if (!box) {
    box = (async () => {
      const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
      const key = `loom-outbox-${hash}`;
      let savedFile: string | null = null;
      const q = new Outbox(async () => {
        if (Platform.OS === "web") return localStorage.getItem(key);
        savedFile = await kv.get(key);
        return savedFile ? FileSystem.readAsStringAsync(`${FileSystem.documentDirectory}${savedFile}`) : null;
      }, async value => {
        if (Platform.OS === "web") { localStorage.setItem(key, value); return; }
        const next = `${key}-${Crypto.randomUUID()}.json`;
        await FileSystem.writeAsStringAsync(`${FileSystem.documentDirectory}${next}`, value);
        // Only point at a complete snapshot; an interrupted write leaves the old queue intact.
        await kv.set(key, next);
        const previous = savedFile; savedFile = next;
        if (previous) void FileSystem.deleteAsync(`${FileSystem.documentDirectory}${previous}`, { idempotent: true }).catch(() => {});
      }, item => api(creds, `/api/projects/${item.project}/messages`, {
        method: "POST",
        body: JSON.stringify({ deliveryId: item.id, handoff: true, text: item.text, chat: item.chat,
          ...(item.agentId ? { agentId: item.agentId } : {}), ...(item.plan ? { plan: true } : {}) }),
      }, 15_000));
      await q.load(); return q;
    })();
    boxes.set(scope, box);
    void box.catch(() => boxes.delete(scope));
  }
  return box;
}
