#pragma once
#include <WiFi.h>
#include <WiFiManager.h>   // Library Manager: "WiFiManager" by tzapu
#include "config.h"
#include "settings.h"

// Captive-portal provisioning.
//
// On boot we try the saved WiFi. If there's none (first run) or it won't join,
// the pad raises the "LoomPad-Setup" access point and serves a portal: connect
// a phone/laptop to it and a page pops up (captive) listing the WiFi networks
// around you, plus fields for the Loom backend URL + pad token. Save, and the
// pad joins your WiFi and remembers everything in flash — so this only happens
// once (or after a reset). autoConnect() blocks here until it's connected, which
// is why the portal parameters can live on the stack.
class Provision {
public:
  // Returns true once WiFi is connected (blocks in the portal until then).
  bool run(Settings &s) {
    // Two fields: where the backend lives, and the secret to reach it. The URL's
    // scheme picks the transport — http://<mac-ip>:8080 on the LAN, or a
    // https://<machine>.<tailnet>.ts.net Tailscale Funnel from anywhere.
    WiFiManagerParameter pUrl(
      "url", "Loom backend URL (http://IP:8080 or https://mac.ts.net)", s.backendUrl, 120);
    WiFiManagerParameter pToken(
      "token", "Pad token (blank if the backend has none)", s.padToken, 90);

    _wm.setTitle("Loom Pad");
    _wm.addParameter(&pUrl);
    _wm.addParameter(&pToken);
    _wm.setConfigPortalBlocking(true);
    _wm.setConfigPortalTimeout(0);          // stay open until configured
    _wm.setBreakAfterConfig(true);

    bool ok = strlen(PORTAL_AP_PASS)
                ? _wm.autoConnect(PORTAL_AP_NAME, PORTAL_AP_PASS)
                : _wm.autoConnect(PORTAL_AP_NAME);

    // Persist whatever the portal collected (harmless if nothing changed).
    s.set(pUrl.getValue(), pToken.getValue());

    return ok && WiFi.status() == WL_CONNECTED;
  }

  // Wipe the saved WiFi so the next boot re-opens the portal.
  void resetWifi() { _wm.resetSettings(); }

private:
  WiFiManager _wm;
};
