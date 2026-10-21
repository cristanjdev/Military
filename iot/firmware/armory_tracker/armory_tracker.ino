/*
 * ArmoryDB · ESP32 GPS Tracker
 * ============================
 * Hardware : ESP32-WROOM-32 + GY-NEO6MV2 (u-blox NEO-6M)
 * Endpoint : POST /api/v1/gps/ingest   (HMAC-SHA256 signed body)
 *            POST /api/v1/gps/status   (same signing; what the GPS sees while there is no fix)
 *
 * Setup:
 *   1. Copy config.example.h -> config.h and edit it.
 *   2. Board: "ESP32 Dev Module". Libraries: TinyGPSPlus, ArduinoJson, WiFiManager.
 *   3. Serial Monitor at 115200 baud.
 *
 * No hardware? Set SIMULATE_GPS 1 in config.h. The firmware then synthesises NMEA
 * internally instead of reading the UART, to test Wi-Fi, signing and the map on the bench.
 *
 * Server contract enforced by the API (see GpsController::ingest):
 *   - Body must be signed with IOT_HMAC_SECRET, hex, in X-Armory-Signature.
 *   - captured_at must be no older than ARMORY_GPS_MAX_AGE_SECONDS (default 300)
 *     and no more than ARMORY_GPS_FUTURE_TOLERANCE_SECONDS ahead (default 30).
 *   - The firearm must have an Active/Overdue transaction with GPS tracking on.
 *   - (device_id, captured_at) must be new and newer than the last accepted fix.
 * This firmware only transmits payloads that can satisfy those rules.
 */

#include "config.h"

#include <WiFi.h>
#include <HTTPClient.h>
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <ArduinoJson.h>
#include <mbedtls/md.h>
#include <time.h>

#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h> /* phone setup page: tzapu/WiFiManager */
#include <Preferences.h> /* settings kept in flash across power cycles */
#include <Ticker.h>
#include <esp_system.h> /* esp_reset_reason() */
#include <Update.h>     /* firmware updates over Wi-Fi */

#if HAS_LCD
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#endif

/* Fix-quality rules for the real receiver. Override any of these in config.h. */
#ifndef FIX_MAX_AGE_MS
#define FIX_MAX_AGE_MS 3000 /* older than this = signal lost; never resend it as live */
#endif
#ifndef MIN_SATELLITES
#define MIN_SATELLITES 4 /* fewer cannot give a trustworthy 3D position */
#endif
#ifndef MAX_HDOP
#define MAX_HDOP 5.0 /* ~ +/-12 m; worse fixes jump around the map */
#endif

/* Phone setup mode: change Wi-Fi and server address without reflashing. Override in config.h. */
#ifndef SETUP_AP_NAME
#define SETUP_AP_NAME "ArmoryTracker-" DEVICE_ID
#endif
#ifndef SETUP_AP_PASSWORD
#define SETUP_AP_PASSWORD "armory-setup" /* 8+ characters (WPA2) */
#endif
#ifndef SETUP_BUTTON_PIN
#define SETUP_BUTTON_PIN 0 /* the board's BOOT button */
#endif
#ifndef SETUP_HOLD_MS
#define SETUP_HOLD_MS 3000
#endif
#ifndef SETUP_PORTAL_TIMEOUT_S
#define SETUP_PORTAL_TIMEOUT_S 180
#endif
#ifndef API_PORT
#define API_PORT 8000 /* used when only an IP address is typed on the setup page */
#endif

/* Reaching the laptop over the hotspot. Override in config.h. */
#ifndef STATUS_INTERVAL_MS
#define STATUS_INTERVAL_MS 10000 /* while there is no position to send, the laptop still hears what the GPS sees */
#endif
#ifndef LAPTOP_SEARCH_EVERY_MS
#define LAPTOP_SEARCH_EVERY_MS 300000 /* at most this often, look for a laptop whose address changed */
#endif
#ifndef FIRMWARE_BUILD
#define FIRMWARE_BUILD __DATE__ " " __TIME__ /* the setup tool writes its own build id into config.h */
#endif

/* ========================= state ========================= */
TinyGPSPlus gps;
HardwareSerial GPSSerial(2); /* UART2 */
/* Satellites the receiver can see (GSV), as opposed to the ones used in the fix (GGA).
 * In the field this tells "blocked sky" (few in view) from "still locking" (many in view).
 * A NEO-6M only reports GPS (GP); a NEO-M8N also reports GLONASS (GL), Galileo (GA) and
 * BeiDou (GB / BD), one GSV group per system, so the count adds them up. */
TinyGPSCustom satsInViewGps(gps, "GPGSV", 3);
TinyGPSCustom satsInViewGlonass(gps, "GLGSV", 3);
TinyGPSCustom satsInViewGalileo(gps, "GAGSV", 3);
TinyGPSCustom satsInViewBeidou(gps, "GBGSV", 3);
TinyGPSCustom satsInViewBeidouOld(gps, "BDGSV", 3);
/* Characters / valid sentences from the GPS at the last check: no growth = nothing on the wire. */
unsigned long lastGpsChars = 0;
unsigned long lastGpsSentences = 0;

unsigned long lastTxMs = 0;
Preferences prefs;  /* namespace "armory": api_url, wifi_from_phone, setup_next */
Ticker setupBlinker;
String apiUrl;      /* from the phone setup page, else API_URL in config.h */
unsigned long lastWifiRetryMs = 0;
time_t lastAcceptedEpoch = 0; /* keeps captured_at strictly increasing */
unsigned long lastStatusMs = 0;
int lastLaptopAnswer = 0;  /* last status report: HTTP code, < 0 = laptop not reached; [link] lines print on change */
int laptopMisses = 0;      /* sends in a row that did not reach the laptop */
unsigned long lastLaptopSearchMs = 0;
static const int POST_BAD_URL = -1000; /* postSigned(): the address itself is unusable */
/* On a power bank there is no USB output to read, so the laptop is told why the tracker (re)started
 * and why its Wi-Fi dropped, as soon as it can be reached. */
String pendingNote;
unsigned long lastNoteTryMs = 0;
volatile uint16_t lastWifiReason = 0; /* 802.11 reason the last Wi-Fi attempt or link ended with */
String joinTrouble;                   /* why joining failed, for the next note */
/* New firmware the laptop offered in answer to a report (setup tool, no USB cable); see runUpdate(). */
String updateBuild;
String updateMd5;
size_t updateSize = 0;
int updateTries = 0;
unsigned long lastUpdateTryMs = 0;

/* ---------------------------------------------------------------------------
 * Keep every type declaration ABOVE the first function definition in this file.
 * The Arduino build step auto-generates function prototypes and injects them
 * just before the first function it finds. postFix() returns SendResult, so if
 * a function (for example the tamper ISR) were defined above this enum, the
 * injected prototype would reference an undeclared type and the build fails
 * with "'SendResult' does not name a type".
 * --------------------------------------------------------------------------- */
enum SendResult { SEND_OK, SEND_RETRY, SEND_DROP };

/* FIX_STALE: TinyGPSPlus keeps the last position "valid" after the signal is lost while the
 * clock keeps ticking, so without an age check a frozen position would be posted as live. */
enum FixState { FIX_NONE, FIX_STALE, FIX_WEAK, FIX_GOOD };
enum GpsLink { GPS_LINK_OK, GPS_LINK_SILENT, GPS_LINK_GARBLED };

/* Short-lived queue for fixes taken while the link was down.
 * Kept in RAM only: the API discards anything older than its freshness
 * window, so persisting across reboots would just produce rejections. */
