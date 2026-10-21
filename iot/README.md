# IoT Tracker — ESP32 + GPS (GY-NEO6MV2 or NEO-M8N)

GPS tracker that posts HMAC-signed coordinates to `POST /api/v1/gps/ingest` and, while it
has no fix, its GPS status to `POST /api/v1/gps/status`.

- **Sketch:** `firmware/armory_tracker/` (open `armory_tracker.ino`)
- **No hardware yet?** `simulator/gps_simulator.py`
- **Buying parts, soldering, enclosure:** `HARDWARE_GUIDE.md`, `ESP32_IOT_BUILD_GUIDE.txt`
- **Superseded sketches:** `firmware/reference/` (reference only, not compiled)

---

## 1. Components and how they link together

| # | Component | Links to | Via |
|---|---|---|---|
| 1 | GPS satellites | GPS module antenna | 1575.42 MHz radio |
| 2 | GPS module (NEO-6M / NEO-M8N) | ESP32 | UART2 serial on D18/D19, 9600 baud |
| 3 | ESP32 | Wi-Fi access point | 2.4 GHz Wi-Fi |
| 4 | ESP32 | Laravel API | HTTP(S) POST, HMAC-SHA256 signed |
| 5 | Laravel API | `gps_logs` table | Eloquent, inside a DB transaction |
| 6 | Laravel API | Next.js live map | `GET /api/v1/gps/live` + SSE |

```
[satellites] --radio--> [GPS module] --UART--> [ESP32] --WiFi--> [Laravel] --> [DB] --> [dashboard]
```

Only link 2 is physical wiring. Everything after it is configuration.

---

## 2. Wire the GPS module to the ESP32

Power the ESP32 from USB only while wiring. Never wire with a battery attached.

The same four wires work for a **GY-NEO6MV2 (NEO-6M)** and a **NEO-M8N** board. Go by the
labels printed next to the GPS pins: the pin order differs between boards.

| ESP32 pin | GPS pin | Wire |
|---|---|---|
| `3V3` | `VCC` | red |
| `GND` | `GND` | black |
| `D18` (GPIO18) | `TX` | yellow |
| `D19` (GPIO19) | `RX` | orange |

```
   ESP32                      GPS (NEO-6M / NEO-M8N)
 ┌─────────┐                 ┌────────────┐
 │ 3V3   ●─┼─────────────────┼─● VCC      │
 │ GND   ●─┼─────────────────┼─● GND      │
 │ D18   ●─┼─────────────────┼─● TX       │   <- crossover
 │ D19   ●─┼─────────────────┼─● RX       │   <- crossover
 │  [USB]  │                 │ [antenna]  │
 └─────────┘                 └────────────┘
```

The ESP32-WROOM-32 board used here has no GPIO16/17 header pins, so the GPS is on D18/D19
(`GPS_RX_PIN 18`, `GPS_TX_PIN 19` in `config.h`).

Things that break this step:

- **The GPS header pins must be soldered.** These modules ship with the pin strip loose.
  Unsoldered pins touch only by chance: the power LED lights, but the data (TX) drops out.
  Keep each joint a small shiny cone and make sure no solder joins two pins.
- **Do not push the GPS board's pins into the breadboard** in one row: the breadboard joins them.
- **TX/RX must cross.** GPS `TX` goes to ESP32 **RX** (D18). Straight-through wiring gives no data.
- **Use `3V3`.** The board's regulator accepts 3.3–5 V and its UART is 3.3 V either way.
- **The antenna must face the sky** (flat ceramic side up), with its small round plug clicked
  fully onto the board. No metal above it. GPS does not get a fix indoors.

The tracker's Serial Monitor tells a wiring fault from the sky:
`[gps] NO DATA from the GPS module` = a wire or solder joint (TX → D18, GND);
`[gps] no fix yet (satellites in view=N ...)` = wiring is fine, it needs open sky.

Optional battery monitor (only if you set `HAS_BATTERY_MONITOR 1`):

```
Battery+ ──[100kΩ]──┬──[100kΩ]── GND
                    └── GPIO34
```

Optional tamper switch (only if you set `HAS_TAMPER_SWITCH 1`): normally-closed reed
switch between `GPIO27` and `GND`. Detected and logged on the device; the ingest API
has no tamper field yet, so nothing is transmitted for it.

---

## 3. Link the backend

In `backend/.env`:

```env
IOT_HMAC_SECRET=<32+ random characters>
ARMORY_GPS_MAX_AGE_SECONDS=300
ARMORY_GPS_FUTURE_TOLERANCE_SECONDS=30
```

Then start the API bound to all interfaces so the ESP32 can reach it, and allow
the port through Windows Firewall:

```powershell
cd backend
php artisan config:clear
php artisan serve --host 0.0.0.0 --port 8000
```

Get the LAN IP the ESP32 will use (`ipconfig` → IPv4 Address, e.g. `192.168.1.100`).
`localhost` and `127.0.0.1` do not work from the device.

---

## 4. Link the firmware

```powershell
cd iot\firmware\armory_tracker
Copy-Item config.example.h config.h
```

Edit `config.h`:

