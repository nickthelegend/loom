#pragma once
#include <Arduino.h>
#include <Preferences.h>
#include "config.h"

// Runtime config, persisted in NVS (flash key/value). Written by the captive
// portal, read on every boot. WiFi credentials themselves are stored by
// WiFiManager separately; this holds where the backend lives and the secret
// used to reach it.
//
//   backendUrl : full base URL — http://192.168.1.20:8080 on the LAN, or
//                https://<machine>.<tailnet>.ts.net for a Tailscale Funnel.
//                The scheme decides plain HTTP vs. TLS in net.h.
//   padToken   : shared secret sent as `Authorization: Bearer …` (required by
//                the backend once it's exposed to the internet). Blank = none.
struct Settings {
  char backendUrl[128] = DEFAULT_BACKEND_URL;
  char padToken[96]    = "";

  void load() {
    Preferences p;
    p.begin("loompad", true); // read-only
    copyInto(backendUrl, sizeof(backendUrl), p.getString("url", DEFAULT_BACKEND_URL));
    copyInto(padToken, sizeof(padToken), p.getString("token", ""));
    p.end();
  }

  void save() {
    Preferences p;
    p.begin("loompad", false);
    p.putString("url", backendUrl);
    p.putString("token", padToken);
    p.end();
  }

  void set(const char *url, const char *token) {
    if (url && *url) copyInto(backendUrl, sizeof(backendUrl), url);
    copyInto(padToken, sizeof(padToken), token ? token : "");
    save();
  }

  bool secure() const { return strncmp(backendUrl, "https://", 8) == 0; }

  // Wipe everything (used by the reset-provisioning gesture).
  static void erase() {
    Preferences p;
    p.begin("loompad", false);
    p.clear();
    p.end();
  }

private:
  static void copyInto(char *dst, size_t cap, const String &src) {
    strncpy(dst, src.c_str(), cap - 1);
    dst[cap - 1] = 0;
  }
};
