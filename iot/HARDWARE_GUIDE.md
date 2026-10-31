# IoT Hardware Guide — Complete Step-by-Step

## For: Real-Time GPS-Based Firearm Tracking System (ArmoryDB)

This guide walks you through everything from buying parts to having a working GPS tracker that sends real-time coordinates to your Laravel backend.

---

## TABLE OF CONTENTS

1. [Parts List (What to Buy)](#1-parts-list)
2. [Tools You Need](#2-tools-you-need)
3. [Understanding the Components](#3-understanding-the-components)
4. [Wiring Diagram](#4-wiring-diagram)
5. [Software Setup (Arduino IDE)](#5-software-setup)
6. [Configuring the Firmware](#6-configuring-the-firmware)
7. [Uploading to ESP32](#7-uploading-to-esp32)
8. [Testing Without Hardware (Simulator)](#8-testing-without-hardware)
9. [Testing With Hardware](#9-testing-with-hardware)
10. [Troubleshooting](#10-troubleshooting)
11. [Enclosure & Deployment](#11-enclosure--deployment)

---

## 1. PARTS LIST

| # | Component | Approx. Price (PHP) | Where to Buy |
|---|-----------|---------------------|--------------|
| 1 | ESP32-WROOM-32 DevKit (30-pin) | ₱250–350 | Shopee, Lazada, Makerlab Electronics |
| 2 | GY-NEO6MV2 GPS Module (with antenna) | ₱180–280 | Shopee, Lazada, Makerlab Electronics |
| 3 | Jumper Wires (Male-to-Female, 10pcs) | ₱30–50 | Any electronics store |
| 4 | Micro-USB Cable (data cable, not charge-only) | ₱50–80 | Any store |
| 5 | Breadboard (half-size is fine) | ₱50–80 | Electronics store |
| 6 | 3.7V Li-Po Battery (optional, for portable use) | ₱150–250 | Shopee |
| 7 | TP4056 Charging Module (optional) | ₱25–40 | Shopee |

**Total estimated cost: ₱700–1,100** (basic setup without battery)

### Optional Components

| Component | Purpose | Price |
|-----------|---------|-------|
| Arduino Nano | Power management / watchdog (manuscript mentions it) | ₱150–200 |
| Reed Switch (NC) | Tamper detection | ₱20–30 |
| 2x 10kΩ Resistors | Voltage divider for battery monitoring | ₱5 |
| Small project enclosure | Housing the tracker | ₱50–100 |

> **Note:** For the capstone demo, you only need the ESP32 + GPS module. The Arduino Nano and battery are for a production-ready portable version.

---

## 2. TOOLS YOU NEED

- Computer with USB port (Windows)
- Arduino IDE 2.x (free download)
- Soldering iron (only if you want permanent connections — not needed for breadboard)
- Internet connection (for the ESP32 to send data via WiFi)

---

## 3. UNDERSTANDING THE COMPONENTS

### ESP32-WROOM-32
- This is the "brain" — a microcontroller with built-in WiFi and Bluetooth
- It reads GPS data, builds a JSON payload, signs it with HMAC, and sends it to your Laravel API via HTTPS
- It has multiple UART (serial) ports — we use UART2 to talk to the GPS module

### GY-NEO6MV2 (GPS Module)
- Contains a u-blox NEO-6M GPS chip
- Receives satellite signals and outputs NMEA sentences (text data with lat/lon/time)
- The ceramic antenna (the square thing on top) must face the sky
- Takes 30–90 seconds to get a "fix" (first location) when powered on outdoors
- Accuracy: 2.5–10 meters

### How They Work Together
```
[Satellites] → [GPS Module] → (Serial/UART) → [ESP32] → (WiFi/HTTPS) → [Laravel API]
```

---

## 4. WIRING DIAGRAM

### Pin Connections (ESP32 ↔ GPS module: GY-NEO6MV2 or NEO-M8N)

```
┌─────────────────┐          ┌──────────────────┐
│    ESP32         │          │ GPS (6M / M8N)   │
│                  │          │                  │
│  3V3  ──────────┼──────────┼── VCC            │
│  GND  ──────────┼──────────┼── GND            │
│  D18 (GPIO18) ──┼──────────┼── TX             │
│  D19 (GPIO19) ──┼──────────┼── RX             │
│                  │          │                  │
└─────────────────┘          └──────────────────┘
```

### Step-by-Step Wiring

1. **Place the ESP32** on the breadboard (straddle the center gap)
2. **Place the GPS module** on the breadboard next to it (or use jumper wires)
3. **Connect power:**
   - ESP32 `3V3` pin → GPS module `VCC` pin (red wire)
   - ESP32 `GND` pin → GPS module `GND` pin (black wire)
4. **Connect data:**
   - ESP32 `D18` → GPS module `TX` pin (yellow/green wire)
   - ESP32 `D19` → GPS module `RX` pin (orange/blue wire)

> **IMPORTANT:** GPS TX goes to ESP32 RX (D18), and GPS RX goes to ESP32 TX (D19). This is a "crossover" — TX always connects to RX.
>
> The ESP32-WROOM-32 board used here has no GPIO16/17 header pins, which is why the GPS is on D18/D19 (`GPS_RX_PIN 18`, `GPS_TX_PIN 19` in `config.h`). Go by the labels printed next to the GPS pins: the pin order differs between the NEO-6M and NEO-M8N boards.

> **SOLDER THE GPS HEADER PINS.** GPS modules ship with the pin strip loose. Unsoldered pins touch only by chance: the power LED lights (even the fix LED blinks) while the data on TX never reaches the ESP32. Each joint should be a small shiny cone, and no solder may join two pins. Do not push the GPS board's pins into one breadboard row either: the breadboard connects them.

### Visual Layout on Breadboard

```
    ┌───────────────────────────────────────┐
    │           BREADBOARD                   │
    │                                        │
    │  ┌──────────┐      ┌──────────────┐   │
    │  │  ESP32   │      │  GPS Module  │   │
    │  │          │      │              │   │
    │  │ 3V3  ●───┼──────┼───● VCC      │   │
    │  │ GND  ●───┼──────┼───● GND      │   │
    │  │ D18  ●───┼──────┼───● TX       │   │
    │  │ D19  ●───┼──────┼───● RX       │   │
    │  │          │      │              │   │
    │  │   [USB]  │      │  [Antenna]   │   │
    │  └──────────┘      └──────────────┘   │
    │                                        │
    └───────────────────────────────────────┘
```

### Optional: Battery Monitoring (if using Li-Po)

```
Battery+ ──── [10kΩ] ──┬── [10kΩ] ──── GND
                        │
                        └──── ESP32 GPIO34 (ADC)
```

---

## 5. SOFTWARE SETUP (Arduino IDE)

### Step 5.1: Install Arduino IDE

1. Download from: https://www.arduino.cc/en/software
2. Install Arduino IDE 2.x (the newer version)
3. Open it

### Step 5.2: Add ESP32 Board Support

1. Go to **File → Preferences**
2. In "Additional Board Manager URLs", paste:
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. Click OK
4. Go to **Tools → Board → Boards Manager**
5. Search for **"esp32"**
6. Install **"esp32 by Espressif Systems"** (version 2.x or 3.x)
7. Wait for download (it's ~200MB)

### Step 5.3: Install Required Libraries

Go to **Tools → Manage Libraries** (or Sketch → Include Library → Manage Libraries):

1. Search and install **"TinyGPSPlus"** by Mikal Hart
2. Search and install **"ArduinoJson"** by Benoit Blanchon (version 6.x or 7.x)

> `mbedtls` (for HMAC-SHA256) is already included with the ESP32 board package — no separate install needed.

### Step 5.4: Select Your Board

1. Connect ESP32 to your computer via USB cable
2. Go to **Tools → Board** → select **"ESP32 Dev Module"**
3. Go to **Tools → Port** → select the COM port that appeared (e.g., COM3, COM5)
   - If no port appears, you may need to install the CP2102 or CH340 USB driver:
     - CP2102: https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers
     - CH340: https://sparks.gogo.co.nz/ch340.html
4. Leave other settings at default:
   - Upload Speed: 921600
   - Flash Frequency: 80MHz
   - Flash Mode: QIO
   - Flash Size: 4MB

---

## 6. CONFIGURING THE FIRMWARE

Open the sketch `iot/firmware/armory_tracker/armory_tracker.ino` in Arduino IDE.

Settings live in a separate `config.h` so your Wi-Fi password and shared secret are
never committed to git. Create it once by copying the template:

```powershell
cd iot\firmware\armory_tracker
Copy-Item config.example.h config.h
```

### Edit these values in `config.h`:

```cpp
// Your WiFi network (must be 2.4GHz — ESP32 does not support 5GHz)
#define WIFI_SSID "YourWiFiName"          // ← change this
#define WIFI_PASS "YourWiFiPassword"      // ← change this

// Your Laravel backend URL.
// Use your computer's LAN IP, not localhost — the ESP32 cannot reach localhost.
// Find it with: ipconfig in CMD → IPv4 Address (e.g., 192.168.1.100)
#define API_URL "http://192.168.1.100:8000/api/v1/gps/ingest"   // ← change this

// Device identification
#define DEVICE_ID "ESP32-001"   // unique per tracker
#define EQUIPMENT_ID 1          // must match firearm_equipment.equipment_id

// MUST match IOT_HMAC_SECRET in backend/.env
#define HMAC_SECRET "CHANGE_ME_iot_shared_secret_at_least_32_chars_long_!!"  // ← change this
```

### Choosing HTTP or HTTPS

No code editing is needed. Flip one switch in `config.h`:

```cpp
#define USE_HTTPS 0   // 0 = plain HTTP for local XAMPP / php artisan serve
                      // 1 = HTTPS for deployment
```

When `USE_HTTPS` is `1`, paste your CA into `ROOT_CA_CERT`. For a first lab test over
TLS without a proper CA you may set `ALLOW_INSECURE_TLS 1`, which skips certificate
validation — never use that outside the lab.

### Finding Your Computer's IP Address

1. Open CMD
2. Type: `ipconfig`
3. Look for "IPv4 Address" under your WiFi adapter (e.g., `192.168.1.100`)
4. Use that IP in `API_URL`

### Matching the HMAC Secret

The `HMAC_SECRET` in the firmware MUST exactly match the `IOT_HMAC_SECRET` in your Laravel `.env` file:

```env
# In backend/.env
IOT_HMAC_SECRET=CHANGE_ME_iot_shared_secret_at_least_32_chars_long_!!
```

---

## 7. UPLOADING TO ESP32

> **Before uploading:** open `armory_tracker.ino` specifically. Arduino compiles every
> `.ino` file inside a sketch folder as one program, so never place a second sketch
> beside it. The earlier `firmware.ino` and `firmware_dev.ino` are kept in
> `firmware/reference/` with a `.txt` extension for exactly this reason.

1. Make sure ESP32 is connected via USB
2. Make sure the correct Board and Port are selected in Tools menu
3. Click the **Upload** button (→ arrow icon) or press Ctrl+U
4. Wait for compilation (first time takes 1–2 minutes)
5. You'll see "Connecting..." — some ESP32 boards require you to **hold the BOOT button** while it connects
6. Once uploaded, open **Serial Monitor** (Tools → Serial Monitor)
7. Set baud rate to **115200**
8. You should see:

```
[WiFi] Connecting.....
[WiFi] OK · IP 192.168.1.50 · RSSI -45
[BOOT] ArmoryDB GPS firmware ready.
[GPS] No fix yet.
[GPS] No fix yet.
[GPS] 8.484460, 124.657010 sats=7
[POST] 200  {"ok":true,"gps_log_id":1,"inside_geofence":true,"inside_armory":true}
```

### If GPS says "No fix yet"

- **You must be outdoors** or near a window with clear sky view
- The GPS antenna (ceramic square) must face UP toward the sky
- First fix takes 30–90 seconds (cold start can take up to 3 minutes)
- Indoors, GPS will NOT work (this is normal)

---

## 8. TESTING WITHOUT HARDWARE (Simulator)

If you don't have the hardware yet, or want to test the software side first, use the Python simulator:

### Prerequisites

- Python 3.x installed (comes with most systems, or download from python.org)

### Running the Simulator

1. Make sure your Laravel backend is running:
   ```
   cd d:\Clients\Realtime-GPS\backend
   php artisan serve
   ```

2. Open a new terminal and run:
   ```
   cd d:\Clients\Realtime-GPS\iot\simulator
   python gps_simulator.py --equipment 1 --secret "CHANGE_ME_iot_shared_secret_at_least_32_chars_long_!!" --count 20 --interval 5
   ```

   Parameters:
   - `--equipment 1` → simulates GPS for firearm with equipment_id=1
   - `--secret` → must match your `.env` IOT_HMAC_SECRET
   - `--count 20` → sends 20 GPS fixes then stops
   - `--interval 5` → sends every 5 seconds (faster for testing)

3. You should see:
   ```
   [sim] Pushing fixes for equipment_id=1 → http://127.0.0.1:8000/api/v1/gps/ingest
   [sim   1] HTTP 200 · {"ok":true,"gps_log_id":1,"inside_geofence":true}
   [sim   2] HTTP 200 · {"ok":true,"gps_log_id":2,"inside_geofence":true}
   ...
   ```

4. Open your frontend dashboard — you should see the firearm moving on the live map!

> **Important:** the API accepts a fix only when the firearm is genuinely issued.
> Before running the simulator, issue the firearm with the matching `equipment_id`
> from the Transactions page, keep that transaction **Active** or **Overdue**, and
> keep **GPS tracking enabled** on it. Otherwise every request returns `409`.
>
> View the live map with a staff account (Administrator, Command Officer, S4 Officer,
> or Armory Custodian). GPS endpoints return `403` for Personnel accounts.

---

## 9. TESTING WITH HARDWARE

### Pre-flight Checklist

- [ ] ESP32 + GPS module wired correctly (TX/RX crossed, VCC on 3V3)
- [ ] `config.h` created from `config.example.h` and filled in
- [ ] Firmware uploaded with correct WiFi credentials
- [ ] Laravel reachable on the LAN: `php artisan serve --host 0.0.0.0 --port 8000`
- [ ] Windows Firewall allows inbound port 8000
- [ ] ESP32 and your computer are on the same 2.4GHz WiFi network
- [ ] `API_URL` uses the computer's LAN IP, not localhost
- [ ] The firearm with the matching `equipment_id` has an **Active** or **Overdue**
      transaction with **GPS tracking enabled**
- [ ] `HMAC_SECRET` matches `IOT_HMAC_SECRET` exactly (run `php artisan config:clear`
      after editing `.env`)
- [ ] GPS antenna faces the sky, device is outdoors

### Test Procedure

1. Power on the ESP32 (switch on the 21700 battery, or plug USB into the computer)
2. Open Serial Monitor at 115200 baud
3. Wait for WiFi connection (should take 2–5 seconds)
4. Take the device **outdoors** or near a window
5. Wait for GPS fix (30–90 seconds, you'll see "No fix yet" until then)
6. Once you see coordinates printing, check your dashboard
7. The firearm should appear on the live GPS map with a green dot

### What Success Looks Like

Serial Monitor:
```
[WiFi] OK · IP 192.168.1.50 · RSSI -52
[BOOT] ArmoryDB GPS firmware ready.
[GPS] No fix yet.
[GPS] No fix yet.
[GPS] 8.484512, 124.657089 sats=8
[POST] 200  {"ok":true,"gps_log_id":15,"inside_geofence":true,"inside_armory":false}
[GPS] 8.484518, 124.657095 sats=9
[POST] 200  {"ok":true,"gps_log_id":16,"inside_geofence":true,"inside_armory":false}
```

Dashboard:
- Live GPS map shows the firearm's position
- Position updates every 30 seconds
- On a trip to its assigned destination, leaving it before 90 minutes, entering another zone, or leaving
  the camp again before the firearm is returned triggers a security alert with an alarm sound

---

## 10. TROUBLESHOOTING

### "No port available" in Arduino IDE
- Install the USB driver (CP2102 or CH340 depending on your ESP32 board)
- Try a different USB cable (some are charge-only, no data)
- Try a different USB port

### WiFi won't connect
- Double-check SSID and password (case-sensitive!)
- Make sure your WiFi is 2.4GHz (ESP32 does NOT support 5GHz)
- Move closer to the router

### GPS never gets a fix
- You MUST be outdoors or at a window with sky view
- The antenna must face UP
- Wait at least 3 minutes for cold start
- If Serial Monitor says `[gps] NO DATA from the GPS module`, it is the wiring, not the sky: check GPS TX → ESP32 D18 and GND, and that the GPS header pins are soldered with no solder joining two pins
- `[gps] no fix yet (satellites in view=N ...)` means the wiring is fine and it needs more open sky
- Check wiring: GPS TX → ESP32 D18, GPS RX → ESP32 D19

### POST returns 401 (Invalid signature)
- HMAC_SECRET in firmware must EXACTLY match IOT_HMAC_SECRET in .env
- No extra spaces or newlines
- Both must be the same string, character for character
- Run `php artisan config:clear` after changing `.env`

### POST returns 409 (Conflict)
Three separate causes, all reported on this code:
- The firearm has no **Active** or **Overdue** transaction → issue it first
- That transaction has **GPS tracking disabled** → re-enable it
- The fix is a **duplicate or out of order** for this `device_id`. Timestamps have
  1-second resolution and must strictly increase, so never run two trackers with the
  same `DEVICE_ID`, and keep `TX_INTERVAL_MS` at 1000 or more.

### POST returns 422 (Timestamp rejected)
- The device clock is unsynced. Wait for a real GPS fix so UTC date/time is valid.
- A queued fix aged past `ARMORY_GPS_MAX_AGE_SECONDS` (default 300 s) and is refused.
  Keep `MAX_FIX_AGE_SECONDS` in `config.h` below the server value.

### POST returns 503
- `IOT_HMAC_SECRET` is empty on the server. Set it in `backend/.env`.

### Live map shows nothing but POSTs return 200
- You are signed in as **Personnel**. GPS endpoints are staff-only and return `403`.
  Use an Administrator, Command Officer, S4 Officer, or Armory Custodian account.

### POST returns connection refused
- Make sure `php artisan serve` is running
- Use your computer's actual IP (not `localhost` or `127.0.0.1` — the ESP32 can't reach those)
- Make sure ESP32 and computer are on the same WiFi network
- Check Windows Firewall isn't blocking port 8000

### Compilation errors
- Make sure you installed the ESP32 board package
- Make sure TinyGPSPlus and ArduinoJson libraries are installed
- Select "ESP32 Dev Module" as the board

---

## 11. ENCLOSURE & DEPLOYMENT

For the capstone demo, a breadboard setup is fine. For a more polished presentation:

### Simple Enclosure

1. Use a small plastic project box (₱50–100 from electronics stores)
2. Cut a hole for the USB port
3. Mount the GPS antenna facing up (tape it to the lid)
4. Secure components with hot glue or double-sided tape

### Battery-Powered (Portable)

For a truly portable tracker attached to a firearm:

1. Add a 3.7V Li-Po battery (1000–2000mAh)
2. Connect through a TP4056 charging module
3. TP4056 OUT+ → ESP32 VIN (or 5V pin)
4. TP4056 OUT- → ESP32 GND
5. Battery lasts approximately:
   - 1000mAh ÷ ~80mA average = ~12 hours
   - 2000mAh ÷ ~80mA average = ~24 hours

### Deployment Checklist for Demo Day

- [ ] Firmware flashed with correct WiFi (demo venue WiFi)
- [ ] Backend deployed and accessible
- [ ] At least one firearm issued in the system
- [ ] Battery charged (if portable)
- [ ] Test GPS fix at the venue beforehand
- [ ] Have the simulator ready as backup (in case GPS doesn't work indoors)

---

## QUICK REFERENCE CARD

```
┌─────────────────────────────────────────────────────┐
│  ArmoryDB GPS Tracker — Quick Reference             │
├─────────────────────────────────────────────────────┤
│  Sketch:    firmware/armory_tracker/                │
│  Board:     ESP32 Dev Module                        │
│  GPS:       NEO-6M / NEO-M8N on UART2 (D18/D19)    │
│  Baud:      9600 (GPS) / 115200 (Serial Monitor)   │
│  Interval:  30 seconds                             │
│  Protocol:  HTTP(S) POST + HMAC-SHA256 signature    │
│  Endpoint:  /api/v1/gps/ingest                      │
│  Header:    X-Armory-Signature: <hex hmac>          │
│  Offline:   8 fixes in RAM, dropped once too stale  │
│  Power:     USB 5V or 3.7V Li-Po via TP4056         │
└─────────────────────────────────────────────────────┘
```

---

## FLOW SUMMARY

```
1. GPS satellites broadcast signals
         ↓
2. GPS module (NEO-6M / NEO-M8N) receives signals, calculates lat/lon
         ↓
3. GPS module sends NMEA data via serial (TX pin)
         ↓
4. ESP32 reads serial on D18, parses with TinyGPSPlus
         ↓
5. ESP32 builds JSON payload with coordinates + metadata
         ↓
6. ESP32 signs payload with HMAC-SHA256 (shared secret)
         ↓
7. ESP32 POSTs to Laravel /api/v1/gps/ingest via WiFi
         ↓
8. Laravel verifies the HMAC signature
         ↓
9. Laravel checks the timestamp is fresh and newer than the last fix
         ↓
10. Laravel confirms an Active/Overdue transaction with GPS tracking enabled
         ↓
11. Laravel evaluates geofences and stores the row in gps_logs
         ↓
12. Frontend live map updates for staff roles (poll + SSE)
         ↓
13. On entering an unauthorised area → one critical alert to the authorising officer
    (repeated outside fixes do not re-alert)
```
