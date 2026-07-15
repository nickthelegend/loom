# Loom — native app (Expo / React Native)

The native carrier of the loom daemon API: board, live thread, agent chips, and the
**Changes** view — per-prompt diffs (`turn_diff` events) and the live working tree
(`GET /api/projects/:id/tree`).

## Run it

```bash
cd app
npx expo install        # installs deps pinned for the Expo SDK
npx expo start          # scan the QR with Expo Go (Android/iOS)
```

Your phone must reach the daemon — same tailnet, daemon bound to it:

```bash
loom up --restart --tailnet
loom pair               # gives you the URL + pairing token for the Pair screen
```

Paste the whole pair link (or the URL + token separately) into the Pair screen.
Credentials are stored in the device keychain (expo-secure-store).

## What's inside

- `App.tsx` — hand-rolled 3-screen router (Pair → Board → Project), no nav deps.
- `src/api.ts` — daemon client (REST + WS URL builder), typed to the loom API.
- `src/screens.tsx` — Board (needs-input dots, route badges, $), Project with
  **Thread** (live WS events, chips that shift the baton on send, route banner) and
  **Changes** (working tree: branch, changed files, colored patch).
- `src/components.tsx` — event renderer; `turn_diff` events are expandable cards
  showing exactly what a prompt changed.

## Push notifications

Open the app once after pairing — it asks permission, fetches its Expo push token, and
registers it with the daemon (`POST /api/push/register`, attached to this device's
paired-client record). The daemon then pushes on `needs_input`, `route_completed`,
`route_failed`, and solo `run_complete` — route hops are suppressed on the server so
pipelines buzz once. Test from the computer: `loom clients --ping`.

## Notes

- If dependency versions drift from your Expo SDK: `npx expo install --fix`.
- Remote push in **Expo Go** works on SDK 52 (this app's pin); for store builds use a
  dev build / EAS as usual.
