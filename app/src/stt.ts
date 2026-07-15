/**
 * Voice input — on-device speech-to-text for the composer.
 *
 * Uses expo-speech-recognition (native module, present in APK/dev builds).
 * Loaded defensively: in environments without the module (e.g. Expo Go
 * before `expo install`), the mic button simply doesn't render.
 */

import { useEffect, useRef, useState } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Speech: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Speech = require("expo-speech-recognition");
} catch {
  Speech = null;
}

function addListener(event: string, cb: (e: unknown) => void): { remove?: () => void } | null {
  try {
    if (typeof Speech?.addSpeechRecognitionListener === "function") {
      return Speech.addSpeechRecognitionListener(event, cb);
    }
    if (typeof Speech?.ExpoSpeechRecognitionModule?.addListener === "function") {
      return Speech.ExpoSpeechRecognitionModule.addListener(event, cb);
    }
  } catch {
    // fall through
  }
  return null;
}

export interface Stt {
  available: boolean;
  listening: boolean;
  /** Start/stop dictation. Resolves false if permission was denied. */
  toggle: () => Promise<boolean>;
}

/** onText fires with the growing transcript (interim + final results). */
export function useStt(onText: (transcript: string, isFinal: boolean) => void): Stt {
  const available = Boolean(Speech?.ExpoSpeechRecognitionModule);
  const [listening, setListening] = useState(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    if (!available) return;
    const subs = [
      addListener("result", (e) => {
        const ev = e as { results?: Array<{ transcript?: string }>; isFinal?: boolean };
        const transcript = ev?.results?.[0]?.transcript ?? "";
        if (transcript) onTextRef.current(transcript, Boolean(ev?.isFinal));
      }),
      addListener("end", () => setListening(false)),
      addListener("error", () => setListening(false)),
    ];
    return () => {
      for (const s of subs) s?.remove?.();
    };
  }, [available]);

  const toggle = async (): Promise<boolean> => {
    if (!available) return false;
    const mod = Speech.ExpoSpeechRecognitionModule;
    if (listening) {
      try {
        mod.stop();
      } catch {
        // already stopped
      }
      setListening(false);
      return true;
    }
    try {
      const perm = await mod.requestPermissionsAsync();
      if (!perm?.granted) return false;
      mod.start({ lang: "en-US", interimResults: true, continuous: false });
      setListening(true);
      return true;
    } catch {
      setListening(false);
      return false;
    }
  };

  return { available, listening, toggle };
}