struct PendingFix {
  time_t epoch;
  String body;
};
static const int PENDING_MAX = 8;
PendingFix pending[PENDING_MAX];
int pendingCount = 0;

#if HAS_TAMPER_SWITCH
volatile bool tamperTriggered = false;
void IRAM_ATTR onTamper() { tamperTriggered = true; }
#endif

#if HAS_LCD
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 16, 2);
#endif

#if SIMULATE_GPS
/* ---------------- simulated GPS (no hardware) ----------------
 * Synthesises standard NMEA sentences and pushes them through TinyGPSPlus,
 * so every downstream code path behaves exactly as it does with a real module.
 */
double simLat = SIM_START_LAT;
double simLon = SIM_START_LON;
double simCourse = 90.0;
unsigned long lastSimMs = 0;

/* NTP is the only clock source in this mode. 2025-01-01 as a sanity floor. */
bool clockSynced() { return time(nullptr) > 1735689600L; }

/* Append the NMEA "$...*CC\r\n" framing and feed it byte by byte. */
void feedNmea(const String& body) {
  uint8_t sum = 0;
  for (size_t i = 0; i < body.length(); i++) sum ^= (uint8_t) body[i];

  char line[192];
  snprintf(line, sizeof(line), "$%s*%02X\r\n", body.c_str(), sum);
  for (const char* p = line; *p; p++) gps.encode(*p);
}

/* NMEA encodes coordinates as ddmm.mmmm / dddmm.mmmm, not decimal degrees. */
String nmeaDegrees(double value, int degreeDigits) {
  double a = fabs(value);
  int d = (int) a;
  double m = (a - d) * 60.0;

  char buf[20];
  snprintf(buf, sizeof(buf), "%0*d%07.4f", degreeDigits, d, m);
  return String(buf);
}

void simulateStep() {
  if (SIM_STEP_METERS <= 0.0) return;

  double bearing = random(0, 62832) / 10000.0; /* 0 .. 2*pi */
  const double earthRadius = 6378137.0;
  simLat += (SIM_STEP_METERS * cos(bearing)) / earthRadius * (180.0 / PI);
  simLon += (SIM_STEP_METERS * sin(bearing)) /
            (earthRadius * cos(simLat * PI / 180.0)) * (180.0 / PI);
  simCourse = fmod(bearing * 180.0 / PI, 360.0);
}

void emitSimulatedFix() {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);

  /* Reduce to unsigned 0..99 so each field is provably two digits wide. */
  unsigned hh = (unsigned) t.tm_hour % 100u;
  unsigned mi = (unsigned) t.tm_min % 100u;
  unsigned ss = (unsigned) t.tm_sec % 100u;
  unsigned dd = (unsigned) t.tm_mday % 100u;
  unsigned mo = (unsigned) (t.tm_mon + 1) % 100u;
  unsigned yy = (unsigned) (t.tm_year + 1900) % 100u;

  char hms[8], dmy[8];
  snprintf(hms, sizeof(hms), "%02u%02u%02u", hh, mi, ss);
  snprintf(dmy, sizeof(dmy), "%02u%02u%02u", dd, mo, yy);

  String lat = nmeaDegrees(simLat, 2);
  String lon = nmeaDegrees(simLon, 3);
  char ns = simLat >= 0 ? 'N' : 'S';
  char ew = simLon >= 0 ? 'E' : 'W';

  char course[10];
  snprintf(course, sizeof(course), "%.1f", simCourse);

  /* Recommended minimum data: supplies position, date, time and speed. */
  feedNmea(String("GPRMC,") + hms + ".00,A," + lat + "," + ns + "," + lon + "," + ew +
           ",0.10," + course + "," + dmy + ",,");
  /* Fix data: supplies satellite count, HDOP and altitude. */
  feedNmea(String("GPGGA,") + hms + ".00," + lat + "," + ns + "," + lon + "," + ew +
           ",1,09,0.9,240.7,M,,M,,");
}
#endif

/* ========================= helpers ========================= */
String hmacSha256(const char* key, const String& msg) {
  byte out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*) key, strlen(key));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*) msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);

  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", out[i]);
  hex[64] = '\0';
  return String(hex);
}

/* UTC calendar date -> Unix epoch, independent of the local timezone. */
time_t civilToEpoch(int y, int m, int d, int hh, int mi, int ss) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned) (y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2u) / 5u + d - 1;
  const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
  const long long days = (long long) era * 146097LL + (long long) doe - 719468LL;
  return (time_t) (days * 86400LL + hh * 3600LL + mi * 60LL + ss);
}

String formatUtc(time_t epoch) {
  struct tm t;
  gmtime_r(&epoch, &t);
  char buf[24];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

/* Only trust a GPS timestamp once the receiver reports a plausible date. */
bool gpsEpoch(time_t* out) {
  if (!gps.date.isValid() || !gps.time.isValid()) return false;
  if (gps.date.year() < 2024 || gps.date.year() > 2099) return false;

  *out = civilToEpoch(gps.date.year(), gps.date.month(), gps.date.day(),
                      gps.time.hour(), gps.time.minute(), gps.time.second());
  return true;
}

/* Hands every byte waiting on the GPS UART to the parser. Call it from any long wait too. */
void feedGps() {
#if !SIMULATE_GPS
  while (GPSSerial.available()) gps.encode(GPSSerial.read());
#endif
}

unsigned long satellitesUsed() { return gps.satellites.isValid() ? gps.satellites.value() : 0UL; }
unsigned long gsvCount(TinyGPSCustom &field) {
  /* A system that stopped reporting (out of view) must not keep its old count. */
  return field.isValid() && field.age() < 5000 ? strtoul(field.value(), nullptr, 10) : 0UL;
}
unsigned long satellitesInView() {
  return gsvCount(satsInViewGps) + gsvCount(satsInViewGlonass) + gsvCount(satsInViewGalileo) +
         gsvCount(satsInViewBeidou) + gsvCount(satsInViewBeidouOld);
}

/* What came over the GPS wire since the last call. Silence means a loose TX/GND wire or an
 * unsoldered header pin: the module sends every second even indoors, satellites or not. */
GpsLink gpsLinkSinceLastCheck() {
  const unsigned long chars = gps.charsProcessed();
  const unsigned long sentences = gps.passedChecksum();
  GpsLink link = GPS_LINK_OK;
  if (chars == lastGpsChars) link = GPS_LINK_SILENT;
  else if (sentences == lastGpsSentences) link = GPS_LINK_GARBLED; /* bytes, but none valid */
  lastGpsChars = chars;
  lastGpsSentences = sentences;
  return link;
}
double currentHdop() { return gps.hdop.isValid() ? gps.hdop.hdop() : 99.99; }

FixState currentFix() {
  if (!gps.location.isValid()) return FIX_NONE;
  if (gps.location.age() > FIX_MAX_AGE_MS) return FIX_STALE;
  if (satellitesUsed() < MIN_SATELLITES || currentHdop() > MAX_HDOP) return FIX_WEAK;
  return FIX_GOOD;
}

/* "10.46.14.219" -> http://10.46.14.219:8000/api/v1/gps/ingest; "10.46.14.219:8001" keeps that
 * port; a full http:// or https:// URL is used as typed. Empty -> API_URL from config.h. */
String buildApiUrl(String input) {
  input.trim();
  if (input.length() == 0) return String(API_URL);
  if (input.startsWith("http://") || input.startsWith("https://")) return input;
  if (input.indexOf(':') < 0) input += ":" + String(API_PORT);
  return "http://" + input + "/api/v1/gps/ingest";
}

/* What the setup page pre-fills: just the laptop address for a LAN URL, the full URL otherwise. */
String setupFieldValue(const String& url) {
  if (url.startsWith("https://")) return url;
  int start = url.indexOf("://");
  start = start < 0 ? 0 : start + 3;
  int slash = url.indexOf('/', start);
  String host = url.substring(start, slash < 0 ? url.length() : slash);
  String defaultPort = ":" + String(API_PORT);
  if (host.endsWith(defaultPort)) host.remove(host.length() - defaultPort.length());
  return host;
}

/* Why the chip started this time. */
const char* resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power on";
    case ESP_RST_EXT: return "reset button";
    case ESP_RST_SW: return "restart by the firmware (BOOT held for phone setup, or setup page done)";
    case ESP_RST_PANIC: return "CRASH (firmware panic)";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "WATCHDOG (firmware stuck)";
    case ESP_RST_BROWNOUT: return "BROWNOUT (the supply voltage dipped: weak power bank, cable or battery)";
    default: return "unknown";
  }
}

