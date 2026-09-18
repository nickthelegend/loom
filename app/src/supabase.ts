/**
 * Loom accounts: sign in with Google through Supabase Auth, plus the one piece
 * of analytics the app sends — a country-only "the app was opened today".
 *
 * An account is optional. Everything Loom does over the LAN, the tailnet or
 * Loom Cloud works signed out; signing in only turns on the cloud features. So
 * every export here is a quiet no-op when the build has no Supabase config.
 *
 * Config comes from EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY,
 * inlined at bundle time (see app/.env.example).
 */

import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import Constants from "expo-constants";
import { makeRedirectUri } from "expo-auth-session";
import * as ExpoCrypto from "expo-crypto";
import { getLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { kv } from "./api";

// Must be `process.env.EXPO_PUBLIC_…` literally — Expo inlines only that form.
const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? "").trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

/** False in a build without Supabase env: the Google button explains itself instead. */
export const supabaseConfigured = /^https:\/\/\S+$/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;

// On web the OAuth popup lands back on this bundle; this closes it and hands the
// result to the opener. A no-op on native.
WebBrowser.maybeCompleteAuthSession();

// ---------------------------------------------------------------------------
// Session storage: the keychain, chunked
// ---------------------------------------------------------------------------

/**
 * A Supabase session (two JWTs + the user) runs 3–4 KB; SecureStore warns past
 * 2 KB and some Android keystores refuse it. So values are split into ≤1800-char
 * chunks: `<key>.n` holds the count, `<key>.0…` the pieces. Web has no keychain
 * and uses localStorage, like the rest of the app.
 */
const CHUNK = 1800;

const chunkedSecureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
    const n = Number(await SecureStore.getItemAsync(`${key}.n`));
    if (!Number.isInteger(n) || n <= 0) return null;
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => SecureStore.getItemAsync(`${key}.${i}`)));
    // a half-written session is no session; Supabase will just ask to sign in again
    return parts.every((p) => p !== null) ? parts.join("") : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") return void globalThis.localStorage?.setItem(key, value);
    const old = Number(await SecureStore.getItemAsync(`${key}.n`)) || 0;
    const n = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < n; i++) await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    await SecureStore.setItemAsync(`${key}.n`, String(n));
    for (let i = n; i < old; i++) await SecureStore.deleteItemAsync(`${key}.${i}`);
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === "web") return void globalThis.localStorage?.removeItem(key);
    const n = Number(await SecureStore.getItemAsync(`${key}.n`)) || 0;
    await SecureStore.deleteItemAsync(`${key}.n`);
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${key}.${i}`);
  },
};

/**
 * Supabase's PKCE wants `crypto.subtle.digest("SHA-256")` for an S256 code
 * challenge; Hermes has no WebCrypto and auth-js would quietly fall back to the
 * weaker "plain" method. expo-crypto's native digest has the same signature, so
 * lend it just that one function (react-native-get-random-values, imported
 * first in App.tsx, already supplies getRandomValues).
 */
if (Platform.OS !== "web" && globalThis.crypto && !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: {
      digest: (algorithm: string, data: BufferSource) =>
        ExpoCrypto.digest(algorithm as ExpoCrypto.CryptoDigestAlgorithm, data),
    },
  });
}

/** The app's auth client. Null when this build has no Supabase config. */
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: chunkedSecureStorage,
        storageKey: "loom-auth",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
    })
  : null;

// Supabase's RN guidance: only refresh tokens while the app is in the foreground.
if (supabase && Platform.OS !== "web") {
  AppState.addEventListener("change", (s) => {
    if (s === "active") void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------

export type SignInResult = { ok: true } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };

/** Query + fragment params of a redirect URL, without trusting URL polyfills. */
function redirectParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const query = q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : "";
  const frag = h >= 0 ? url.slice(h + 1) : "";
  for (const part of `${query}&${frag}`.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const v = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}

/**
 * Supabase's hosted Google flow in an auth session browser:
 * signInWithOAuth → openAuthSessionAsync → exchange the PKCE code (or, for an
 * implicit-flow project, adopt the tokens from the fragment). Never throws.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  if (!supabase) return { ok: false, cancelled: false, error: "Sign-in isn't configured in this build." };
  try {
    const redirectTo = makeRedirectUri({ scheme: "loom", path: "auth-callback" });
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data?.url) return { ok: false, cancelled: false, error: error?.message ?? "Couldn't start sign-in." };

    const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (res.type === "cancel" || res.type === "dismiss") return { ok: false, cancelled: true };
    if (res.type !== "success") return { ok: false, cancelled: false, error: "Sign-in didn't finish." };

    const p = redirectParams(res.url);
    if (p.error || p.error_description) {
      // "access_denied" is the user backing out on Google's consent screen
      if (p.error === "access_denied") return { ok: false, cancelled: true };
      return { ok: false, cancelled: false, error: p.error_description || p.error || "Sign-in failed." };
    }
    if (p.code) {
      const { error: xErr } = await supabase.auth.exchangeCodeForSession(p.code);
      return xErr ? { ok: false, cancelled: false, error: xErr.message } : { ok: true };
    }
    if (p.access_token && p.refresh_token) {
      const { error: sErr } = await supabase.auth.setSession({
        access_token: p.access_token,
        refresh_token: p.refresh_token,
      });
      return sErr ? { ok: false, cancelled: false, error: sErr.message } : { ok: true };
    }
    return { ok: false, cancelled: false, error: "Google sent us back without a session." };
  } catch (e) {
    return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut().catch(() => {});
}

/** The signed-in user, live. `ready` is false until the stored session has been read. */
export function useAuth(): { ready: boolean; session: Session | null; user: User | null } {
  const [state, setState] = useState<{ ready: boolean; session: Session | null }>({
    ready: !supabase,
    session: null,
  });
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => live && setState({ ready: true, session: data.session }))
      .catch(() => live && setState({ ready: true, session: null }));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live) setState({ ready: true, session });
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);
  return { ready: state.ready, session: state.session, user: state.session?.user ?? null };
}

/** What the profile UI shows. Google puts the name and picture in user_metadata. */
export function profileOf(user: User | null): { email: string; name: string; avatarUrl: string | null } | null {
  if (!user) return null;
  const m = (user.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const email = user.email ?? str(m.email);
  const avatar = str(m.avatar_url) || str(m.picture);
  return {
    email,
    name: str(m.full_name) || str(m.name) || email.split("@")[0] || "Signed in",
    avatarUrl: /^https:\/\//.test(avatar) ? avatar : null,
  };
}

// ---------------------------------------------------------------------------
// "Continue without an account" — remembered, so the welcome shows once
// ---------------------------------------------------------------------------

const SKIP_KEY = "loomAuthSkipped";

export const loadAuthSkipped = () => kv.get(SKIP_KEY).then((v) => v === "1").catch(() => false);
export const setAuthSkipped = (skipped: boolean) =>
  (skipped ? kv.set(SKIP_KEY, "1") : kv.del(SKIP_KEY)).catch(() => {});

// ---------------------------------------------------------------------------
// Analytics: one country-only row per day, and nothing else
// ---------------------------------------------------------------------------

const STATS_KEY = "loomUsageStats"; // "0" = off; anything else (incl. unset) = on
const DAY_KEY = "loomOpensDay"; // last UTC day a row was sent, YYYY-MM-DD

export const loadUsageStatsEnabled = () => kv.get(STATS_KEY).then((v) => v !== "0").catch(() => true);
export const setUsageStatsEnabled = (on: boolean) => kv.set(STATS_KEY, on ? "1" : "0").catch(() => {});

/**
 * At most once per UTC day, insert `{country, platform, app_version}` into
 * `app_opens`. Country is the device's REGION SETTING (expo-localization), not
 * an IP lookup or a location. No user id, device id or email — and the insert
 * goes out with the anon key only, never the signed-in session, so the row
 * can't be tied to an account even at the HTTP layer.
 *
 * Fire-and-forget: never awaited by UI, never throws, silent when unconfigured.
 */
export function recordAppOpen(): void {
  void (async () => {
    if (!supabaseConfigured) return;
    if (!(await loadUsageStatsEnabled())) return;
    const day = new Date().toISOString().slice(0, 10);
    if ((await kv.get(DAY_KEY).catch(() => null)) === day) return;

    const region = getLocales()[0]?.regionCode ?? null;
    const country = region && /^[A-Za-z]{2,3}$/.test(region) ? region.toUpperCase() : null;
    const platform = Platform.OS === "ios" || Platform.OS === "android" || Platform.OS === "web" ? Platform.OS : null;
    if (!platform) return;
    const appVersion = String(Constants.expoConfig?.version ?? "0.0.0").slice(0, 32);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_opens`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ country, platform, app_version: appVersion }),
    });
    if (res.ok) await kv.set(DAY_KEY, day);
  })().catch(() => {});
}
