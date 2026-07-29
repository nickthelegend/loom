// ─────────────────────────────────────────────────────────────────────────────
// keytest — a standalone key-matrix WIRING tester for the Orchestrator Pad.
//
// Flash this INSTEAD of the main firmware to check your hand-wiring. It doesn't
// touch WiFi, audio, or the backend — it only scans the 4×4 matrix and tells you
// which keys register.
//
// How to use:
//   1. Arduino IDE → Board: "ESP32S3 Dev Module", USB CDC On Boot: "Enabled".
//   2. Flash this sketch, then open Tools → Serial Monitor at 115200 baud.
//   3. Press every key. Each press prints a line, and a grid shows which keys
//      have registered ( * ) versus never fired ( . ).
//   4. Any key still shown as ( . ) after you press it has a wiring problem
//      (cold joint / broken wire / wrong pin). Fix it and it flips to ( * ).
//
// Pins match the real firmware (config.h). Change them here if yours differ.
// ─────────────────────────────────────────────────────────────────────────────

#define ROWS 4
#define COLS 4
const uint8_t ROW_PINS[ROWS] = {10, 11, 12, 13};   // rows: INPUT_PULLUP
const uint8_t COL_PINS[COLS] = {14,  8, 17, 18};   // cols: driven LOW one at a time

// Key labels, laid out as the matrix is wired. "--" = an unused cell.
const char *KEYNAME[ROWS][COLS] = {
  { "K1",  "K2",  "K3",  "--"  },   // row 0  (col3 = dial hole, unused)
  { "K4",  "K5",  "K6",  "K7"  },   // row 1
  { "K8",  "K9",  "K10", "K11" },   // row 2
  { "K12", "K13", "K14", "--"  },   // row 3  (col3 unused)
};

bool     held[ROWS][COLS]  = {{false}};
bool     last[ROWS][COLS]  = {{false}};
bool     seen[ROWS][COLS]  = {{false}};   // has this cell EVER fired?
uint32_t tEdge[ROWS][COLS] = {{0}};
const uint16_t DEBOUNCE_MS = 15;

bool isUsed(uint8_t r, uint8_t c) { return strcmp(KEYNAME[r][c], "--") != 0; }

void printGrid() {
  Serial.println();
  Serial.println("  ---- keys registered so far  ( * = OK,  . = not yet ) ----");
  for (uint8_t r = 0; r < ROWS; r++) {
    Serial.print("   ");
    for (uint8_t c = 0; c < COLS; c++) {
      if (!isUsed(r, c)) { Serial.print("        "); continue; }
      char cell[16];
      snprintf(cell, sizeof(cell), "%-4s%s  ", KEYNAME[r][c], seen[r][c] ? "*" : ".");
      Serial.print(cell);
    }
    Serial.println();
  }
  Serial.print("  still MISSING: ");
  bool any = false;
  for (uint8_t r = 0; r < ROWS; r++)
    for (uint8_t c = 0; c < COLS; c++)
      if (isUsed(r, c) && !seen[r][c]) { Serial.print(KEYNAME[r][c]); Serial.print(' '); any = true; }
  Serial.println(any ? "" : "none — every key works!");
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  uint32_t s = millis();
  while (!Serial && millis() - s < 1500) {}
  for (uint8_t c = 0; c < COLS; c++) { pinMode(COL_PINS[c], OUTPUT); digitalWrite(COL_PINS[c], HIGH); }
  for (uint8_t r = 0; r < ROWS; r++) pinMode(ROW_PINS[r], INPUT_PULLUP);

  Serial.println("\n=== Orchestrator Pad — key wiring test ===");
  Serial.println("Press each key. It prints on press, and the grid shows which");
  Serial.println("keys have registered (*). A key still shown ( . ) after you");
  Serial.println("press it isn't wired through — fix that joint/wire.");
  printGrid();
}

void loop() {
  for (uint8_t c = 0; c < COLS; c++) {
    digitalWrite(COL_PINS[c], LOW);
    delayMicroseconds(5);
    for (uint8_t r = 0; r < ROWS; r++) {
      bool pressed = (digitalRead(ROW_PINS[r]) == LOW);
      if (pressed != last[r][c]) { tEdge[r][c] = millis(); last[r][c] = pressed; }
      if (millis() - tEdge[r][c] > DEBOUNCE_MS && pressed != held[r][c]) {
        held[r][c] = pressed;
        const char *nm = KEYNAME[r][c];
        if (pressed) {
          Serial.printf(">>> %-4s PRESSED   (row %u, col %u)\n", nm, r, c);
          if (isUsed(r, c) && !seen[r][c]) { seen[r][c] = true; printGrid(); }
        } else {
          Serial.printf("    %-4s released\n", nm);
        }
      }
    }
    digitalWrite(COL_PINS[c], HIGH);
  }
}