/* Hold BOOT for SETUP_HOLD_MS: restart straight into phone setup mode. */
void checkSetupButton() {
  static unsigned long pressedSince = 0;
  if (digitalRead(SETUP_BUTTON_PIN) != LOW) {
    pressedSince = 0;
    return;
  }
  if (pressedSince == 0) pressedSince = millis();
  if (millis() - pressedSince >= SETUP_HOLD_MS) {
    Serial.println("\n[setup] BOOT button held - restarting into setup mode");
    prefs.putBool("setup_next", true);
    delay(200);
    ESP.restart();
  }
}

/* True when a 2.4 GHz network with this name is in range right now. */
bool ssidVisible(const String& ssid) {
  int found = WiFi.scanNetworks();
  bool visible = false;
  for (int i = 0; i < found && !visible; i++) visible = (WiFi.SSID(i) == ssid);
  WiFi.scanDelete();
  return visible;
}

/* Join the network chosen on the phone setup page, or the one compiled into config.h. */
bool joinWifi() {
  WiFi.mode(WIFI_STA);
  String ssid;
  if (prefs.getBool("wifi_from_phone", false)) {
    WiFiManager saved; /* only reads the credentials the setup page stored */
    ssid = saved.getWiFiSSID();
    WiFi.begin();
  } else {
    ssid = WIFI_SSID;
#if WIFI_CHANNEL > 0
    /* Naming the channel skips the scan phase. */
    WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
#else
    WiFi.begin(WIFI_SSID, WIFI_PASS);
#endif
  }
  Serial.printf("[wifi] connecting to %s", ssid.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    checkSetupButton();
    feedGps(); /* a rejoin can take 20 s: keep reading the GPS so no sentences are dropped */
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    /* Channels 1-13 are 2.4 GHz, the only band the ESP32 can use. */
    Serial.printf("\n[wifi] connected  ip=%s  rssi=%d dBm  channel %d (2.4 GHz)\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
    return true;
  }
  /* Scan to tell the two common causes apart (the status code alone is not reliable on this core).
   * The ESP32 only sees 2.4 GHz, so a hotspot that is off and one on 5 GHz look the same. */
  if (!ssidVisible(ssid)) {
    Serial.printf("\n[wifi] failed - \"%s\" not found: the hotspot is off, or it is on 5 GHz "
                  "(turn the phone's own Wi-Fi off / choose 2.4 GHz). Hold BOOT 3 s to change it.\n", ssid.c_str());
    joinTrouble = "\"" + ssid + "\" not found";
  } else {
    const char* why = WiFi.disconnectReasonName((wifi_err_reason_t) lastWifiReason);
    Serial.printf("\n[wifi] failed - \"%s\" did not accept the connection (%s): check the password. "
                  "Hold BOOT 3 s to change it.\n", ssid.c_str(), why);
    joinTrouble = "\"" + ssid + "\" did not accept the connection (" + why + ")";
  }
  return false;
}

/* ArmoryDB look for the phone setup pages, plus the reminder to switch the phone's Wi-Fi off after
 * Save (a web page cannot do that itself: the phone would otherwise rejoin its home Wi-Fi, and a
 * hotspot that shares a 5 GHz connection moves to 5 GHz, which the ESP32 cannot see).
 * Inline only: the phone has no internet while it is on the setup Wi-Fi.
 * Generated from iot/firmware/armory_tracker/setup_portal_theme.txt - edit that, not this. */
static const char SETUP_PAGE_THEME[] PROGMEM =
  "<style>html,body{background:#14171c}body{margin:0;padding:16px;min-height:100vh;box-sizing:borde"
  "r-box;color:#e2e7e9;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Robo"
  "to,'Helvetica Neue',Arial,sans-serif;background-image:linear-gradient(rgba(174,183,113,.05) 1px,"
  "transparent 1px),linear-gradient(90deg,rgba(174,183,113,.05) 1px,transparent 1px),radial-gradien"
  "t(ellipse at top,rgba(86,99,53,.28),transparent 60%);background-size:32px 32px,32px 32px,100% 10"
  "0%;background-attachment:fixed}.wrap{display:block;max-width:440px;min-width:0;margin:0 auto;pad"
  "ding:20px 18px 16px;background:rgba(31,42,50,.72);border:1px solid rgba(69,77,34,.55);border-rad"
  "ius:12px;box-shadow:0 8px 32px rgba(0,0,0,.45)}.armory-brand{display:flex;align-items:center;gap"
  ":8px;margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase"
  ";color:#aeb771}.armory-dot{width:8px;height:8px;border-radius:50%;background:#909a4d;box-shadow:"
  "0 0 8px rgba(144,154,77,.8)}h1{margin:0;font-size:20px;line-height:1.25;font-weight:700;color:#f"
  "5f6ee}h3{margin:4px 0 14px;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:up"
  "percase;color:#677a83}label{display:block;margin:14px 0 6px;font-size:11px;font-weight:600;lette"
  "r-spacing:.14em;text-transform:uppercase;color:#aeb771}#showpass{width:auto;margin:12px 8px 0 0;"
  "vertical-align:middle;accent-color:#75803a}label[for=showpass]{display:inline;margin:0;font-size"
  ":13px;font-weight:500;letter-spacing:0;text-transform:none;color:#94a4ab}.wrap>br,.wrap form>br{"
  "display:none}form[action='wifisave'] button[type=submit]{margin-top:20px}input:not([type=checkbo"
  "x]):not([type=radio]){width:100%;margin:0;padding:11px 12px;font-size:16px;color:#e2e7e9;backgro"
  "und:rgba(23,31,37,.85);border:1px solid rgba(69,77,34,.45);border-radius:6px;outline:none}input:"
  ":placeholder{color:#677a83}input:focus{border-color:rgba(117,128,58,.9);box-shadow:0 0 0 2px rgb"
  "a(117,128,58,.45)}input:disabled{opacity:.55}button,input[type=submit]{display:block;width:100%;"
  "margin:6px 0;padding:0 14px;line-height:2.75rem;font-size:15px;font-weight:600;letter-spacing:.0"
  "2em;color:#f5f6ee;background:#5b652b;border:0;border-radius:6px}button:active{background:#454d22"
  "}button[name=refresh],form[action='/exit'] button{background:#2a3741;color:#e2e7e9}form[action='"
  "/exit'] button{border:1px solid rgba(103,122,131,.35)}a{color:#e6e9d2;font-weight:600;text-decor"
  "ation:none}hr{border:0;border-top:1px solid rgba(69,77,34,.45);margin:18px 0 4px}.armory-net{dis"
  "play:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;padding:11px 12p"
  "x;background:rgba(23,31,37,.75);border:1px solid rgba(69,77,34,.35);border-radius:8px}.armory-ne"
  "t a{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.armory-net .q{"
  "float:none;padding:0;margin:0;min-width:0;filter:invert(.85) sepia(.35) hue-rotate(25deg)}.msg{m"
  "argin:14px 0;padding:12px 14px;color:#e2e7e9;background:rgba(23,31,37,.75);border:1px solid rgba"
  "(69,77,34,.35);border-left:4px solid #909a4d;border-radius:8px}.msg.S{border-left-color:#15803d}"
  ".msg.D{border-left-color:#c0392b}.armory-note{margin:0 0 14px;padding:11px 13px;font-size:14px;l"
  "ine-height:1.45;color:#fcd9a8;background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.45"
  ");border-radius:8px}.armory-note b{color:#fde7c4}h1+.armory-note{margin-top:14px}.armory-hint{ma"
  "rgin:6px 0 0;font-size:12px;color:#94a4ab}.armory-hint b{color:#e6e9d2}.armory-section{margin:18"
  "px 0 2px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#aeb"
  "771}.armory-foot{margin:16px 0 0;text-align:center;font-size:10px;letter-spacing:.16em;text-tran"
  "sform:uppercase;color:#4d5e67}br{line-height:.4}</style><script>document.addEventListener('DOMCo"
  "ntentLoaded',function(){var w=document.querySelector('.wrap')||document.body,p=location.pathname"
  ",saved=p.indexOf('wifisave')>=0;var h=document.querySelector('h1');if(h){var b=document.createEl"
  "ement('div');b.className='armory-brand';b.innerHTML='<span class=armory-dot></span>ArmoryDB \\u0"
  "0b7 GPS tracker setup';h.parentNode.insertBefore(b,h);}var n=document.createElement('div');n.cla"
  "ssName='armory-note';n.innerHTML=saved?'<b>Saved.</b> Now turn <b>OFF Wi-Fi on this phone</b> an"
  "d keep its <b>Hotspot ON</b>. The tracker connects within about 30 seconds (green LED stays on)."
  "':'<b>After you press Save:</b> turn <b>OFF Wi-Fi on this phone</b> and keep its <b>Hotspot ON</"
  "b>. Otherwise the phone rejoins your home Wi-Fi and the hotspot may switch to 5 GHz, which the t"
  "racker cannot use.';var anchor=document.querySelector('h3')||h;if(anchor)anchor.parentNode.inser"
  "tBefore(n,anchor.nextSibling);else w.insertBefore(n,w.firstChild);var rows=document.querySelecto"
  "rAll('a[onclick]');if(rows.length){var t=document.createElement('div');t.className='armory-secti"
  "on';t.textContent='Networks in range - tap one';rows[0].parentNode.parentNode.insertBefore(t,row"
  "s[0].parentNode);}for(var i=0;i<rows.length;i++)rows[i].parentNode.className='armory-net';var s="
  "document.getElementById('s');if(s){var cur=s.getAttribute('placeholder')||'';s.setAttribute('pla"
  "ceholder','Tap a network above, or type its name');var ls=document.querySelector('label[for=s]')"
  ";if(ls)ls.textContent='Wi-Fi name (hotspot)';if(cur){var hs=document.createElement('div');hs.cla"
  "ssName='armory-hint';hs.innerHTML='Currently saved on the tracker: <b></b>';hs.querySelector('b'"
  ").textContent=cur;s.parentNode.insertBefore(hs,s.nextSibling);}}var lp=document.querySelector('l"
  "abel[for=p]');if(lp)lp.textContent='Wi-Fi password';var pw=document.getElementById('p');if(pw)pw"
  ".setAttribute('placeholder','Hotspot password');var sv=document.getElementById('server');if(sv){"
  "var lsv=document.querySelector('label[for=server]');if(lsv)lsv.textContent='IP address';sv.setAt"
  "tribute('placeholder','e.g. 10.46.14.219');var hr=document.querySelector('hr');if(hr){var st=doc"
  "ument.createElement('div');st.className='armory-section';st.textContent='Laptop running the syst"
  "em';hr.parentNode.insertBefore(st,hr.nextSibling);}var hi=document.createElement('div');hi.class"
  "Name='armory-hint';hi.innerHTML='Type the laptop\\u2019s IPv4 address from <b>ipconfig</b> while"
  " it is on the same hotspot.';sv.parentNode.insertBefore(hi,sv.nextSibling);}var bs=document.quer"
  "ySelectorAll('button');var names={'Configure WiFi':'Set up Wi-Fi and laptop address','Exit':'Exi"
  "t setup','Refresh':'Scan again'};for(var j=0;j<bs.length;j++){var k=bs[j].textContent.trim();if("
  "names[k])bs[j].textContent=names[k];}var reasons={'AP not found':'Hotspot not found - it is off,"
  " or on 5 GHz.','Authentication failure':'Wrong hotspot password.','Could not connect':'Could not"
  " connect - check the hotspot.','No AP set':'No Wi-Fi saved yet.','Saving Credentials':'<b>Settin"
  "gs saved on the tracker.</b>','Trying to connect ESP to network.':'It is now connecting to the h"
  "otspot.','If it fails reconnect to AP to try again':'If the green LED does not stay on, hold BOO"
  "T for 3 seconds and set it up again.'};var ms=document.querySelectorAll('.msg');for(var r=0;r<ms"
  ".length;r++){for(var key in reasons){ms[r].innerHTML=ms[r].innerHTML.split(key).join(reasons[key"
  "]);}}var f=document.createElement('div');f.className='armory-foot';f.textContent='Authorized per"
  "sonnel only';w.appendChild(f);});</script>";

/* Phone setup page (captive portal). Blocks until saved, closed, or SETUP_PORTAL_TIMEOUT_S. */
void runSetupPortal() {
  Serial.println("[setup] ==============================================================");
  Serial.printf("[setup] SETUP MODE. On your phone, join Wi-Fi \"%s\" (password: %s).\n", SETUP_AP_NAME, SETUP_AP_PASSWORD);
  Serial.println("[setup] A setup page opens (or browse to 192.168.4.1). Pick the hotspot, enter its");
  Serial.println("[setup] password and the laptop's IP address, then press Save.");
  Serial.println("[setup] Then turn the phone's own Wi-Fi OFF and keep its hotspot ON.");
  Serial.printf("[setup] Closes by itself after %d s.\n", SETUP_PORTAL_TIMEOUT_S);
  Serial.println("[setup] ==============================================================");

#if HAS_STATUS_LEDS
  setupBlinker.attach_ms(150, [] { digitalWrite(LED_WIFI_PIN, !digitalRead(LED_WIFI_PIN)); });
#endif

  WiFiManager wm;
  bool saved = false;
  WiFiManagerParameter serverField("server", "Laptop IP address (example: 10.46.14.219)",
                                   setupFieldValue(apiUrl).c_str(), 160);
  wm.addParameter(&serverField);
  wm.setTitle("ArmoryDB Tracker " DEVICE_ID);
  wm.setCustomHeadElement(SETUP_PAGE_THEME);
  const char* menu[] = {"wifi", "exit"};
  wm.setMenu(menu, 2);
  wm.setConfigPortalTimeout(SETUP_PORTAL_TIMEOUT_S);
  wm.setConnectTimeout(20);
  wm.setBreakAfterConfig(true); /* keep the address even if the new Wi-Fi password is wrong */
  wm.setSaveConfigCallback([&saved] { saved = true; });

  wm.startConfigPortal(SETUP_AP_NAME, SETUP_AP_PASSWORD);

#if HAS_STATUS_LEDS
  setupBlinker.detach();
  digitalWrite(LED_WIFI_PIN, LOW);
#endif

  if (saved) {
    apiUrl = buildApiUrl(serverField.getValue());
    prefs.putString("api_url", apiUrl);
    prefs.putBool("wifi_from_phone", true);
    Serial.printf("[setup] saved. Wi-Fi: %s   server: %s\n", WiFi.SSID().c_str(), apiUrl.c_str());
  } else {
    Serial.println("[setup] closed without saving - keeping the previous settings");
  }
  WiFi.mode(WIFI_STA); /* drop the setup hotspot */
}

#if HAS_BATTERY_MONITOR
int readBatteryPct() {
  long raw = 0;
  for (int i = 0; i < 8; i++) raw += analogRead(BATTERY_PIN);
  raw /= 8;

#if SIMULATE_GPS
  /* Simulation: a potentiometer replaces the resistor divider, so map the raw
   * ADC reading straight onto 0-100%. Turning the knob then behaves like a
   * battery gauge. A real divider never spans the full ADC range this way. */
  long pct = map(raw, 0, 4095, 0, 100);
  return (int) constrain(pct, 0L, 100L);
#else
  float v = (raw / 4095.0f) * 3.3f * BATTERY_DIVIDER_RATIO;
  if (v >= 4.20f) return 100;
  if (v <= 3.30f) return 0;
  return (int) ((v - 3.30f) / (4.20f - 3.30f) * 100.0f);
#endif
}
#endif

#if HAS_STATUS_LEDS
void setStatusLeds(bool wifiOk, bool fixOk) {
  digitalWrite(LED_WIFI_PIN, wifiOk ? HIGH : LOW);
  digitalWrite(LED_FIX_PIN, fixOk ? HIGH : LOW);
}

/* One short flash on success, three rapid flashes on rejection. */
void pulseTxLed(bool ok) {
  if (ok) {
    digitalWrite(LED_TX_PIN, HIGH);
    delay(150);
    digitalWrite(LED_TX_PIN, LOW);
    return;
  }
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_TX_PIN, HIGH);
    delay(70);
    digitalWrite(LED_TX_PIN, LOW);
    delay(70);
  }
}
#endif

