/**
 * Loom Cloud on the phone: the Supabase Realtime transport the RelayClient
 * rides. It mirrors `supabaseTransport` in src/daemon/relay.ts exactly — same
 * topic, same event name ("e"), same broadcast config — because the two ends
 * only meet if they agree on all three.
 *
 * It deliberately builds its OWN Supabase client from the pairing link's
 * `sb`/`sbk` params rather than reusing the app's sign-in client: the daemon's
 * Supabase project is whatever its owner configured, which need not be the one
 * this app signs people in with. Supabase only ever sees ciphertext here.
 */

import { createClient } from "@supabase/supabase-js";
import { relayTopic, type RelayTransport } from "./relay-protocol";

export function supabaseRelayTransport(url: string, anonKey: string, channel: string): RelayTransport {
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      // a second GoTrue instance in one app warns when it shares the default key
      storageKey: "loom-relay",
    },
    realtime: { params: { eventsPerSecond: 40 } },
  });
  const ch = client.channel(relayTopic(channel), { config: { broadcast: { self: false, ack: false } } });
  const listeners: Array<(env: unknown) => void> = [];
  ch.on("broadcast", { event: "e" }, (msg: { payload?: unknown }) => {
    for (const l of listeners) l(msg.payload);
  });
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // A rejection nobody awaited yet must not surface as an unhandled rejection.
  ready.catch(() => {});
  ch.subscribe((status: string, err?: Error) => {
    if (status === "SUBSCRIBED") resolveReady();
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      rejectReady(err ?? new Error(`realtime ${status.toLowerCase()}`));
    }
  });
  return {
    async send(env) {
      await ch.send({ type: "broadcast", event: "e", payload: env });
    },
    onEnvelope(cb) {
      listeners.push(cb);
    },
    ready: () => ready,
    async close() {
      await client.removeChannel(ch).catch(() => {});
      client.realtime.disconnect();
    },
  };
}
