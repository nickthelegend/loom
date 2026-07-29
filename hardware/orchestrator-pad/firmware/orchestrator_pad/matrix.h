#pragma once
#include <Arduino.h>
#include "config.h"

// 4×4 scan, no diodes, INPUT_PULLUP rows + one column driven LOW at a time.
// Per-key debounce. Two cells unused: R0/C3 (was the dial hole) and R3/C3.
class Matrix {
public:
  const char* name[MATRIX_ROWS][MATRIX_COLS] = {
    { "K1", "K2", "K3", "--" },
    { "K4", "K5", "K6", "K7" },
    { "K8", "K9", "K10","K11"},
    { "K12","K13","K14","--" }
  };
  bool held[MATRIX_ROWS][MATRIX_COLS] = {{false}};

  void begin() {
    for (uint8_t c = 0; c < MATRIX_COLS; c++) {
      pinMode(COL_PINS[c], OUTPUT);
      digitalWrite(COL_PINS[c], HIGH);
    }
    for (uint8_t r = 0; r < MATRIX_ROWS; r++)
      pinMode(ROW_PINS[r], INPUT_PULLUP);
  }

  // Call every loop. onChange(r,c,pressed) fires on debounced edges.
  void scan(void (*onChange)(uint8_t, uint8_t, bool)) {
    for (uint8_t c = 0; c < MATRIX_COLS; c++) {
      digitalWrite(COL_PINS[c], LOW);
      delayMicroseconds(5);
      for (uint8_t r = 0; r < MATRIX_ROWS; r++) {
        bool pressed = (digitalRead(ROW_PINS[r]) == LOW);
        if (pressed != _last[r][c]) { _t[r][c] = millis(); _last[r][c] = pressed; }
        if (millis() - _t[r][c] > DEBOUNCE_MS && pressed != held[r][c]) {
          held[r][c] = pressed;
          if (onChange) onChange(r, c, pressed);
        }
      }
      digitalWrite(COL_PINS[c], HIGH);
    }
  }

private:
  static const uint16_t DEBOUNCE_MS = 15;
  bool     _last[MATRIX_ROWS][MATRIX_COLS] = {{false}};
  uint32_t _t[MATRIX_ROWS][MATRIX_COLS]    = {{0}};
};
