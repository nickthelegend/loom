#pragma once
#include <ESP_I2S.h>   // Arduino-ESP32 core 3.x
#include "config.h"

// Two independent I2S peripherals: INMP441 mic (RX) and MAX98357A amp (TX).
// Record and playback are sequential in hold-to-talk, so they never fight.
class Audio {
public:
  I2SClass mic;
  I2SClass spk;

  bool begin() {
    spk.setPins(SPK_BCLK, SPK_LRC, SPK_DIN, -1, -1);
    bool okS = spk.begin(I2S_MODE_STD, AUDIO_SAMPLE_RATE,
                         I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);

    mic.setPins(MIC_SCK, MIC_WS, -1, MIC_SD, -1);
    bool okM = mic.begin(I2S_MODE_STD, AUDIO_SAMPLE_RATE,
                         I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    return okS && okM;
  }

  // Read one block of mic samples. Returns the sample count.
  size_t readMic(int16_t* buf, size_t maxSamples) {
    size_t bytes = mic.readBytes((char*)buf, maxSamples * sizeof(int16_t));
    return bytes / sizeof(int16_t);
  }

  // Push PCM to the speaker (blocking — this is the back-pressure that paces
  // the streamed download in net.h).
  void writeSpk(const int16_t* buf, size_t samples) {
    spk.write((uint8_t*)buf, samples * sizeof(int16_t));
  }

  // A short sine cue. Used for start/stop/error feedback.
  void beep(float hz, uint32_t ms, int16_t amp = 8000) {
    uint32_t n = (AUDIO_SAMPLE_RATE * ms) / 1000;
    for (uint32_t i = 0; i < n; i++) {
      float t = (float)i / AUDIO_SAMPLE_RATE;
      int16_t s = (int16_t)(amp * sinf(2.0f * PI * hz * t));
      spk.write((uint8_t*)&s, sizeof(s));
    }
  }
};
