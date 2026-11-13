# IoT-Based Firearm Accountability and Monitoring System with GPS, Geofencing, and Biometric Authentication

> **Capstone Project** – College of Information Technology, Liceo de Cagayan University
> **Target Institution:** 10th Regional Community Defense Group (10RCDG), Reserve Command, Philippine Army
> **Authors:** Charlmaigne Anntonee N. Aure, Marc Steven U. Manoop

A military-grade, IoT-enabled, web-based platform that combines **real-time GPS tracking**, **QR-code firearm identification**, **biometric fingerprint authentication**, and an **immutable audit trail** to modernize armory management for the 10RCDG.

---

## 1. System Overview

| Pillar | Implementation |
|---|---|
| Real-time GPS tracking | ESP32 + GY-NEO6MV2 ? encrypted HTTPS POST ? Laravel ingestion ? Leaflet.js live map (?5 s latency, ?10 m accuracy, 30 s cadence) |
| QR Identification | in-browser camera scanner (ZXing-C++ via WebAssembly), unique QR per firearm, instant DB lookup |
| Biometric AuthN | Futronic FS80H/FS88H fingerprint + bcrypt(12) password + Google Authenticator TOTP |
| Access Control | RBAC (Administrator, Command Officer, S4 Officer, Armory Custodian, Personnel) + Clearance (Confidential, Secret, Top Secret) |
| Audit | Append-only `audit_logs` with IP, timestamp, user, firearm, action |
| Security | OWASP Top 10, AES-256 at rest, HTTPS-only, rate-limit 5 req/s, reCAPTCHA v2 checkbox after 3 failed logins, 15-min session expiry, HttpOnly cookies |

---

## 2. Repository Layout

```
realtime-gps/
??? backend/        # Laravel 11 REST API (PHP 8.2+, MariaDB/MySQL)
??? frontend/       # Next.js 14 (App Router, TypeScript, Tailwind, ShadCN, Leaflet)
??? iot/            # ESP32 + Arduino firmware (GY-NEO6MV2 GPS module)
??? docs/           # SRS, API docs, ERD, Use Case, Sequence, DFD, Architecture, User Manual
??? scripts/        # Helper scripts (seed CSV, dev launcher, etc.)
??? manuscript/     # Source capstone manuscript (reference)
```

---

## 3. Technology Stack

### Frontend
- Next.js 14 (App Router) · TypeScript · Tailwind CSS · ShadCN UI
- Framer Motion (60 fps micro-interactions)
- Leaflet.js (live tactical map)
- `zxing-wasm` (browser camera QR scanning, ZXing-C++ compiled to WebAssembly)
- Zustand (state) · Axios (HTTP) · React Query (server cache)
- Recharts (dashboard charts)

### Backend
- Laravel 11 (PHP 8.2+)
- Laravel Sanctum (token AuthN, HttpOnly cookies)
- `pragmarx/google2fa` (TOTP MFA)
- `simplesoftwareio/simple-qrcode` (QR generation)
- `barryvdh/laravel-dompdf` + `maatwebsite/excel` (reports)

### Database
- MariaDB 10.6+ / MySQL 8 — `ArmoryDB`
- AES-256 column encryption for PII, biometric, GPS coordinates
- Indexed `gps_logs`, `transactions`, `audit_logs`

### IoT Firmware
- ESP32-WROOM-32 + GY-NEO6MV2 (u-blox NEO-6M)
- Optional Arduino Nano companion for power management
- TLS / shared-secret HMAC for transmission integrity
- Local circular buffer for offline operation

### DevOps
- HTTPS-only (Caddy / Nginx + Let's Encrypt)
- GitHub Actions CI/CD (lint, test, build)
- Daily encrypted backups

---

## 4. Quick Start (Development)

### Prerequisites
- PHP **8.2+**, Composer 2.x
- Node.js **20+**, npm
- MariaDB **10.6+** or MySQL 8
- (Optional) Arduino IDE / PlatformIO for firmware

### Backend
```bash
cd backend
cp .env.example .env
composer install
php artisan key:generate
php artisan migrate --seed
php artisan serve   # http://127.0.0.1:8000
```

### Frontend
```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev         # http://localhost:3000
```

### Default Credentials (seeded)
| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `Admin@10RCDG!2025` |
| Command Officer | `cmd.officer` | `Command@2025!` |
| S4 Officer | `s4.officer` | `S4Logistics@2025!` |
| Armory Custodian | `armory.custodian` | `Custodian@2025!` |
| Personnel | `pvt.dela.cruz` | `Personnel@2025!` |

> Change all default passwords immediately after first login.

---

## 5. Modules

1. **Authentication** – password + TOTP + fingerprint, reCAPTCHA gate, login auditing
2. **Firearm Management** – registration, QR, status, condition, history
3. **Real-Time GPS Tracking** – Leaflet live map, geofences, route history
4. **QR Code System** – generate, scan, validate at issuance/return
5. **Audit Trail** – immutable logs (no UI delete, DB-level revoke)
6. **Notifications & Alerts** – overdue, geofence, suspicious activity
7. **Dashboard & Monitoring** – KPIs, charts, role-aware visibility
8. **Reports** – PDF, CSV, Excel exports

---

## 6. Database Tables (ArmoryDB)

`users`, `roles`, `equipment_categories`, `firearm_equipment`, `transactions`,
`maintenance_records`, `notifications`, `audit_logs`, `gps_locations`, `gps_logs`,
plus Sanctum/auth/session/cache tables.

ERD: see [`docs/erd.md`](docs/erd.md).

---

## 7. Security

- AES-256 (Laravel `encrypted` cast) on: `biometric_data`, GPS lat/lon at rest, PII
- bcrypt(12) password hashing
- JWT-style Sanctum tokens, 15-min idle expiry, HttpOnly + Secure + SameSite=Strict cookies
- Rate limit: 5 req/s per IP+user (custom middleware)
- CSRF, XSS, SQLi via Laravel + `express-validator`-style rules
- TLS 1.3 only · HSTS preload · Content-Security-Policy
- reCAPTCHA v2 checkbox after 3 failed logins
- Immutable `audit_logs` (DB trigger blocks UPDATE/DELETE for non-DBA)

---

## 8. Performance Targets

| Metric | Target |
|---|---|
| QR scan success | ? 98 % |
| GPS update interval | 30 s |
| GPS reliability | ? 95 % |
| GPS latency | ? 5 s |
| Location accuracy | ? 10 m at 90 % of updates |
| API rate limit | 5 req/s/user |
| Session timeout | 15 min idle |

---

## 9. Documentation Index

- [`docs/SRS.md`](docs/SRS.md) – Software Requirements Specification
- [`docs/architecture.md`](docs/architecture.md) – Architecture diagram & narrative
- [`docs/erd.md`](docs/erd.md) – Entity-Relationship Diagram
- [`docs/use-cases.md`](docs/use-cases.md) – Use Cases
- [`docs/sequence-diagrams.md`](docs/sequence-diagrams.md) – Sequence Diagrams
- [`docs/data-flow.md`](docs/data-flow.md) – Data Flow Diagrams
- [`docs/api.md`](docs/api.md) – REST API Reference
- [`docs/deployment.md`](docs/deployment.md) – Production Deployment Guide
- [`docs/user-manual.md`](docs/user-manual.md) – User Manual

---

## 10. License & Acknowledgement

This project is developed exclusively for academic and institutional use by the 10th RCDG, Reserve Command, Philippine Army. All rights reserved by the proponents and Liceo de Cagayan University.