| Setting | Value |
|---|---|
| `WIFI_SSID` / `WIFI_PASS` | your 2.4 GHz network |
| `API_URL` | `http://<LAN-IP>:8000/api/v1/gps/ingest` |
| `USE_HTTPS` | `0` on LAN, `1` with a real certificate |
| `DEVICE_ID` | unique per tracker |
| `EQUIPMENT_ID` | an existing `firearm_equipment.equipment_id` |
| `HMAC_SECRET` | byte-for-byte equal to `IOT_HMAC_SECRET` |

`config.h` is git-ignored, so the Wi-Fi password and shared secret stay out of the repo.

Arduino IDE 2.x: install the **esp32** board package, plus the **TinyGPSPlus** and
**ArduinoJson** libraries. Board **ESP32 Dev Module**, then Upload and open Serial
Monitor at **115200**.

---

## 5. Make the firearm eligible before expecting data

The API accepts a fix only when the firearm is genuinely issued. In the dashboard:

1. Issue the firearm whose `equipment_id` matches `config.h`.
2. Keep that transaction **Active** or **Overdue**.
3. Keep **GPS tracking enabled** on the transaction.

Skipping this returns `409` even when the wiring and signature are perfect.

---

## 6. Verify end to end

Take the device outdoors and watch Serial Monitor:

```
[gps] UART2 rx=18 tx=19 @9600 baud
[wifi] connected  ip=192.168.1.50  rssi=-52 dBm  channel 11 (2.4 GHz)
[gps] no fix yet (satellites in view=13, used=3)  <- locking on, keep it still
[link] laptop reachable at 192.168.1.100 - it shows this status live, also without USB
[gps] 8.484512, 124.657089  sats=8  2026-09-13T04:21:30Z
[post] HTTP 200  {"ok":true,"gps_log_id":15,"inside_geofence":true,"inside_armory":false}
```

Without a USB cable (on a power bank), the same status shows over Wi-Fi in the setup
window's **Watch live** and in `iot\setup-tracker.bat monitor`. Until it has a fix,
the tracker sends its status line to `POST /api/v1/gps/status` every 10 s. The backend
writes it, and every position, to `backend\storage\logs\trackers.log`. If the hotspot
gives the laptop a new address, the tracker finds the laptop again by itself
(`[link] laptop found at ...`).

**Save without USB.** With the tracker on the hotspot, **Save to tracker** builds the
firmware and leaves it on the backend (`backend\storage\app\firmware`, removed once
installed). The tracker's next report is answered with an update offer. The tracker
downloads it with a signed request, checks its MD5, installs it and restarts. This needs
firmware that supports updates over Wi-Fi, so the first upload of such firmware still
goes over USB.

Then open the dashboard live map as a staff role and confirm the marker appears.
GPS pages are restricted to Administrator, Command Officer, S4 Officer, and Armory
Custodian; a Personnel account gets `403`.

---

## 7. Payload and signature

`X-Armory-Signature` is the lowercase hex HMAC-SHA256 of the **exact raw body**,
keyed with the shared secret. Re-serializing the JSON before signing breaks it.

```json
{
  "equipment_id": 1,
  "device_id": "ESP32-001",
  "captured_at": "2026-09-13T04:21:30Z",
  "latitude": 8.484460,
  "longitude": 124.657010,
  "accuracy_meters": 4.5,
  "speed_mps": 0.0,
  "heading_deg": 152.3,
  "altitude_meters": 240.7,
  "satellites": 9
}
```

`transaction_id` is optional. Omit it and the server resolves the current
transaction itself; send a mismatched one and the fix is rejected.

---

## 8. Response codes

| Code | Meaning | Action |
|---|---|---|
| `200` | Stored | none |
| `401` | Signature mismatch | make `HMAC_SECRET` equal `IOT_HMAC_SECRET` |
| `409` | No Active/Overdue transaction with tracking on, or duplicate/out-of-order fix | issue the firearm; check the clock |
| `422` | Invalid field, or timestamp too old/too far ahead | check GPS time sync |
| `429` | Rate limited (60 req/s bucket) | slow down |
| `503` | MySQL stopped, or `IOT_HMAC_SECRET` not set on the server | start MySQL; or set the secret, then `php artisan config:clear` |

The firmware retries only `429`, `5xx`, and transport errors. Configuration
failures such as `401` and `409` are logged and dropped instead of looping.

---

## 9. Timestamp rules that matter on the device

The API enforces replay and ordering protection, so the firmware:

- transmits only after the receiver reports a valid UTC date (year ≥ 2024), because
  an unsynced clock produces a `422`;
- never repeats or goes backwards on `captured_at`, because `(device_id, captured_at)`
  is unique and must increase;
- queues at most 8 fixes in RAM while the link is down and **discards** any fix older
  than `MAX_FIX_AGE_SECONDS`, since the server would reject it anyway.

A reboot clears that queue by design. Long-term offline storage would only produce
payloads too stale to be accepted.

---

## 10. No hardware? Use the simulator

```powershell
cd iot\simulator
python gps_simulator.py --equipment 1 --secret "<same as IOT_HMAC_SECRET>" --count 20 --interval 5
```

The firearm still needs an Active/Overdue transaction with GPS tracking enabled.
