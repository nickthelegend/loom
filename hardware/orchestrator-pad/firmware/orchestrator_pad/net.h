#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "config.h"
#include "settings.h"
#include "audio.h"
#include "certs.h"

// Talks to the backend — the Mac's LAN IP over plain HTTP, or a Tailscale Funnel
// URL over HTTPS. The backend does STT → Loom/LLM → TTS and hands back raw 16 kHz
// PCM with a Content-Length, which we stream straight to the amp as it downloads.
//
// Transport is chosen per request from the saved URL's scheme (settings.secure()):
// https → WiFiClientSecure pinned to ISRG Root X1 (certs.h); http → WiFiClient.
// When a pad token is set it rides on every request as a Bearer header.
class Net {
public:
  void begin(Settings *s) { _s = s; }
  bool wifiUp() { return WiFi.status() == WL_CONNECTED; }

  // GET /health — true if the backend answers. Fills `brain` ("loom"/"llm").
  bool health(String &brain) {
    HTTPClient http; WiFiClient plain; WiFiClientSecure tls;
    if (!beginReq(http, plain, tls, url("/health"))) return false;
    auth(http);
    http.setTimeout(10000);
    int code = http.GET();
    if (code != 200) { http.end(); return false; }
    String body = http.getString();
    http.end();
    brain = jsonStr(body, "brain");
    return true;
  }

  // POST /select {agent} — lock the agent in Loom.
  bool select(const String &agent) {
    HTTPClient http; WiFiClient plain; WiFiClientSecure tls;
    if (!beginReq(http, plain, tls, url("/select"))) return false;
    auth(http);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(12000);
    int code = http.POST(String("{\"agent\":\"") + agent + "\"}");
    http.end();
    return code == 200;
  }

  // POST /voice (raw PCM) → stream the spoken reply to the amp.
  // Fills transcript/reply from response headers. Returns true on 200.
  bool talk(const int16_t *pcm, size_t samples, const String &agent,
            Audio &audio, String &transcript, String &reply) {
    HTTPClient http; WiFiClient plain; WiFiClientSecure tls;
    String u = url("/voice");
    if (agent.length()) u += "?agent=" + urlEnc(agent);
    if (!beginReq(http, plain, tls, u)) return false;
    auth(http);
    http.addHeader("Content-Type", "application/octet-stream");
    const char *keys[] = {"X-Transcript", "X-Reply"};
    http.collectHeaders(keys, 2);
    http.setTimeout(60000);

    int code = http.POST((uint8_t *)pcm, samples * sizeof(int16_t));
    if (code != 200) { http.end(); return false; }
    transcript = urlDec(http.header("X-Transcript"));
    reply      = urlDec(http.header("X-Reply"));
    streamToSpeaker(http, audio);
    http.end();
    return true;
  }

  // GET /speak?text=… → play it (connected cue, telnet `say`).
  bool speak(const String &text, Audio &audio) {
    HTTPClient http; WiFiClient plain; WiFiClientSecure tls;
    if (!beginReq(http, plain, tls, url("/speak") + "?text=" + urlEnc(text))) return false;
    auth(http);
    http.setTimeout(30000);
    int code = http.GET();
    if (code != 200) { http.end(); return false; }
    streamToSpeaker(http, audio);
    http.end();
    return true;
  }

private:
  Settings *_s = nullptr;

  // backendUrl + path, tolerating a trailing slash on the base.
  String url(const char *path) {
    String b = _s->backendUrl;
    while (b.endsWith("/")) b.remove(b.length() - 1);
    return b + path;
  }

  // Point the HTTPClient at either a plain or a TLS client, by the URL's scheme.
  // Both clients are stack-local in the caller so they outlive the request; the
  // unused one is never connected, so it costs nothing.
  bool beginReq(HTTPClient &http, WiFiClient &plain, WiFiClientSecure &tls, const String &fullUrl) {
    http.setConnectTimeout(10000);
    http.setReuse(false);
    if (_s->secure()) {
      tls.setCACert(ISRG_ROOT_X1);   // verify the Funnel cert — refuse a MITM
      tls.setHandshakeTimeout(15);   // fail fast if the URL is wrong/unreachable
      return http.begin(tls, fullUrl);
    }
    return http.begin(plain, fullUrl);
  }

  void auth(HTTPClient &http) {
    if (_s->padToken[0]) http.addHeader("Authorization", String("Bearer ") + _s->padToken);
  }

  // Read the PCM body and push it to I2S. The backend sends a Content-Length, so
  // there are no chunk markers to trip over; we carry an odd byte across reads to
  // keep 16-bit samples aligned. Works the same over TLS (the stream is just the
  // decrypted body).
  void streamToSpeaker(HTTPClient &http, Audio &audio) {
    WiFiClient *stream = http.getStreamPtr();
    int total = http.getSize();     // Content-Length, or -1 if unknown
    int remaining = total;
    uint8_t buf[1024];
    uint8_t carry = 0; bool haveCarry = false;
    uint32_t idle = millis();

    while (total < 0 ? (stream->connected() || stream->available()) : remaining > 0) {
      int avail = stream->available();
      if (avail > 0) {
        idle = millis();
        int off = 0;
        if (haveCarry) { buf[0] = carry; off = 1; haveCarry = false; }
        int want = (int)sizeof(buf) - off;
        if (total >= 0 && want > remaining) want = remaining;
        if (want <= 0) want = 1;
        int n = stream->readBytes(buf + off, min(avail, want));
        if (total >= 0) remaining -= n;
        int bytes = off + n;
        int samples = bytes / 2;
        if (bytes & 1) { carry = buf[bytes - 1]; haveCarry = true; }
        if (samples) audio.writeSpk((int16_t *)buf, samples);
      } else {
        if (!stream->connected() && !stream->available()) break;
        if (millis() - idle > 12000) break;     // stalled — bail
        delay(2);
      }
    }
  }

  static String urlEnc(const String &s) {
    static const char *hex = "0123456789ABCDEF";
    String o;
    for (size_t i = 0; i < s.length(); i++) {
      char c = s[i];
      if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += c;
      else if (c == ' ') o += "%20";
      else { o += '%'; o += hex[(c >> 4) & 0xF]; o += hex[c & 0xF]; }
    }
    return o;
  }

  static String urlDec(const String &s) {
    String o;
    for (size_t i = 0; i < s.length(); i++) {
      char c = s[i];
      if (c == '%' && i + 2 < s.length()) {
        auto h = [](char x) -> int {
          if (x >= '0' && x <= '9') return x - '0';
          if (x >= 'A' && x <= 'F') return x - 'A' + 10;
          if (x >= 'a' && x <= 'f') return x - 'a' + 10;
          return 0;
        };
        o += (char)((h(s[i + 1]) << 4) | h(s[i + 2]));
        i += 2;
      } else o += c;
    }
    return o;
  }

  // Minimal "key":"value" scrape — enough for /health without a JSON lib.
  static String jsonStr(const String &json, const char *key) {
    String needle = String("\"") + key + "\":\"";
    int a = json.indexOf(needle);
    if (a < 0) return "";
    a += needle.length();
    int b = json.indexOf('"', a);
    return b < 0 ? "" : json.substring(a, b);
  }
};
