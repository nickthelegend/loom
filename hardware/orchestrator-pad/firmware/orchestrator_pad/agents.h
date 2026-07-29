#pragma once
#include <Arduino.h>
#include "config.h"

// What each key does. EDIT this grid to match how your keycaps are laid out.
// One key is the mic (hold-to-talk); the agent keys select/lock that agent in
// Loom. Each agent gets a status-LED colour so you can see who's selected.
enum KeyRole { ROLE_NONE, ROLE_MIC, ROLE_AGENT };

struct KeyBind {
  KeyRole     role;
  const char *agent;      // Loom agent id, for ROLE_AGENT
  uint8_t     r, g, b;    // status-LED colour when selected
};

// Matches the physical keycaps as wired on this build, K1..K14 (top-left → right,
// then down), mapped onto the natural matrix grid:
//   K1 Cursor  K2 Codex   K3 (none)   —dial—
//   K4 Grok    K5 Claude  K6 Antigrav K7 opencode
//   K8 Kiro    K9 boost   K10 yes     K11 no
//   K12 cmd    K13 MIC    K14 next    —empty—
// Cursor (K1) and the action caps (boost/yes/no/cmd/next) have no Loom agent
// yet, so they're left unbound. Rotate the pad and the positions mirror — keep
// the USB/ESP32 edge oriented as you wired it or this map flips.
static const KeyBind KEYMAP[MATRIX_ROWS][MATRIX_COLS] = {
  // C0                                    C1                                    C2                                    C3
  {{ROLE_NONE, nullptr,       0,0,0},     {ROLE_AGENT,"cursor",     30,30,60},  {ROLE_AGENT,"codex",       0,50,0},   {ROLE_NONE, nullptr, 0,0,0}},    // r0: - · cursor(0,1) · codex(0,2) · -
  {{ROLE_AGENT,"grok-code",  45,45,45},   {ROLE_AGENT,"claude-code", 70,35,0},  {ROLE_AGENT,"antigravity",15,20,70}, {ROLE_AGENT,"opencode",0,45,45}}, // r1: grok · claude · antigravity · opencode
  {{ROLE_AGENT,"kiro",       45,0,70},    {ROLE_NONE, nullptr,       0,0,0},    {ROLE_AGENT,"accept",     0,60,0},   {ROLE_AGENT,"cancel",  60,0,0}},  // r2: kiro · - · accept · cancel
  {{ROLE_AGENT,"terminal",   40,40,40},   {ROLE_NONE, nullptr,       0,0,0},    {ROLE_MIC,  nullptr,     60,0,0},    {ROLE_NONE, nullptr, 0,0,0}},     // r3: terminal · - · MIC(3,2) · -
};

// This build is mounted rotated 180° from the KEYMAP above, so the scanned
// matrix position is point-reflected (rows AND cols reversed) before lookup —
// that keeps the KEYMAP readable as the keycaps are labelled. Set to 0 if you
// ever remount it the other way up.
#define KEYS_MIRRORED 0
inline const KeyBind &keyAt(uint8_t r, uint8_t c) {
#if KEYS_MIRRORED
  return KEYMAP[MATRIX_ROWS - 1 - r][MATRIX_COLS - 1 - c];
#else
  return KEYMAP[r][c];
#endif
}
