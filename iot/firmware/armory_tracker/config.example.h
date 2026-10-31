/*
 * ArmoryDB · ESP32 tracker configuration template
 * ------------------------------------------------
 * 1. Copy this file to `config.h` in the same folder.
 * 2. Fill in your own values.
 * 3. `config.h` is git-ignored so real secrets never get committed.
 */
#pragma once

/* ---------- Wi-Fi (2.4 GHz only — ESP32 cannot join 5 GHz) ---------- */
#define WIFI_SSID "YourWiFiName"
#define WIFI_PASS "YourWiFiPassword"

/* Phone setup mode (optional; the firmware uses these defaults).
 * Hold BOOT 3 s - or power on where the saved Wi-Fi is not available - and the tracker opens
 * the Wi-Fi SETUP_AP_NAME. Join it from a phone, pick the hotspot, type its password and the
 * laptop's IP; it is saved on the board and replaces WIFI_SSID / WIFI_PASS / API_URL here.
 *   #define SETUP_AP_NAME "ArmoryTracker-" DEVICE_ID
 *   #define SETUP_AP_PASSWORD "armory-setup"   8+ characters
 *   #define SETUP_HOLD_MS 3000
 *   #define SETUP_PORTAL_TIMEOUT_S 180
 *   #define API_PORT 8000                      added when only an IP is typed
 */

/* 0 = scan for the network. A fixed channel skips the scan and saves about
 * 4 seconds. */
#define WIFI_CHANNEL 0

/* ---------- Backend endpoint ----------
 * Use the LAN IP of the machine running Laravel, never localhost/127.0.0.1.
 * Find it on Windows with: ipconfig  → IPv4 Address
 *   Local dev  : http://192.168.1.100:8000/api/v1/gps/ingest   (USE_HTTPS 0)
 *   Deployment : https://armory.10rcdg.local/api/v1/gps/ingest (USE_HTTPS 1)
 */
#define API_URL "http://192.168.1.100:8000/api/v1/gps/ingest"

/* 0 = plain HTTP (lab/LAN only). 1 = HTTPS. */
#define USE_HTTPS 0

/* Only used when USE_HTTPS is 1.
 * Set to 0 and paste your CA into ROOT_CA_CERT for verified TLS.
 * Setting this to 1 disables certificate validation — lab bring-up only. */
#define ALLOW_INSECURE_TLS 0

#if USE_HTTPS && !ALLOW_INSECURE_TLS
#define ROOT_CA_CERT                     \
  "-----BEGIN CERTIFICATE-----\n"        \
  "PASTE_YOUR_INSTITUTIONAL_CA_HERE\n"   \
  "-----END CERTIFICATE-----\n"
#endif

/* ---------- Device identity ----------
 * DEVICE_ID must be unique per tracker. The API enforces uniqueness on
 * (device_id, captured_at), so two trackers must never share an ID.
 * EQUIPMENT_ID must match firearm_equipment.equipment_id in the database.
 */
#define DEVICE_ID "ESP32-001"
#define EQUIPMENT_ID 1

/* ---------- Shared secret ----------
 * Must byte-for-byte equal IOT_HMAC_SECRET in backend/.env.
 */
#define HMAC_SECRET "CHANGE_ME_iot_shared_secret_at_least_32_chars_long_!!"

/* ---------- Timing ----------
 * Keep TX_INTERVAL_MS at or above 1000. The API rejects a repeated
 * (device_id, captured_at) pair, and timestamps have 1-second resolution.
 * 30000 matches the 30-second interval in the system requirements.
 */
#define TX_INTERVAL_MS 30000

/* Must not exceed ARMORY_GPS_MAX_AGE_SECONDS in backend/.env (default 300).
 * Queued fixes older than this are discarded instead of being rejected. */
#define MAX_FIX_AGE_SECONDS 240

/* Fix quality for the real receiver (optional; the firmware uses these defaults).
 * A fix is only sent when it is fresh, uses enough satellites and has a decent HDOP.
 * Lower MIN_SATELLITES / raise MAX_HDOP only if a demo site has a partly blocked sky:
 * the trade-off is points that jump around the map.
 *   #define FIX_MAX_AGE_MS 3000   position older than this = signal lost, not re-sent
 *   #define MIN_SATELLITES 4
 *   #define MAX_HDOP 5.0          about +/-12 m
 */

/* ---------- GPS wiring (UART2) ---------- */
#define GPS_RX_PIN 18 /* ESP32 D18  <-- GPS TX */
#define GPS_TX_PIN 19 /* ESP32 D19  --> GPS RX */
#define GPS_BAUD 9600

/* ---------- Simulated GPS (bench testing without hardware) ----------
 * 1 = build NMEA sentences in code and feed them through TinyGPSPlus instead of
 *     reading the UART. The parsing, signing, and HTTP paths stay identical, so
 *     this exercises real firmware logic with no GPS module attached.
 * Keep 0 for real hardware.
 *
 * In this mode the clock comes from NTP, not from satellites, so the device
 * waits for NTP before transmitting. Otherwise the API rejects the timestamp.
 */
#define SIMULATE_GPS 0

/* Starting point for the simulated walk (default: Camp Evangelista area). */
#define SIM_START_LAT 8.484460
#define SIM_START_LON 124.657010

/* Metres moved per simulated second. 0 keeps the device stationary.
 * Raise it to walk out of a geofence and trigger a violation alert. */
#define SIM_STEP_METERS 6.0

/* NTP servers used only when SIMULATE_GPS is 1. */
#define SIM_NTP_PRIMARY "pool.ntp.org"
#define SIM_NTP_SECONDARY "time.nist.gov"

/* ---------- Battery monitor (21700 battery build) ----------
 * Set to 1 once the two 100k resistors are wired from Battery+ to BATTERY_PIN (GPIO34) and GND.
 * The level then goes with every update, and the system alerts at 20% and 10%.
 * Leave 0 on a USB or power bank build: an unwired pin reads noise and would raise false alerts.
 */
#define HAS_BATTERY_MONITOR 0
#define BATTERY_PIN 34
#define BATTERY_DIVIDER_RATIO 2.0f

/* ---------- Optional tamper switch ----------
 * Detected and logged locally. The API does not store a tamper flag yet,
 * so nothing is transmitted for it.
 */
#define HAS_TAMPER_SWITCH 0
#define TAMPER_PIN 27

/* ---------- Optional status LEDs ----------
 * Each LED needs a 220R series resistor to GND.
 *   WIFI : on once associated with the access point
 *   FIX  : on once a position is valid
 *   TX   : 1 flash = fix accepted, 3 flashes = rejected
 */
#define HAS_STATUS_LEDS 0
/* With LEDs: WIFI blinking fast = phone setup mode is open (see below). */
#define LED_WIFI_PIN 25
#define LED_FIX_PIN 26
#define LED_TX_PIN 33

/* ---------- Optional 16x2 I2C LCD ----------
 * Shows live coordinates, satellite count and the last uplink result.
 * Requires the "LiquidCrystal I2C" library. Most modules answer at 0x27.
 */
#define HAS_LCD 0
#define LCD_I2C_ADDR 0x27
#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22

/* ---------- Optional piezo buzzer ----------
 * Short chirp on an accepted uplink, repeating alarm pattern on tamper.
 */
#define HAS_BUZZER 0
#define BUZZER_PIN 32
