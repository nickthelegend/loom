# Orchestrator Pad — firmware

ESP32-S3 firmware for the hold-to-talk build. Select an agent with a key, hold
the mic key and talk, hear the agent answer — all over Wi-Fi to the
[backend](../backend) on your Mac. Wi-Fi and the backend address are set once
through a captive portal and remembered in flash; **no recompile to change
networks**, and **no potentiometer on this build** (the effort dial is omitted).

Sketch: [`orchestrator_pad/orchestrator_pad.ino`](orchestrator_pad/orchestrator_pad.ino).

## What it does

1. **Provision** — first boot (or hold **K1** at power-on) raises a Wi-Fi
   access point, **`LoomPad-Setup`**. Join it from a phone/laptop; a captive
   page lists nearby networks and asks for the **backend URL** and a **pad
   token**. Save → the pad joins your Wi-Fi and stores everything in NVS.
2. **Connect** — it starts a telnet debug server, checks the backend's
   `/health`, and asks the backend to **speak "connected"** through the amp.
3. **Run** — an agent key locks that agent in Loom (a handoff, visible in the
   thread) and lights the LED its colour. Hold **K1** to record; release to send
   the audio to that agent and play its spoken reply.

## Hardware & wiring

ESP32-S3-DevKitC-1 (N16R8 — 16 MB flash / 8 MB PSRAM). No pot, no diodes.

<div align="center">
<img src="../docs/images/circuit.png" alt="Orchestrator Pad wiring diagram — 4×4 key matrix, INMP441 mic, MAX98357A amp + speaker, on an ESP32-S3-WROOM-1" width="920">
</div>

The full wiring at a glance: the 4×4 matrix (rows `G10–G13`, columns
`G14/G8/G17/G18`), the INMP441 mic and MAX98357A amp on I2S, and the (optional)
pot. The tables below are the same thing, cell by cell — all grounds are common.

**Mic — INMP441 (I2S RX):** `VDD→3V3`, `GND→GND`, `L/R→GND`

| INMP441 | SCK | WS | SD |
|---|---|---|---|
| GPIO | **5** | **4** | **6** |

**Amp — MAX98357A (I2S TX):** `Vin→3V3`, `GND→GND`, `SD→3V3` (leave SD high to enable)

| MAX98357A | BCLK | LRC | DIN |
|---|---|---|---|
| GPIO | **15** | **16** | **7** |

**4×4 key matrix** (rows are `INPUT_PULLUP`, columns driven low one at a time —
no diodes needed):

| | Col0 | Col1 | Col2 | Col3 |
|---|---|---|---|---|
| **Rows →** | GPIO 14 | GPIO 8 | GPIO 17 | GPIO 18 |
| Row0 · GPIO 10 | **K1 mic** | K2 | K3 | — |
| Row1 · GPIO 11 | K4 | K5 | K6 | K7 |
| Row2 · GPIO 12 | K8 | K9 | K10 | K11 |
| Row3 · GPIO 13 | K12 | K13 | K14 | — |

**Status LED:** onboard WS2812 on **GPIO 48**.

All pins live in [`orchestrator_pad/config.h`](orchestrator_pad/config.h) — change
them there if your wiring differs.

## Key map

Edit [`orchestrator_pad/agents.h`](orchestrator_pad/agents.h) to match your
keycaps. As shipped:

| Key | Role | Agent | LED |
|---|---|---|---|
| **K1** | 🎤 hold to talk | — | red while recording |
| K2 | agent | `claude-code` | amber |
| K3 | agent | `opencode` | teal |
| K4 | agent | `codex` | green |
| K5 | agent | `grok-code` | white |
| K6 | agent | `antigravity` | blue |
| K7 | agent | `kiro` | purple |

K8–K14 are spare. K1 doubles as the **re-provision** key: hold it at power-on to
wipe saved Wi-Fi and re-open the portal.

### Status-LED colours

| Colour | Meaning |
|---|---|
| blue | booting |
| cyan / magenta | connecting / setup portal open |
| green | connected & ready |
| agent colour | that agent is selected (idle) |
| red | recording (or an error) |
| amber | thinking (waiting on the reply) |

## Flashing

**Libraries** (Arduino IDE → Library Manager):

- **WiFiManager** by *tzapu* — the captive portal.
- `ESP_I2S`, `WiFi`, `HTTPClient`, `Preferences` ship with the **arduino-esp32
  core 3.x** — nothing to install, but you do need core 3.x (Boards Manager →
  "esp32" by Espressif, ≥ 3.0).

