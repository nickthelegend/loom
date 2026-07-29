#pragma once
// ─────────────────────────────────────────────────────────────────────────────
// Board + wiring for the ESP32-S3 macropad. Only fixed hardware facts live here;
// WiFi and the backend address are provisioned at runtime through the captive
// portal (see provision.h) and kept in NVS (see settings.h) — no recompile to
// change networks. (No potentiometer on this build; the dial code is gone.)
// ─────────────────────────────────────────────────────────────────────────────

// ---- 4×4 matrix ----
#define MATRIX_ROWS 4
#define MATRIX_COLS 4
static const uint8_t ROW_PINS[MATRIX_ROWS] = {10, 11, 12, 13};
static const uint8_t COL_PINS[MATRIX_COLS] = {18, 17, 8, 14};  // columns reversed to match the wiring

// ---- Mic: INMP441 (I2S RX) ----   VDD→3V3, GND→GND, L/R→GND
#define MIC_SCK 5
#define MIC_WS  4
#define MIC_SD  6

// ---- Amp: MAX98357A (I2S TX) ----  Vin→3V3, SD→3V3 (enable), GND→GND
#define SPK_BCLK 15
#define SPK_LRC  16
#define SPK_DIN  7

// ---- Audio: the one format the whole system speaks ----
#define AUDIO_SAMPLE_RATE 16000     // 16 kHz, 16-bit, mono — matches the backend
#define REC_SECONDS_MAX   12        // hold-to-talk ceiling; sizes the PSRAM buffer

// ---- The push-to-talk key (row/col). Also the "reset provisioning" key: hold
//      it while powering on to wipe saved WiFi and re-open the portal. ----
#define TALK_ROW 0
#define TALK_COL 2                  // mic key's RAW matrix position (K13, mirrored → row0/col2)

// ---- Backend URL default (editable in the captive portal, saved to NVS) ----
// LAN:    http://<your-mac-ip>:8080
// Remote: https://<machine>.<tailnet>.ts.net   (Tailscale Funnel — needs a token)
#define DEFAULT_BACKEND_URL "http://192.168.1.100:8080"

// ---- Telnet debug console: fixed port (not in the portal — it's not the
//      backend, just a log/command line you reach with `telnet <pad-ip>`). ----
#define TELNET_PORT 23

// ---- Captive-portal access point shown during provisioning ----
#define PORTAL_AP_NAME "LoomPad-Setup"
#define PORTAL_AP_PASS ""           // "" = open AP; set 8+ chars for a locked one

// ---- Onboard status LED: WS2812 addressable RGB on GPIO 48 ----
#define STATUS_LED 48

// ---- Hands-free telnet `talk` test: record this many ms then send ----
#define TELNET_TALK_MS 4000
