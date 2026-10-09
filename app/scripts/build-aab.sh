#!/usr/bin/env bash
# A Play Store bundle (.aab) of the phone app, built on this machine.
#
#   LOOM_KEYSTORE_PROPS=/path/to/keystore.properties  app/scripts/build-aab.sh
#
# keystore.properties holds the upload key — never in the repo:
#   LOOM_UPLOAD_STORE_FILE=/abs/path/loom-upload.jks
#   LOOM_UPLOAD_KEY_ALIAS=loom-upload
#   LOOM_UPLOAD_STORE_PASSWORD=…
#   LOOM_UPLOAD_KEY_PASSWORD=…
#
# Optional: app/google-services.json (Firebase, for push in the Play build) and
# EAS_PROJECT_ID (for an Expo push token) — see app.config.js.
# GRADLE_USER_HOME / TMPDIR can point at a roomier disk (TMPDIR without spaces;
# not JAVA_TOOL_OPTIONS — its "Picked up" stderr line makes AGP's prefab step
# fail with "No compatible library found"). The Gradle heap and workers are
# kept small so the build doesn't push a busy machine into swap.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"

PROPS="${LOOM_KEYSTORE_PROPS:?set LOOM_KEYSTORE_PROPS to your keystore.properties}"
test -f "$PROPS" || { echo "no $PROPS"; exit 1; }
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
# Use the newest NDK already installed rather than letting Gradle fetch the one
# React Native pins (a multi-GB download into the SDK). LOOM_NDK overrides.
NDK="${LOOM_NDK:-$(ls "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1)}"

npx expo prebuild -p android --no-install --clean

# release builds sign with the upload key (Play re-signs with the app key)
python3 - "$PROPS" <<'EOF'
import re, sys
props = sys.argv[1]
p = "android/app/build.gradle"
s = open(p).read()
cfg = '''
        release {
            def ks = new Properties()
            file("%s").withInputStream { ks.load(it) }
            storeFile file(ks.getProperty("LOOM_UPLOAD_STORE_FILE"))
            storePassword ks.getProperty("LOOM_UPLOAD_STORE_PASSWORD")
            keyAlias ks.getProperty("LOOM_UPLOAD_KEY_ALIAS")
            keyPassword ks.getProperty("LOOM_UPLOAD_KEY_PASSWORD")
        }
''' % props.replace("\\", "\\\\").replace('"', '\\"')
s = s.replace("    signingConfigs {\n", "    signingConfigs {" + cfg, 1)
# the release build type, not debug's, gets the new config
head, sep, tail = s.partition("buildTypes {")
tail = re.sub(r"(release\s*\{[^}]*?)signingConfig signingConfigs\.debug", r"\1signingConfig signingConfigs.release", tail, count=1)
s = head + sep + tail
assert "signingConfig signingConfigs.release" in s, "couldn't point the release build at the upload key"
open(p, "w").write(s)
EOF

if [ -n "$NDK" ]; then
  sed -i '' -E "s/ndkVersion = \"[0-9.]+\"/ndkVersion = \"$NDK\"/" android/build.gradle
  grep -q "ndkVersion = \"$NDK\"" android/build.gradle || { echo "couldn't set the NDK version"; exit 1; }
fi

(cd android && ./gradlew bundleRelease --no-daemon --max-workers=2 \
  -Dorg.gradle.jvmargs="-Xmx2g -XX:MaxMetaspaceSize=512m${TMPDIR:+ -Djava.io.tmpdir=$TMPDIR}" \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Pandroid.suppressUnsupportedCompileSdk=36 \
  -PreactNativeArchitectures=armeabi-v7a,arm64-v8a,x86_64)

AAB="android/app/build/outputs/bundle/release/app-release.aab"
test -f "$AAB" || { echo "gradle produced no bundle"; exit 1; }
# (not `unzip | grep -q`: under pipefail, grep quitting early fails the pipe)
unzip -l "$AAB" > "$AAB.list"
grep -q "base/assets/index.android.bundle" "$AAB.list" || { echo "the bundle has no JavaScript"; exit 1; }
jarsigner -verify "$AAB" >/dev/null || { echo "the bundle isn't signed"; exit 1; }

VERSION=$(node -p "require('./app.json').expo.version")
CODE=$(node -p "require('./app.json').expo.android.versionCode")
mkdir -p dist
OUT="dist/loom-${VERSION}-${CODE}.aab"
cp "$AAB" "$OUT"
ls -la "$OUT"