**Board settings** (Tools menu) — the three starred ones matter:

- Board: **ESP32S3 Dev Module**
- ⭐ **PSRAM: `OPI PSRAM`** — the record buffer is `ps_malloc`'d; without this it
  fails to allocate and the mic won't record.
- ⭐ **USB CDC On Boot: `Enabled`** — so the Serial monitor works over USB-C.
- ⭐ **Partition Scheme: `Huge APP (3MB No OTA/1MB SPIFFS)`** — the TLS stack
  pushes the build to ~90 % of the *default* 1.3 MB app partition (it fits, but
  barely). Huge APP drops it to ~37 %. Flash Size: `16MB`.

> Verified: this compiles clean against **esp32 core 3.3.10 + WiFiManager 2.0.17**
> for `esp32s3` (OPI PSRAM, USB-CDC) — 1.18 MB flash, 48 KB RAM, no warnings in
> the sketch.

**Steps:**

1. Open [`orchestrator_pad/orchestrator_pad.ino`](orchestrator_pad/orchestrator_pad.ino).
2. Install WiFiManager, set the board options above, pick the port, **Upload**.
3. First boot: join the **`LoomPad-Setup`** Wi-Fi from your phone. If the portal
   doesn't pop up, browse to `http://192.168.4.1`.
4. Pick your Wi-Fi, enter the **backend URL** and **pad token** (below), save.
5. It joins, says "connected," and you're ready: **press an agent key, then hold
   K1 to talk.**

### Backend URL & token

One field decides where — and how — the pad reaches the backend; the **scheme
picks the transport**:

| You're… | Enter | Token |
|---|---|---|
| on the same Wi-Fi as the Mac | `http://<mac-lan-ip>:8080` (e.g. `http://192.168.1.20:8080`) | blank is fine on a trusted LAN |
| anywhere / the pad moves around | `https://<machine>.<tailnet>.ts.net` (Tailscale Funnel) | **required** — Funnel is public |

- **`http://…`** → plain connection. Use the Mac's **LAN IP**, *not* its
  `tailscale ip` (`100.x`) — a bare ESP32 can't route to a tailnet address.
- **`https://…ts.net`** → TLS, with the Let's Encrypt root pinned (the pad
  verifies the cert, so the token can't be MITM'd). Set the same `PAD_TOKEN` on
  the backend. See the [backend README](../backend/README.md#pointing-the-pad-at-it)
  for the one-time `tailscale funnel 8080` setup.

Change either later without reflashing: `reset-wifi` over telnet (or hold **K1**
at power-on) re-opens the portal.

## Telnet debug

The S3's USB-CDC serial can be flaky, so the pad mirrors its logs to a telnet
server and takes commands back — no cable needed:

```
telnet <pad-ip> 23
```

| Command | Does |
|---|---|
| `help` | list commands |
| `status` | Wi-Fi / IP / RSSI / heap / PSRAM / backend / selected agent |
| `ip` · `heap` · `agent` | quick reads |
| `select <agent>` | lock an agent (same as pressing its key) |
| `say <text>` | speak text through the amp (tests the backend + amp) |
| `talk` | hands-free: record ~4 s and send (tests the mic without a key) |
| `reset-wifi` | wipe Wi-Fi + settings and reboot into the portal |
| `reboot` | restart |

`say hello` and `talk` are the fastest way to prove the audio path end to end.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No serial output | Set **USB CDC On Boot: Enabled**, re-upload |
| "PSRAM alloc failed" in the log | Set **PSRAM: OPI PSRAM** |
| "backend not reachable" | Backend running? Right URL? On `http://`, use the Mac's **LAN IP** not `100.x`. Fix with `reset-wifi` |
| Works on LAN, fails on the `ts.net` URL | Is `tailscale funnel` running? Does `PAD_TOKEN` match on both sides? (a 401 means the token's wrong/blank) |
| Portal never opens | Forget/rejoin `LoomPad-Setup`, or browse to `192.168.4.1` |
| Amp silent | Check `DIN/BCLK/LRC` wiring and that the amp's **SD pin is tied to 3V3** |
| Mic captures nothing | Check `SCK/WS/SD`, and tie the INMP441 **L/R pin to GND** |
| Keys wrong / swapped | Fix the pin arrays in `config.h` and the grid in `agents.h` |

See the [backend README](../backend) for the server it talks to.