#if HAS_BUZZER
void chirpOk() {
  tone(BUZZER_PIN, 2200, 90);
  delay(110);
  noTone(BUZZER_PIN);
}

void alarmTamper() {
  for (int i = 0; i < 3; i++) {
    tone(BUZZER_PIN, 1400, 140);
    delay(180);
    tone(BUZZER_PIN, 900, 140);
    delay(180);
  }
  noTone(BUZZER_PIN);
}
#endif

#if HAS_LCD
/* Line 1 shows the device state, line 2 shows the payload being reported. */
void lcdStatus(const String& line1, const String& line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

void lcdShowFix(double lat, double lon, unsigned long sats) {
  char l1[20], l2[20];
  snprintf(l1, sizeof(l1), "%+09.4f %2lu sat", lat, sats);
  snprintf(l2, sizeof(l2), "%+010.4f", lon);
  lcdStatus(String(l1), String(l2));
}
#endif

/* ========================= transmit ========================= */
/* POST a signed JSON body. Returns the HTTP status, or a negative HTTPClient error when the laptop
 * was not reached. Keep the timeouts short: the GPS is not read (feedGps) while this waits. */
int postSigned(const String& url, const String& body, String& resp, int32_t connectMs, uint16_t answerMs) {
  /* The address can be changed on the phone setup page, so pick plain or TLS by its scheme. */
  const bool https = url.startsWith("https://");
  WiFiClient plainClient;
  WiFiClientSecure tlsClient;
  if (https) {
#if USE_HTTPS && !ALLOW_INSECURE_TLS
    tlsClient.setCACert(ROOT_CA_CERT);
#else
    tlsClient.setInsecure(); /* no CA compiled in: lab / tunnel use only */
#endif
  }

  HTTPClient http;
  if (!http.begin(https ? static_cast<WiFiClient&>(tlsClient) : plainClient, url)) return POST_BAD_URL;

  http.setConnectTimeout(connectMs);
  http.setTimeout(answerMs);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");
  http.addHeader("X-Armory-Signature", hmacSha256(HMAC_SECRET, body));
  http.addHeader("User-Agent", "ArmoryDB-ESP32/2.0");

  int code = http.POST(body);
  resp = http.getString();
  http.end();
  return code;
}

/* The laptop answers a report with "update" when new firmware waits for this tracker. */
void checkUpdateOffer(const String& resp) {
  if (resp.indexOf("\"update\"") < 0) return;
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<512> doc;
#endif
  if (deserializeJson(doc, resp)) return;
  const char* build = doc["update"]["build"];
  const char* md5 = doc["update"]["md5"];
  const size_t size = doc["update"]["size"] | 0;
  if (!build || !md5 || size == 0 || strcmp(build, FIRMWARE_BUILD) == 0 || updateBuild == build) return;
  updateBuild = build;
  updateMd5 = md5;
  updateSize = size;
  updateTries = 0;
  lastUpdateTryMs = 0;
  Serial.printf("[ota] the laptop offers new firmware (build %s, %u KB)\n", build, (unsigned) (size / 1024));
}

/* Sends in a row that did not reach the laptop decide when to look for it elsewhere (findLaptop). */
void noteLaptopAnswer(int code) { laptopMisses = code > 0 ? 0 : laptopMisses + 1; }

/* .../api/v1/gps/ingest -> .../api/v1/gps/status ('' for an address without that path). */
String statusUrl() {
  const int at = apiUrl.lastIndexOf("/gps/ingest");
  return at < 0 ? String() : apiUrl.substring(0, at) + "/gps/status";
}

/* One status line to the laptop. The backend notes it in storage/logs/trackers.log and the setup tool
 * shows it live, so a tracker on a hotspot can be checked without a USB cable. Returns the HTTP code
 * (< 0: the laptop was not reached). The [link] line on USB says whether the laptop answers; it prints
 * only when that changes. */
int sendStatus(const char* line) {
  const String url = statusUrl();
  if (url.length() == 0) return POST_BAD_URL;

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<512> doc;
#endif
  doc["device_id"] = DEVICE_ID;
  doc["equipment_id"] = EQUIPMENT_ID;
  doc["firmware"] = FIRMWARE_BUILD;
  doc["line"] = line;
  doc["satellites_in_view"] = satellitesInView();
  doc["satellites_used"] = satellitesUsed();
  doc["rssi"] = WiFi.RSSI();
  String body;
  serializeJson(doc, body);

  String resp;
  const int code = postSigned(url, body, resp, 2000, 3000);
  noteLaptopAnswer(code);
  checkUpdateOffer(resp);
  if (code == lastLaptopAnswer) return code;
  lastLaptopAnswer = code;

  const String laptop = setupFieldValue(apiUrl);
  if (code >= 200 && code < 300) {
    Serial.printf("[link] laptop reachable at %s - it shows this status live, also without USB\n", laptop.c_str());
  } else if (code == 404) {
    Serial.println("[link] laptop answered HTTP 404: its backend has no /gps/status yet (update it); positions still work");
  } else if (code > 0) {
    Serial.printf("[link] laptop answered HTTP %d  %s\n", code, resp.c_str());
  } else {
    Serial.printf("[link] laptop NOT reachable at %s (error %d) <- laptop on this hotspot? backend running "
                  "with --host 0.0.0.0?\n", laptop.c_str(), code);
  }
  return code;
}

/* While there is no position to send, the laptop still hears from the tracker every STATUS_INTERVAL_MS:
 * the same status line as on USB (satellites, GPS wiring). */
void reportStatus(const char* line) {
  if (WiFi.status() != WL_CONNECTED) return;
  if (lastStatusMs != 0 && millis() - lastStatusMs < (unsigned long) STATUS_INTERVAL_MS) return;
  lastStatusMs = millis();
  sendStatus(line);
}

/* A note (why the tracker started, a Wi-Fi drop) goes to the laptop as soon as it can be reached. */
void sendPendingNote() {
  if (pendingNote.length() == 0 || WiFi.status() != WL_CONNECTED) return;
  if (lastNoteTryMs != 0 && millis() - lastNoteTryMs < (unsigned long) STATUS_INTERVAL_MS) return;
  lastNoteTryMs = millis();
  if (sendStatus(pendingNote.c_str()) > 0) pendingNote = "";
}

/* A GPS status line: printed on USB and passed on to the laptop (reportStatus). */
void gpsStatus(const char* format, ...) {
  char line[200];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  Serial.println(line);
  reportStatus(line);
}

/* Is the ArmoryDB API listening at this address? Its /api/health names it. */
bool armoryAt(const IPAddress& ip, uint16_t port, int32_t connectMs) {
  WiFiClient client;
  if (!client.connect(ip, port, connectMs)) return false;
  client.printf("GET /api/health HTTP/1.0\r\nHost: %s\r\nAccept: application/json\r\n\r\n", ip.toString().c_str());
  String answer;
  const unsigned long start = millis();
  while (millis() - start < 2000 && answer.length() < 1024 && (client.connected() || client.available())) {
    while (client.available()) answer += (char) client.read();
    feedGps();
    delay(10);
  }
  client.stop();
  return answer.indexOf("ArmoryDB API") >= 0;
}

/* A phone hotspot can hand out a new address range each time it is switched on, so the laptop address
 * saved on the tracker goes stale although the laptop is right there. When the laptop stops answering,
 * look for the ArmoryDB API on the tracker's own network: first the laptop's old host number in the
 * new range (the phone usually gives the laptop the same last number), then every other address. The
 * address that answers is kept in flash, like one typed on the phone setup page. */
void findLaptop() {
  lastLaptopSearchMs = millis();
  if (WiFi.status() != WL_CONNECTED || !apiUrl.startsWith("http://")) return; /* https: a name, not an address */

  const int slash = apiUrl.indexOf('/', 7);
  const String hostPort = apiUrl.substring(7, slash < 0 ? apiUrl.length() : slash);
  const String path = slash < 0 ? String("/api/v1/gps/ingest") : apiUrl.substring(slash);
  const int colon = hostPort.indexOf(':');
  IPAddress old;
  if (!old.fromString(colon < 0 ? hostPort : hostPort.substring(0, colon))) return;
  const uint16_t port = colon < 0 ? 80 : (uint16_t) hostPort.substring(colon + 1).toInt();

  const IPAddress me = WiFi.localIP();
  const IPAddress gateway = WiFi.gatewayIP();
  const IPAddress mask = WiFi.subnetMask();
  /* Host numbers of this network within the tracker's /24 (an iPhone hotspot is a /28). */
  const int first = (me[3] & mask[3]) + 1;
  const int last = ((me[3] & mask[3]) | (~mask[3] & 0xFF)) - 1;
  Serial.printf("[link] laptop silent at %s - looking for it on %d.%d.%d.%d-%d\n",
                old.toString().c_str(), me[0], me[1], me[2], first, last);

  for (int pass = 0; pass < 2; pass++) {
    for (int host = first; host <= last; host++) {
      /* Pass 0: only the old host number, with time to answer. Pass 1: everyone else, quickly. */
      if ((pass == 0) != (host == old[3]) || host == me[3] || host == gateway[3]) continue;
      if (WiFi.status() != WL_CONNECTED) return;
      checkSetupButton();
      feedGps();
      const IPAddress candidate(me[0], me[1], me[2], host);
      if (!armoryAt(candidate, port, pass == 0 ? 1500 : 300)) continue;

      apiUrl = "http://" + candidate.toString() + ":" + String(port) + path;
      prefs.putString("api_url", apiUrl);
      laptopMisses = 0;
      lastLaptopAnswer = 0;
      lastStatusMs = 0;
      Serial.printf("[link] laptop found at %s - saved on the tracker; positions and status go there now\n",
                    candidate.toString().c_str());
      return;
    }
  }
  Serial.printf("[link] laptop not found on this network - looking again in %d min\n", LAPTOP_SEARCH_EVERY_MS / 60000);
}

/* Download the offered firmware from the laptop, check its MD5, install it and restart into it. On a
 * failure the running firmware stays; it tries again a minute later, three times in all. */
void runUpdate() {
  if (updateBuild.length() == 0 || updateTries >= 3 || WiFi.status() != WL_CONNECTED) return;
  if (lastUpdateTryMs != 0 && millis() - lastUpdateTryMs < 60000UL) return;
  lastUpdateTryMs = millis();
  updateTries++;
  const int at = apiUrl.lastIndexOf("/gps/ingest");
  if (at < 0) return;
  const String url = apiUrl.substring(0, at) + "/gps/firmware/" + DEVICE_ID;
  Serial.printf("[ota] downloading build %s from the laptop\n", updateBuild.c_str());

  const bool https = url.startsWith("https://");
  WiFiClient plainClient;
  WiFiClientSecure tlsClient;
  if (https) {
#if USE_HTTPS && !ALLOW_INSECURE_TLS
    tlsClient.setCACert(ROOT_CA_CERT);
#else
    tlsClient.setInsecure();
#endif
  }
  HTTPClient http;
  if (!http.begin(https ? static_cast<WiFiClient&>(tlsClient) : plainClient, url)) return;
  http.setConnectTimeout(3000);
  http.setTimeout(15000);
  /* The binary holds the Wi-Fi password and the secret, so the laptop hands it out to signed requests only. */
  http.addHeader("X-Armory-Signature", hmacSha256(HMAC_SECRET, String("firmware:") + DEVICE_ID + ":" + updateBuild));
  const int code = http.GET();
  if (code != 200 || http.getSize() != (int) updateSize) {
    Serial.printf("[ota] download failed: HTTP %d, %d bytes (expected %u)\n", code, http.getSize(), (unsigned) updateSize);
    pendingNote = "[ota] download failed: HTTP " + String(code);
    http.end();
    if (code == 404) updateBuild = ""; /* withdrawn on the laptop */
    return;
  }
  if (!Update.begin(updateSize) || !Update.setMD5(updateMd5.c_str())) {
    Serial.printf("[ota] cannot install: %s\n", Update.errorString());
    pendingNote = String("[ota] cannot install: ") + Update.errorString();
    http.end();
    return;
  }
  const size_t written = Update.writeStream(*http.getStreamPtr());
  http.end();
  if (written != updateSize || !Update.end()) {
    Serial.printf("[ota] install failed (%s) - keeping the current firmware\n", Update.errorString());
    pendingNote = String("[ota] install failed (") + Update.errorString() + ") - keeping the current firmware";
    Update.abort();
    return;
  }
  Serial.printf("[ota] installed build %s - restarting into it\n", updateBuild.c_str());
  prefs.putBool("after_ota", true);
  delay(200);
  ESP.restart();
}

SendResult postFix(const String& body) {
  if (WiFi.status() != WL_CONNECTED) return SEND_RETRY;

  String resp;
  const int code = postSigned(apiUrl, body, resp, 3000, 8000);
  noteLaptopAnswer(code);
  checkUpdateOffer(resp);

  if (code == POST_BAD_URL) {
    Serial.println("[post] could not open connection");
    return SEND_RETRY;
  }
  if (code <= 0) {
    Serial.printf("[post] transport error %d — will retry\n", code);
    return SEND_RETRY;
  }

  Serial.printf("[post] HTTP %d  %s\n", code, resp.c_str());

  if (code >= 200 && code < 300) return SEND_OK;

  switch (code) {
    case 401:
      Serial.println("[post] signature rejected: HMAC_SECRET does not match "
                     "IOT_HMAC_SECRET in backend/.env. Fix config, not retrying.");
      return SEND_DROP;
    case 409:
      Serial.println("[post] rejected: firearm has no Active/Overdue transaction "
                     "with GPS tracking enabled, or this fix is duplicate/out of order.");
      return SEND_DROP;
    case 422:
      Serial.println("[post] rejected: payload invalid or timestamp outside the "
                     "allowed freshness window.");
      return SEND_DROP;
    case 429:
      Serial.println("[post] rate limited — will retry");
      return SEND_RETRY;
    case 503:
      Serial.println("[post] server unavailable: MySQL is stopped, or IOT_HMAC_SECRET is not set (see its message above).");
      return SEND_RETRY;
    default:
      return (code >= 500) ? SEND_RETRY : SEND_DROP;
  }
}

void enqueue(time_t epoch, const String& body) {
  if (pendingCount == PENDING_MAX) {
    Serial.println("[queue] full — dropping oldest fix");
    for (int i = 1; i < PENDING_MAX; i++) pending[i - 1] = pending[i];
    pendingCount--;
  }
  pending[pendingCount].epoch = epoch;
  pending[pendingCount].body = body;
  pendingCount++;
  Serial.printf("[queue] holding %d fix(es)\n", pendingCount);
}

void dropFront() {
  for (int i = 1; i < pendingCount; i++) pending[i - 1] = pending[i];
  pendingCount--;
}

/* Flush oldest-first so captured_at stays monotonic on the server. */
void flushQueue(time_t nowEpoch) {
  while (pendingCount > 0) {
    if (nowEpoch - pending[0].epoch > MAX_FIX_AGE_SECONDS) {
      Serial.println("[queue] discarding fix older than the server window");
      dropFront();
      continue;
    }

    SendResult r = postFix(pending[0].body);
    if (r == SEND_RETRY) return; /* keep order, try again next cycle */

    if (r == SEND_OK && pending[0].epoch > lastAcceptedEpoch) {
      lastAcceptedEpoch = pending[0].epoch;
    }
    dropFront();
  }
}

/* ========================= setup / loop ========================= */
void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println();
  Serial.println("=== ArmoryDB GPS tracker ===");
  Serial.printf("device=%s  equipment_id=%d\n", DEVICE_ID, EQUIPMENT_ID);

  prefs.begin("armory", false);
  /* New firmware brings its own settings (config.h), as a USB upload that erases the flash does: a
   * server address or Wi-Fi kept from the phone setup page or a laptop search belongs to the old one. */
  if (prefs.getString("build", "") != FIRMWARE_BUILD) {
    prefs.remove("api_url");
    prefs.remove("wifi_from_phone");
    prefs.putString("build", FIRMWARE_BUILD);
  }
  const bool afterUpdate = prefs.getBool("after_ota", false);
  if (afterUpdate) prefs.remove("after_ota");
  apiUrl = prefs.getString("api_url", API_URL);
  pinMode(SETUP_BUTTON_PIN, INPUT_PULLUP);
  Serial.printf("endpoint=%s  (%s)\n", apiUrl.c_str(),
                prefs.isKey("api_url") ? "saved on the tracker: phone setup page, or found on the hotspot" : "from config.h");
  Serial.printf("interval=%d ms  transport=%s\n", TX_INTERVAL_MS,
                apiUrl.startsWith("https://") ? "HTTPS" : "HTTP");
  Serial.printf("[setup] hold BOOT for %d s at any time to change Wi-Fi / server from a phone\n",
                SETUP_HOLD_MS / 1000);

#if SIMULATE_GPS
  Serial.println("[gps] SIMULATED mode — no GPS module is read");
  Serial.printf("[gps] start %.6f, %.6f  step %.1f m/s\n",
                (double) SIM_START_LAT, (double) SIM_START_LON, (double) SIM_STEP_METERS);
  randomSeed(micros());
#else
  /* The default 256-byte receive buffer holds well under a second of NEO-M8N output (~400-800
   * bytes/s with GPS + GLONASS). Sending a position or rejoining Wi-Fi blocks loop() for longer,
   * so the buffer overflowed and sentences were cut. 2 KB covers several seconds. Must precede begin(). */
  GPSSerial.setRxBufferSize(2048);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.printf("[gps] UART2 rx=%d tx=%d @%d baud\n", GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD);
#endif

#if HAS_BATTERY_MONITOR
  pinMode(BATTERY_PIN, INPUT);
#endif
#if HAS_TAMPER_SWITCH
  pinMode(TAMPER_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TAMPER_PIN), onTamper, FALLING);
