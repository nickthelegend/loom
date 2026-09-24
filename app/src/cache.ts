/**
 * The phone's offline copy (see cache-model.ts for what's kept). Files in the
 * app's document directory on a device; localStorage in the browser demo.
 * Every call swallows its own errors: a cache that can't be written is a
 * cache that's empty, never a crash.
 */

import * as FileSystem from "expo-file-system";
import { Platform } from "react-native";
import { parseCached, scopeOf, threadKey, touch, trimEvents, type Cached } from "./cache-model";

const DIR = Platform.OS === "web" ? "" : `${FileSystem.documentDirectory ?? ""}loom-cache/`;
const INDEX = "threads-index";
const scoped = (daemonUrl: string, name: string) => `${scopeOf(daemonUrl)}-${name}`;

async function read(name: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return globalThis.localStorage?.getItem(`loomCache:${name}`) ?? null;
    const path = `${DIR}${name}.json`;
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? await FileSystem.readAsStringAsync(path) : null;
  } catch {
    return null;
  }
}

async function write(name: string, body: string): Promise<void> {
  try {
    if (Platform.OS === "web") return void globalThis.localStorage?.setItem(`loomCache:${name}`, body);
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(`${DIR}${name}.json`, body);
  } catch {
    /* best effort */
  }
}

async function remove(name: string): Promise<void> {
  try {
    if (Platform.OS === "web") return void globalThis.localStorage?.removeItem(`loomCache:${name}`);
    await FileSystem.deleteAsync(`${DIR}${name}.json`, { idempotent: true });
  } catch {
    /* best effort */
  }
}

export async function loadProjects<T>(daemonUrl: string): Promise<Cached<T[]> | null> {
  return parseCached<T[]>(await read(scoped(daemonUrl, "projects")));
}

export async function saveProjects<T>(daemonUrl: string, projects: T[]): Promise<void> {
  await write(scoped(daemonUrl, "projects"), JSON.stringify({ at: Date.now(), data: projects }));
}

export async function loadThread<E>(daemonUrl: string, projectId: string, chatId: string): Promise<Cached<E[]> | null> {
  return parseCached<E[]>(await read(scoped(daemonUrl, threadKey(projectId, chatId))));
}

export async function saveThread<E>(daemonUrl: string, projectId: string, chatId: string, events: E[]): Promise<void> {
  const key = scoped(daemonUrl, threadKey(projectId, chatId));
  await write(key, JSON.stringify({ at: Date.now(), data: trimEvents(events) }));
  const idx = parseCached<string[]>(await read(INDEX))?.data ?? [];
  const next = touch(idx, key);
  await write(INDEX, JSON.stringify({ at: Date.now(), data: next.index }));
  for (const k of next.evict) await remove(k);
}

/** Forget everything: unpairing shouldn't leave the old daemon's threads on the phone. */
export async function clearCache(): Promise<void> {
  try {
    if (Platform.OS === "web") {
      for (const k of Object.keys(globalThis.localStorage ?? {})) if (k.startsWith("loomCache:")) globalThis.localStorage.removeItem(k);
      return;
    }
    await FileSystem.deleteAsync(DIR, { idempotent: true });
  } catch {
    /* best effort */
  }
}
