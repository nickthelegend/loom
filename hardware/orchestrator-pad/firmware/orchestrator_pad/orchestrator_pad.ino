// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator Pad — an ESP32-S3 voice + control surface for Loom.
//
// Boot flow:
//   1. If no WiFi is saved (or K1 held at power-on), raise the "LoomPad-Setup"
//      captive portal: pick your WiFi + enter the Loom backend IP, save.
//   2. Join WiFi, remember everything in flash, start the telnet debug server.
//   3. Ask the backend to speak "connected" through the amp.
//   4. Run: an agent key locks that agent in Loom (a handoff, visible in the
//      thread); hold K1 to talk → the recording is sent to that agent → its
//      spoken reply plays back.
//
// Config & wiring: config.h.  Key→agent map: agents.h.  Backend: ../backend.
// ─────────────────────────────────────────────────────────────────────────────

#include "config.h"
#include "settings.h"
#include "agents.h"
#include "matrix.h"
#include "audio.h"
#include "telnet.h"
#include "net.h"
#include "provision.h"

Matrix     matrix;
Audio      audio;
Telnet     telnet;
Net        net;
Provision  provision;
Settings   settings;

int16_t   *recBuf = nullptr;
const size_t REC_CAP = (size_t)AUDIO_SAMPLE_RATE * REC_SECONDS_MAX;
size_t     recLen = 0;
bool       recording = false;
uint32_t   recAutoStopAt = 0;          // 0 = manual (hold); else a ms deadline

String     selAgent = "";              // currently selected agent
uint8_t    selR = 0, selG = 20, selB = 0;

inline void led(uint8_t r, uint8_t g, uint8_t b) { rgbLedWrite(STATUS_LED, r, g, b); }
inline void ledReady() { led(selAgent.length() ? selR : 0, selAgent.length() ? selG : 20, selAgent.length() ? selB : 0); }

// ── recording ────────────────────────────────────────────────────────────────
void startRecording(uint32_t autoStopMs = 0) {
  if (recording) return;
  if (!selAgent.length()) {
    telnet.logf("  select an agent first (press an agent key)\n");
    audio.beep(300, 120);
    return;
  }
  recLen = 0;
  recording = true;
  recAutoStopAt = autoStopMs ? millis() + autoStopMs : 0;
  led(70, 0, 0);                        // red = recording
  audio.beep(1200, 70);
  telnet.logf("  ● recording for %s…\n", selAgent.c_str());
}

