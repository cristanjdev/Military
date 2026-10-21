# Biometric Bridge — DigitalPersona U.are.U

Local Windows service that lets the login page (`/login/biometric`) use a
DigitalPersona U.are.U 4000B/4500 fingerprint reader (including ZKTeco "Biokey 200"
OEM units, USB `05BA:000A`).

```
Browser (localhost:3000) --POST /capture--> Bridge (127.0.0.1:8787) --SDK--> U.are.U reader
Browser --POST /auth/biometric/verify--> Laravel (checks HMAC attestation + token hash)
```

## Why a bridge

A fingerprint capture is different on every touch, so the backend cannot compare
captures byte for byte. The bridge does the real 1:1 biometric match with the
DigitalPersona SDK, and on a match releases the user's random enrollment token,
signed with `HMAC-SHA256(secret, challenge_token|username|captured_at|sha256(token))`.
The backend stores and compares the token's SHA-256 (`users.biometric_data`).

Templates never leave the workstation; they are DPAPI-encrypted under
`%LOCALAPPDATA%\ArmoryDB\BiometricBridge`, readable only by the Windows account
running the bridge. A user enrolled on one workstation must re-enroll on another
(an administrator resets their biometric from the Users page).

## Requirements

- DigitalPersona **One Touch for Windows SDK 1.4** (`Install\x64\Setup.exe`), which
  also installs the reader driver. Device Manager must show
  *U.are.U® 4000B Fingerprint Reader* under **Biometric devices**.
- .NET SDK 6+ to build (targets .NET Framework 4.8, built into Windows 10/11).

## Setup

1. `copy bridge.settings.example.json bridge.settings.json`
2. Put a 32+ character random value in `hmac_secret`, and the **same** value in
   `backend/.env` as `BIOMETRIC_BRIDGE_HMAC_SECRET`, then `php artisan config:clear`.
3. `start-bridge.bat` (builds on first run). `start.bat` at the repo root also starts it.

`bridge.settings.json` is git-ignored. In JSON paths use `/` or `\\`.

## Testing

| Command | What it does |
|---|---|
| `start-bridge.bat test` | Enroll a throwaway finger (4 touches), then 3 verify attempts. No website needed. |
| `curl http://127.0.0.1:8787/health` | `200` = reader connected, `503` = not ready; `message` says why (no reader, or SDK service stopped) |
| `bin\Release\ArmoryBiometricBridge.exe --reset <username>` | Delete a user's local enrollment |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[reader] ERROR: The DigitalPersona fingerprint service is not running` (older builds: crash with `DPFP.Error.SDKException: Failed to initialize`) | The SDK's Windows service is stopped or missing. `Get-Service DpHost` must say Running; start it from `services.msc` ("Biometric Authentication Service"), or restart Windows after installing the SDK. If the service does not exist, reinstall the SDK. |
| `[reader] none connected` | Plug the reader in; Device Manager must list it under Biometric devices with the DigitalPersona driver. |

## Endpoints

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/health` | — | `200 {reader_connected:true}` / `503` |
| POST | `/capture` | `{username, challenge_token, mode: "enroll"\|"verify"}` | `200 {template, signature, captured_at, mode}` |

Errors return `{message}`: `401` no match, `404` not enrolled here, `408` no finger
in time, `409` reader busy, `422` enrollment touches disagreed, `429` locked out after
5 failed matches (5 min), `503` reader unplugged.

`/capture` only answers origins listed in `allowed_origins` (default
`http://localhost:3000`, `http://127.0.0.1:3000`). Add the LAN URL there if the
dashboard is opened from another address.
