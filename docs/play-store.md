# Loom on Google Play

What the Play Console asks for, and Loom's answers. The app is `tech.loompad.app`.

## Build the bundle

```bash
LOOM_KEYSTORE_PROPS=/path/to/keystore.properties app/scripts/build-aab.sh
```

It writes `app/dist/loom-<version>-<versionCode>.aab`, signed with your **upload key**.
Google re-signs it with the app signing key it keeps (Play App Signing — accept it when
you create the app). Before each new upload, raise `expo.android.versionCode` in
`app/app.json` (Play refuses a code it has seen). Raise `expo.version` when users should
see a new version number.

Keep the keystore and its `keystore.properties` backed up somewhere safe and out of git.
If the upload key is lost, Play support can reset it, which takes a few days.

The APK on GitHub Releases is signed with a different key (the `ANDROID_KEYSTORE_*`
secrets). Android won't install the Play build over that APK, so anyone moving from the
APK to the Play build uninstalls the APK first. To avoid that, choose "use my own key"
under Play App Signing and upload that same keystore as the app signing key.

### Push notifications in the Play build

Expo Go gets push for free. A store build needs two things that only you can set up:

1. **Firebase:** create a project at console.firebase.google.com, add an Android app with
   package `tech.loompad.app`, and download `google-services.json` into `app/`. It's
   gitignored, and `app.config.js` picks it up.
2. **Expo:** run `npx eas-cli login`, then `npx eas-cli init` in `app/`. It prints a
   project id. Build with `EAS_PROJECT_ID=<that id>` set. Then upload the Firebase
   service-account key in expo.dev → the project → Credentials → Android → FCM V1.

Without them, the app works and its account sheet says this build can't get push.

## Store listing

- **App name:** Loom
- **Short description (80):** Watch, steer and approve your coding agents from your phone.
- **Full description:**

  > Loom is the remote for Loom, the free and open-source workspace where your coding
  > agents (Claude Code, Codex, OpenCode, Grok, Antigravity and plain models) work side by
  > side and share one memory of your project.
  >
  > Loom runs on your computer. This app pairs with it by QR code and lets you:
  > • follow every agent live and send them messages, pictures or voice
  > • answer their questions and Allow or Deny tool calls
  > • run Orchestra goals and races, and crews of agents with roles
  > • review diffs, rewind to a checkpoint, commit and push
  > • see what each agent cost, in dollars and tokens
  > • get notified when an agent asks something, finishes, or a goal is done
  >
  > You'll need Loom on a Mac, Linux or Windows computer: see
  > loompad.tech. Nothing goes through Loom's servers. The phone
  > talks to your computer over your network, your tailnet, or an encrypted relay.

- **Category:** Tools (or Productivity) · **Tags:** developer tools
- **Contact email:** required, use one you read.
- **Website:** https://loompad.tech
- **Privacy policy:** https://loompad.tech/privacy (the landing site,
  nickthelegend/loompad-landing)
- **Graphics:** a 512×512 icon (`app/assets/icon.png` scaled down), a 1024×500 feature
  graphic, and at least 2 phone screenshots (Board, a chat, the Orchestra tab, the
  account sheet).

## App content (the questionnaires)

- **Privacy policy:** the URL above.
- **Ads:** no ads.
- **App access:** "All or some functionality is restricted." Reviewers can't pair without
  a computer running Loom, so give them instructions: "Loom is the companion app for a
  desktop tool. Install Loom on a computer (loompad.tech), run
  `loom up` then `loom pair`, and scan the QR code." Better still, link a short screen
  recording of pairing and use.
- **Content rating:** answer the IARC questionnaire as a utility/productivity app. No
  violence, sexual content, gambling or drugs. It does show text written by AI models.
  It doesn't let users message other people.
- **Target audience:** 18+ (a developer tool); not designed for children.
- **News app:** no. **COVID / government:** no. **Financial features:** none.
- **Data safety** (for the Play build, which has no sign-in or analytics):
  - Data collected: **none** (nothing is sent to the developer).
  - Data shared: **none**. What goes to Firebase/Expo for push, and to the speech
    recognizer, is processed for you by a service provider. Google's guidance doesn't
    count that as sharing.
  - Data is encrypted in transit: **yes** (HTTPS / the relay); over a plain LAN or tailnet
    address the transport is your own network's.
  - Users can request deletion: **yes**, by unpairing or uninstalling. The data lives on
    their own computer.
  - If a later build turns on Google sign-in or usage stats, update this form: name,
    email and user id for the account, and approximate location (region) for analytics.
- **Permissions:** camera (QR pairing, attaching a photo), microphone (dictation),
  notifications. Nothing in the background. Storage and media-library permissions are
  blocked in `app.json`.

## Testing tracks, and the 12-tester rule

Personal developer accounts created after November 2023 can't publish to production
straight away. You need a **closed test with at least 12 testers who stay opted in for 14
days in a row**; then "Apply for production" unlocks. It can't be skipped. (Organisation
accounts are exempt.)

1. **Internal testing** (up to 100 testers, no review, live in minutes): create a release,
   upload the `.aab`, add your own Google accounts as testers, and install from the opt-in
   link. Use this to check the build on real phones.
2. **Closed testing:** create a track, upload the same `.aab` (or promote it), add testers
   by email list or a Google Group, and share the opt-in link. You need **12+ people who
   accept and keep it installed for 14 days**. Friends, a Discord or the repo's community
   all work; a Google Group makes adding people easy.
3. After 14 days, **Apply for production** in the dashboard. You'll answer questions about
   the test and the app. Review usually takes a few days.
4. **Production:** promote the release, choose countries, roll out (a staged rollout
   such as 20% first is a good habit).

## Updates

- Each Play update needs a higher `versionCode`. Build, upload to a track, and promote.
- Users get updates through Play. The app's account sheet also shows whether the
  *computer's* Loom is behind the newest GitHub release. The computer pushes an "update
  available" notification once per release (the "Loom updates" switch).
- The account sheet's **Rate Loom** opens the Play listing (Android only).
