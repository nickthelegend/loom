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

## Build the APK (standalone, includes voice input)

```bash
cd app
npx expo prebuild -p android --no-install
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/release/app-release.apk
```

Testing over USB without Tailscale: `adb reverse tcp:7420 tcp:7420` makes the phone's
`127.0.0.1:7420` reach the daemon on your computer — pair with a
`http://127.0.0.1:7420/app#pair=…` link while plugged in. For wireless, use
`loom up --restart --tailnet && loom pair` as usual.

## Voice input

The composer has a mic button (APK / dev builds): tap → speak → live transcript lands
in the input (appended to anything already typed), tap again or hit send to stop.
On-device recognition via expo-speech-recognition; the button hides itself in
environments without the native module (e.g. plain Expo Go).

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