#endif
#if HAS_STATUS_LEDS
  pinMode(LED_WIFI_PIN, OUTPUT);
  pinMode(LED_FIX_PIN, OUTPUT);
  pinMode(LED_TX_PIN, OUTPUT);
  setStatusLeds(false, false);
  digitalWrite(LED_TX_PIN, LOW);
  Serial.printf("[led] wifi=D%d fix=D%d tx=D%d\n", LED_WIFI_PIN, LED_FIX_PIN, LED_TX_PIN);
#endif
#if HAS_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  noTone(BUZZER_PIN);
#endif
#if HAS_LCD
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  lcd.init();
  lcd.backlight();
  lcdStatus("ArmoryDB " DEVICE_ID, "booting...");
  Serial.printf("[lcd] 16x2 at 0x%02X on SDA=D%d SCL=D%d\n",
                LCD_I2C_ADDR, I2C_SDA_PIN, I2C_SCL_PIN);
#endif

  /* Keep the reason of every Wi-Fi drop or failed attempt: shown on USB and told to the laptop. */
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) { lastWifiReason = info.wifi_sta_disconnected.reason; },
               ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  const bool setupRequested = prefs.getBool("setup_next", false);
  if (setupRequested) {
    prefs.putBool("setup_next", false);
    runSetupPortal();
    if (WiFi.status() != WL_CONNECTED) joinWifi();
  } else if (!joinWifi()) {
    Serial.println("[setup] could not join Wi-Fi - opening phone setup mode");
    runSetupPortal();
    if (WiFi.status() != WL_CONNECTED) joinWifi();
  }

  /* Told to the laptop once it can be reached (sendPendingNote): on a power bank, the only way to know. */
  pendingNote = String("[boot] started (build ") + FIRMWARE_BUILD + "): " +
                (setupRequested  ? "BOOT button held 3 s, so the phone setup page was open first"
                 : afterUpdate   ? "new firmware installed over Wi-Fi"
                                 : resetReasonText());
  if (joinTrouble.length() > 0) pendingNote += "; the first Wi-Fi try failed (" + joinTrouble + "), so the phone setup page was open first";
  joinTrouble = "";
  Serial.println(pendingNote);

