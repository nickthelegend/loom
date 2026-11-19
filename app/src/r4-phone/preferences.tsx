import { createContext, useContext, useEffect, useState } from "react";
import { Text as NativeText, StyleSheet, type TextProps } from "react-native";
import { kv } from "../api";
import { defaults, parsePreferences, textScaleStyle, type PhonePreferences } from "./model";
const key = "loom.phone-r4";
let value = defaults;
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
export function usePhonePreferences() {
  const [, render] = useState(0);
  useEffect(() => {
    const fn = () => render(n => n + 1); listeners.add(fn);
    loaded ??= kv.get(key).then(raw => { value = parsePreferences(raw); for (const f of listeners) f(); });
    void loaded.catch(() => {});
    return () => { listeners.delete(fn); };
  }, []);
  return value;
}
let writes: Promise<void> = Promise.resolve();
export function savePreferences(patch: Partial<PhonePreferences>) {
  const next = writes.then(async () => {
    await loaded;
    const saved = parsePreferences(JSON.stringify({ ...value, ...patch }));
    await kv.set(key, JSON.stringify(saved)); value = saved; for (const f of listeners) f();
  });
  writes = next.catch(() => {}); return next;
}
const Nested = createContext(false);
export function Text({ style, children, ...props }: TextProps) {
  const p = usePhonePreferences(), flat = StyleSheet.flatten(style) ?? {};
  const nested = useContext(Nested);
  return <NativeText {...props} style={[style, textScaleStyle(flat, p.textScale, nested)]}><Nested.Provider value={true}>{children}</Nested.Provider></NativeText>;
}