void stopAndSend() {
  if (!recording) return;
  recording = false;
  led(70, 40, 0);                       // amber = thinking
  audio.beep(700, 70);
  float secs = (float)recLen / AUDIO_SAMPLE_RATE;
  if (recLen < AUDIO_SAMPLE_RATE / 4) { // < 0.25 s
    telnet.logf("  … too short (%.2fs), ignored\n", secs);
    ledReady();
    return;
  }
  telnet.logf("  … captured %.1fs, sending to %s\n", secs, selAgent.c_str());
  String heard, said;
  bool ok = net.talk(recBuf, recLen, selAgent, audio, heard, said);
  if (ok) {
    telnet.logf("  heard: %s\n  said:  %s\n", heard.c_str(), said.c_str());
    ledReady();
  } else {
    telnet.logf("  ✗ voice request failed (backend at %s?)\n", settings.backendUrl);
    audio.beep(300, 220);
    led(80, 0, 0);
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────
// Friendly spoken form of an agent id (the caps read better out loud).
String spokenName(const String &id) {
  if (id == "claude-code") return "Claude";
  if (id == "grok-code")   return "Grok";
  if (id == "opencode")    return "Open Code";
  if (id == "antigravity") return "Antigravity";
  if (id == "codex")       return "Codex";
  if (id == "kiro")        return "Kiro";
  return id;
}

void selectAgent(const KeyBind &kb) {
  selAgent = kb.agent;
  selR = kb.r; selG = kb.g; selB = kb.b;
  led(selR, selG, selB);
  telnet.logf("  ▸ selected %s\n", selAgent.c_str());
  // Lock it in the backend, then say the name aloud. Only speak if the select
  // reached the backend (else net.speak would stall waiting on a dead server).
  if (net.select(selAgent))
    net.speak(String("Selected ") + spokenName(selAgent), audio);
  else
    telnet.logf("    (select didn't reach the backend)\n");
}

void onKey(uint8_t r, uint8_t c, bool pressed) {
  const KeyBind &kb = keyAt(r, c);
  if (pressed)   // diagnostic: raw position + current mapping, for remapping the KEYMAP
    telnet.logf("  [KEY] row=%u col=%u  currently=%s\n", r, c,
                kb.role == ROLE_MIC ? "MIC" : (kb.agent ? kb.agent : "unbound"));
  if (kb.role == ROLE_MIC) {
    if (pressed) startRecording();
    else         stopAndSend();
  } else if (kb.role == ROLE_AGENT && pressed) {
    selectAgent(kb);
  } else if (pressed) {
    telnet.logf("  %s (unbound)\n", matrix.name[r][c]);
  }
}

// ── telnet commands ──────────────────────────────────────────────────────────
void onTelnetCommand(const String &line) {
  String cmd = line; cmd.toLowerCase();
  if (cmd == "help") {
    telnet.println("help · status · ip · heap · agent · select <a> · say <t> · talk · url <u> · token <t> · reset-wifi · reboot");
  } else if (cmd == "status") {
    telnet.logf("wifi %s  ip %s  rssi %ddBm  heap %u  psram %u\n",
                WiFi.isConnected() ? "up" : "down", WiFi.localIP().toString().c_str(),
                WiFi.RSSI(), ESP.getFreeHeap(), ESP.getFreePsram());
    telnet.logf("backend %s  (%s, token %s)  · selected: %s\n",
                settings.backendUrl, settings.secure() ? "https" : "http",
                settings.padToken[0] ? "set" : "none",
                selAgent.length() ? selAgent.c_str() : "(none)");
  } else if (cmd == "map") {
    for (uint8_t r = 0; r < MATRIX_ROWS; r++) {
      char line[128] = "";
      for (uint8_t c = 0; c < MATRIX_COLS; c++) {
        const KeyBind &k = keyAt(r, c);
        const char *nm = (k.role == ROLE_MIC) ? "MIC" : (k.agent ? k.agent : "-");
        strncat(line, nm, sizeof(line) - strlen(line) - 4);
        strncat(line, " | ", sizeof(line) - strlen(line) - 1);
      }
      telnet.logf("  r%u: %s\n", r, line);
    }
  } else if (cmd == "ip") {
    telnet.println(WiFi.localIP().toString());
  } else if (cmd == "heap") {
    telnet.logf("heap %u  psram %u\n", ESP.getFreeHeap(), ESP.getFreePsram());
  } else if (cmd == "agent") {
    telnet.println(selAgent.length() ? selAgent : String("(none)"));
  } else if (cmd.startsWith("select ")) {
    selAgent = line.substring(7); selAgent.trim();
    telnet.logf("selected %s\n", selAgent.c_str());
    net.select(selAgent);
  } else if (cmd.startsWith("say ")) {
    String t = line.substring(4);
    telnet.logf("speaking: %s\n", t.c_str());
    if (!net.speak(t, audio)) telnet.logf("  speak failed\n");
  } else if (cmd == "talk") {
    telnet.logf("hands-free talk (%dms)…\n", TELNET_TALK_MS);
    startRecording(TELNET_TALK_MS);
  } else if (cmd.startsWith("url ")) {
    String u = line.substring(4); u.trim();          // original case — URLs matter
    settings.set(u.c_str(), settings.padToken);      // repoint backend, keep token + WiFi
    telnet.logf("backend URL → %s\n", settings.backendUrl);
    String brain;
    if (net.health(brain)) {
      telnet.logf("  ✓ reachable (brain=%s)\n", brain.c_str());
      net.speak("Backend connected.", audio);
    } else {
      telnet.logf("  ✗ not reachable yet — check the IP/port and that the backend is running\n");
    }
  } else if (cmd.startsWith("token ")) {
    String t = line.substring(6); t.trim();
    settings.set(settings.backendUrl, t.c_str());
    telnet.logf("pad token %s\n", t.length() ? "set" : "cleared");
  } else if (cmd == "reset-wifi") {
    telnet.println("wiping WiFi + settings, rebooting into the portal…");
    provision.resetWifi(); Settings::erase();
    delay(400); ESP.restart();
  } else if (cmd == "reboot") {
    telnet.println("rebooting…"); delay(200); ESP.restart();
  } else {
    telnet.println("unknown — 'help'");
  }
}

// K1 held at power-on? (used to force re-provisioning). Reads the matrix raw.
bool talkKeyHeldAtBoot() {
  digitalWrite(COL_PINS[TALK_COL], LOW);
  delayMicroseconds(20);
  bool held = digitalRead(ROW_PINS[TALK_ROW]) == LOW;
  digitalWrite(COL_PINS[TALK_COL], HIGH);
  return held;
}

// ── lifecycle ────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  uint32_t s = millis(); while (!Serial && millis() - s < 1200) {}
  led(0, 0, 60);                        // blue = booting

  matrix.begin();
  if (!audio.begin()) Serial.println("!! audio init failed");
  recBuf = (int16_t *)ps_malloc(REC_CAP * sizeof(int16_t));
  if (!recBuf) Serial.println("!! PSRAM alloc failed — enable Tools → PSRAM: OPI PSRAM");

  settings.load();
  net.begin(&settings);

  bool forcePortal = talkKeyHeldAtBoot();
  if (forcePortal) {
    Serial.println("K1 held → re-provisioning");
    provision.resetWifi();
    led(60, 0, 60);                     // magenta = portal
  } else {
    led(0, 40, 40);                     // cyan = connecting / portal
  }

  Serial.printf("provisioning… (join \"%s\" if the portal opens)\n", PORTAL_AP_NAME);
  bool up = provision.run(settings);    // blocks in the portal until configured

  if (!up) {
    Serial.println("!! WiFi not connected");
    led(80, 0, 0);
    return;                             // loop() will still scan keys / poll
  }

  Serial.printf("WiFi up: %s\n", WiFi.localIP().toString().c_str());
  telnet.begin(TELNET_PORT);
  telnet.onCommand(onTelnetCommand);
  Serial.printf("telnet:  telnet %s %u\n", WiFi.localIP().toString().c_str(), TELNET_PORT);
  Serial.printf("backend: %s  (token %s)\n", settings.backendUrl, settings.padToken[0] ? "set" : "none");

  // Announce we're up — through the amp, from the backend's TTS.
  led(0, 40, 0);                        // green = ready
  String brain;
  if (net.health(brain)) {
    Serial.printf("backend ok (brain=%s)\n", brain.c_str());
    if (!net.speak("Loom pad connected.", audio)) audio.beep(1320, 120);
  } else {
    Serial.println("!! backend not reachable — check the IP in the portal (reset-wifi to change)");
    audio.beep(880, 60); audio.beep(660, 120);   // fell-back chime
  }
  ledReady();
  Serial.println("Ready. Press an agent key, then hold K1 to talk.");
}

void loop() {
  matrix.scan(onKey);
  telnet.poll();

  if (recording && recBuf) {
    int16_t block[256];
    size_t n = audio.readMic(block, 256);
    for (size_t i = 0; i < n && recLen < REC_CAP; i++) recBuf[recLen++] = block[i];
    if (recLen >= REC_CAP) { telnet.logf("  (max length)\n"); stopAndSend(); }
    else if (recAutoStopAt && millis() >= recAutoStopAt) stopAndSend();
  }
}
