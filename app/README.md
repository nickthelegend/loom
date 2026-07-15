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

## Notes

- If dependency versions drift from your Expo SDK: `npx expo install --fix`.
- Push notifications are the next step (expo-notifications + a daemon hook on
  `needs_input` / `run_complete`).
