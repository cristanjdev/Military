#!/usr/bin/env python3
"""
ArmoryDB · GPS Simulator
========================

Simulates one or more ESP32 devices that POST encrypted, HMAC-signed GPS
fixes to /api/v1/gps/ingest every 30 s. Useful for capstone demos when no
hardware is available.

Usage:
  python gps_simulator.py --equipment 1 --base http://127.0.0.1:8000/api/v1 \
      --secret CHANGE_ME_iot_shared_secret_at_least_32_chars_long_!! --count 50
"""
import argparse
import hashlib
import hmac
import json
import math
import random
import sys
import time
from datetime import datetime, timezone

import urllib.request


def sign(secret: str, body: bytes) -> str:
    return hmac.HMAC(secret.encode(), body, hashlib.sha256).hexdigest()


def random_walk(lat: float, lon: float, step_m: float = 6.0):
    """Take a single random step of `step_m` meters in any direction."""
    bearing = random.uniform(0, 2 * math.pi)
    earth_r = 6_378_137
    dlat = (step_m * math.cos(bearing)) / earth_r
    dlon = (step_m * math.sin(bearing)) / (earth_r * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lon + math.degrees(dlon)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--equipment", type=int, required=True, help="firearm_equipment.equipment_id")
    p.add_argument("--device-id", default=None, help="logical device id (auto-derived if omitted)")
    p.add_argument("--base", default="http://127.0.0.1:8000/api/v1")
    p.add_argument("--secret", required=True, help="must match Laravel IOT_HMAC_SECRET")
    p.add_argument("--lat", type=float, default=8.484460)
    p.add_argument("--lon", type=float, default=124.657010)
    p.add_argument("--interval", type=float, default=30.0, help="seconds between fixes")
    p.add_argument("--count", type=int, default=10, help="number of fixes (-1 for forever)")
    p.add_argument("--battery", type=int, default=None, help="fixed battery %% (random 60-100 if omitted)")
    args = p.parse_args()

    device_id = args.device_id or f"SIM-DEV-{args.equipment:04d}"
    url = f"{args.base.rstrip('/')}/gps/ingest"

    lat, lon = args.lat, args.lon
    sent = 0
    print(f"[sim] Pushing fixes for equipment_id={args.equipment} → {url}")
    try:
        while args.count == -1 or sent < args.count:
            payload = {
                "equipment_id":   args.equipment,
                "device_id":      device_id,
                "captured_at":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "latitude":       round(lat, 7),
                "longitude":      round(lon, 7),
                "accuracy_meters": round(random.uniform(2.5, 7.5), 2),
                "speed_mps":      round(random.uniform(0, 1.4), 2),
                "heading_deg":    round(random.uniform(0, 360), 2),
                "altitude_meters":round(random.uniform(220, 260), 2),
                "satellites":     random.randint(7, 12),
                "battery_pct":    random.randint(60, 100) if args.battery is None else args.battery,
            }
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                url,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-Armory-Signature": sign(args.secret, body),
                    "User-Agent": "ArmoryDB-Simulator/1.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    print(f"[sim {sent + 1:>3}] HTTP {resp.status} · {resp.read().decode()[:120]}")
            except Exception as e:
                print(f"[sim {sent + 1:>3}] ERROR · {e}")

            lat, lon = random_walk(lat, lon, step_m=random.uniform(0, 12))
            sent += 1
            if args.count == -1 or sent < args.count:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[sim] Interrupted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
