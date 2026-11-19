import { Feedback } from "./phone-lock-model";
import { kv } from "./api";
export const HAPTICS_KEY = "loom.haptics";
export const LOCK_KEY = "loom.biometricLock";
export const feedback = new Feedback(async () => await kv.get(HAPTICS_KEY) !== "off", on => kv.set(HAPTICS_KEY, on ? "on" : "off"));
export const hapticsEnabled = () => feedback.enabled;
export const loadHaptics = () => feedback.hydrate();
export const setHaptics = (on: boolean) => feedback.choose(on);
