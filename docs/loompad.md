# LoomPad

LoomPad is the physical companion for Loom: a printable ESP32-S3 desk pad that
selects an agent, sets effort, captures hold-to-talk audio, and sends work to
the Loom stack. The current repository ships the v0.1 enclosure, keycaps, CAD
sources, and the daemon-side connectivity surface. Firmware and the voice
backend are not yet included, so the flashing and voice sections below define
the intended integration contract rather than a ready-to-run build.

See [`hardware/orchestrator-pad/README.md`](../hardware/orchestrator-pad/README.md)
for CAD regeneration and [`hardware/orchestrator-pad/SPEC.md`](../hardware/orchestrator-pad/SPEC.md)
for the dimensional source of truth.

## Parts

| Qty. | Part | Notes |
| ---: | --- | --- |
| 1 | ESP32-S3 DevKitC-1 | Use a board without factory headers, or trim the headers flush; the tray has no clearance below the PCB. |
| 14 | MX-style switches | 13 1u switches plus one switch under the 2u voice bar. |
| 1 | EC11 rotary encoder | M7 threaded bush; the printed knob fits its D-shaft. |
| 1 | INMP441 I2S microphone | Mount behind the front three-hole mic grille. |
| 4 | M3 heat-set inserts | Fit the tray's corner bosses. |
| 4 | M3×8 button-head screws | M3×10 screws bottom out before clamping the plate. |
| 4 | Rubber feet, about Ø8 mm | Fit the tray's recessed feet pockets. |
| Optional | WS2812 LEDs | Intended for the three preset/status keys. |

Print `tray.stl`, `plate.stl`, `caps-all.stl`, and `knob.stl` from
`hardware/orchestrator-pad/exports/`. Use a 0.4 mm nozzle and 0.2 mm layers in
PLA or PETG. Print the tray and plate flat without supports, the knob upright,
and the caps face-down or with tree supports.

The v0.1 electrical build is hand-wired. The matrix row/column GPIO assignment
and I2S pin mapping are firmware-owned and are not defined in this repository;
do not infer them from the mechanical 4×4 layout.

## 4×4 keymap

The grid is viewed from the user, with row 0 at the back of the pad. The voice
bar spans columns 1 and 2 but is one 2u key/switch position for matrix purposes.

| Row \ Column | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| 0 | Effort encoder | Preset/status: dot | Preset/status: ring | Preset/status: target |
| 1 | Codex (`X`) | Claude (`C`) | Antigravity (`A`) | OpenCode (`O`) |
| 2 | Kiro (`K`) | Run (`⚡`) | Approve (`✓`) | Reject (`✕`) |
| 3 | Prompt/terminal | Voice hold (`🎤`, 2u) | Voice hold (`🎤`, 2u) | Send/dispatch (`➤`) |

Agent keys lock the target agent. The encoder maps its detents to effort:
`low`, `medium`, `high`, `xhigh`, `max`, and `ultracode`. Run, approve, reject,
prompt, and send are command actions; their exact daemon mapping belongs in the
firmware once implemented.

## Flashing with `arduino-cli`

There is currently no `firmware/` sketch in this repository, so these commands
are the expected flow after a LoomPad sketch is added or checked out locally.
They intentionally do not name a serial port or dependencies that the missing
sketch has not declared.

```bash
# Install the ESP32 board support once.
arduino-cli core update-index
arduino-cli core install esp32:esp32

# Identify the DevKitC-1's serial port.
arduino-cli board list

# From the directory containing the future LoomPad sketch.
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/loompad
arduino-cli upload --fqbn esp32:esp32:esp32s3 --port /dev/cu.usbmodemXXXX firmware/loompad

# Inspect boot and Wi-Fi logs.
arduino-cli monitor --port /dev/cu.usbmodemXXXX --config baudrate=115200
```

Replace `/dev/cu.usbmodemXXXX` with the port from `arduino-cli board list`
(`COM…` on Windows or `/dev/ttyACM…` on Linux). If upload cannot enter the
bootloader, hold the board's **BOOT** button while starting upload, then release
it when the tool connects.

## Voice loop

The intended hold-to-talk flow is:

1. Press an agent key to lock the recipient, and turn the encoder to choose
   effort.
2. Hold the voice bar. Firmware samples the INMP441 and buffers/streams audio.
3. On release, firmware sends the selected agent, action, effort, and audio to
   the voice service. The planned envelope is `{ "agent", "action", "effort",
   "audio" }`.
4. The voice service performs speech-to-text, asks Loom to route the text to
   the locked agent, and waits for that agent's reply.
5. The service synthesizes the reply and returns audio for playback on the pad.

Loom exposes a best-effort proxy for the service at `/api/loompad/health` and
`/api/loompad/connect`. It reads `LOOMPAD_BACKEND_URL`, defaulting to
`http://127.0.0.1:8080`; the desktop UI uses it to report whether the backend
is reachable. The expected backend is responsible for STT → agent dispatch →
TTS. Its implementation, audio codec, authentication, Wi-Fi provisioning, and
speaker/amplifier wiring are not yet shipped here.

For local operation, run Loom and the voice backend on the same trusted machine
or tailnet, keep pairing credentials out of firmware source, and require a
deliberate press-and-hold before recording. The microphone should be visibly
indicated as active by firmware or LEDs before audio leaves the device.