#if HAS_LCD
  lcdStatus(WiFi.status() == WL_CONNECTED ? "WiFi connected" : "WiFi FAILED",
            WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("check config"));
#endif

#if SIMULATE_GPS
  /* Satellites normally supply UTC. In simulation NTP has to stand in. */
  configTime(0, 0, SIM_NTP_PRIMARY, SIM_NTP_SECONDARY);
  Serial.println("[boot] ready — waiting for NTP time");
#else
  Serial.println("[boot] ready — waiting for a GPS fix (antenna must face the sky)");
#endif
}

void loop() {
  checkSetupButton();

#if SIMULATE_GPS
  if (millis() - lastSimMs >= 1000) {
    lastSimMs = millis();
    if (clockSynced()) {
      simulateStep();
      emitSimulatedFix();
    }
  }
#else
  feedGps();
#endif

  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiRetryMs > 15000) {
    lastWifiRetryMs = millis();
    const String why = WiFi.disconnectReasonName((wifi_err_reason_t) lastWifiReason); /* before disconnect() replaces it */
    Serial.printf("[wifi] link down (%s) — reconnecting\n", why.c_str());
    WiFi.disconnect();
    if (joinWifi() && pendingNote.length() == 0) pendingNote = "[wifi] the link had dropped (" + why + ") and is back";
  }
  sendPendingNote();
  runUpdate();

  /* The laptop stopped answering: its address may have changed with the hotspot. */
  if (laptopMisses >= 3 && WiFi.status() == WL_CONNECTED &&
      (lastLaptopSearchMs == 0 || millis() - lastLaptopSearchMs > (unsigned long) LAPTOP_SEARCH_EVERY_MS)) {
    findLaptop();
  }

#if HAS_TAMPER_SWITCH
  if (tamperTriggered) {
    tamperTriggered = false;
    /* Logged locally only: the ingest API has no tamper field yet. */
    Serial.println("[tamper] switch opened — physical tamper detected");
#if HAS_LCD
    lcdStatus("** TAMPER **", "device opened");
#endif
#if HAS_BUZZER
    alarmTamper();
#endif
  }
#endif

#if HAS_STATUS_LEDS
  setStatusLeds(WiFi.status() == WL_CONNECTED, currentFix() == FIX_GOOD);
#endif

  if (millis() - lastTxMs < (unsigned long) TX_INTERVAL_MS) {
    delay(20);
    return;
  }
  lastTxMs = millis();

  const FixState fix = currentFix();
  if (fix != FIX_GOOD) {
#if SIMULATE_GPS
    if (fix == FIX_NONE) {
      Serial.println("[gps] waiting for NTP before the first simulated fix");
#if HAS_LCD
      lcdStatus("Waiting for NTP", "no fix yet");
#endif
      return;
    }
#endif
#if !SIMULATE_GPS
    const GpsLink link = gpsLinkSinceLastCheck();
    if (link != GPS_LINK_OK) {
      if (link == GPS_LINK_SILENT) {
        gpsStatus("[gps] NO DATA from the GPS module <- check GPS TX -> D18 and GND; header pins must be "
                  "soldered (this is a wire problem, not the sky)");
      } else {
        gpsStatus("[gps] GARBLED data from the GPS module <- wrong speed? GPS_BAUD is %d", GPS_BAUD);
      }
#if HAS_LCD
      lcdStatus(link == GPS_LINK_SILENT ? "GPS: NO DATA" : "GPS: BAD DATA", "check TX->D18");
#endif
      return;
    }
#endif
    if (fix == FIX_NONE) {
      gpsStatus("[gps] no fix yet (satellites in view=%lu, used=%lu)%s", satellitesInView(), satellitesUsed(),
                satellitesInView() < 4 ? "  <- sky blocked? move to open sky" : "  <- locking on, keep it still");
    } else if (fix == FIX_STALE) {
      gpsStatus("[gps] fix lost: last position is %.1f s old, holding (in view=%lu)",
                gps.location.age() / 1000.0, satellitesInView());
    } else {
      gpsStatus("[gps] fix too weak: used=%lu (need >=%d), hdop=%.1f (need <=%.1f), holding",
                satellitesUsed(), MIN_SATELLITES, currentHdop(), (double) MAX_HDOP);
    }
#if HAS_LCD
    lcdStatus(fix == FIX_WEAK ? "Weak GPS fix" : (fix == FIX_STALE ? "GPS fix lost" : "Acquiring GPS"),
              "antenna to sky");
#endif
    return;
  }

  time_t epoch;
  if (!gpsEpoch(&epoch)) {
    gpsStatus("[gps] fix has no valid UTC date/time yet — holding transmission");
    return;
  }

  /* The API rejects a repeated or older (device_id, captured_at). */
  if (epoch <= lastAcceptedEpoch) {
    Serial.println("[gps] timestamp not newer than last accepted fix — skipping");
    return;
  }

  /* ArduinoJson 7 replaced StaticJsonDocument; support both major versions. */
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<512> doc;
#endif
  doc["equipment_id"] = EQUIPMENT_ID;
  doc["device_id"] = DEVICE_ID;
  doc["firmware"] = FIRMWARE_BUILD; /* lets the laptop offer an update in its answer */
  doc["captured_at"] = formatUtc(epoch);
  doc["latitude"] = gps.location.lat();
  doc["longitude"] = gps.location.lng();
  doc["accuracy_meters"] = gps.hdop.isValid() ? gps.hdop.hdop() * 2.5 : 5.0;
  doc["speed_mps"] = gps.speed.isValid() ? max(0.0, gps.speed.mps()) : 0.0;
  doc["heading_deg"] = gps.course.isValid() ? gps.course.deg() : 0.0;
  if (gps.altitude.isValid()) doc["altitude_meters"] = gps.altitude.meters();
  if (gps.satellites.isValid()) doc["satellites"] = gps.satellites.value();
#if HAS_BATTERY_MONITOR
  doc["battery_pct"] = readBatteryPct();
#endif

  String body;
  serializeJson(doc, body);

  Serial.printf("[gps] %.6f, %.6f  sats=%lu  %s\n",
                gps.location.lat(), gps.location.lng(),
                gps.satellites.isValid() ? (unsigned long) gps.satellites.value() : 0UL,
                formatUtc(epoch).c_str());

  flushQueue(epoch); /* older fixes first, so ordering holds */

#if HAS_LCD
  lcdShowFix(gps.location.lat(), gps.location.lng(),
             gps.satellites.isValid() ? (unsigned long) gps.satellites.value() : 0UL);
#endif

  SendResult r = postFix(body);
  if (r == SEND_OK) {
    lastAcceptedEpoch = epoch;
  } else if (r == SEND_RETRY) {
    enqueue(epoch, body);
  }

#if HAS_STATUS_LEDS
  pulseTxLed(r == SEND_OK);
#endif
#if HAS_BUZZER
  if (r == SEND_OK) chirpOk();
#endif
#if HAS_LCD
  lcdStatus(r == SEND_OK ? "Uplink OK" : "Uplink FAILED",
            String("sent ") + formatUtc(epoch).substring(11, 19));
#endif
}
