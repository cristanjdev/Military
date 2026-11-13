# ArmoryDB (10RCDG): notes for Claude

Firearm tracking for 10RCDG. Laravel 12 backend (`backend/`), Next.js 16 frontend (`frontend/`), ESP32 GPS tracker (`iot/`) and a fingerprint bridge for Windows (`biometric-bridge/`).

**This repo is PUBLIC.** Never commit or paste secrets: the Wi-Fi password, `IOT_HMAC_SECRET`, `BIOMETRIC_BRIDGE_HMAC_SECRET`, `.env` values or `config.h` contents.

## Current task: end-to-end test on the online system with the real devices (2026-11-13)

The system is deployed, and we are now testing it end to end on the client's laptop, with the real tracker and the real fingerprint scanner.

### Where it runs
| Part | Where | Notes |
|---|---|---|
| Frontend | https://militarygps.vercel.app (Vercel) | Auto-deploys from `main` |
| Backend API | https://military-production-2d50.up.railway.app (Railway, service "Military", root `backend/`, Dockerfile) | Auto-deploys from GitHub `cristanjdev/Military` `main`. The container runs `migrate --force` and `schedule:work` on start. |
| Database | MySQL service on Railway | Separate from any local XAMPP database: users must register fingerprints again online |

Railway variables `IOT_HMAC_SECRET` and `BIOMETRIC_BRIDGE_HMAC_SECRET` equal the values on the developer's laptop (in its `backend/.env` and `biometric-bridge/bridge.settings.json`). The client laptop must use the same values.
- Get them privately from the developer.
- Never write them into the repo or the chat.
- Compare secrets by hash only. Never print a value.

### IoT tracker (decision: one standard hotspot, "option A")
- Every tracker uses one hotspot name and password, e.g. `ARMORY-TRK`.
- Whoever is issued the firearm turns on their phone hotspot with exactly that name and password: 2.4 GHz, mobile data ON, phone within about 10 m.
- Online, the tracker sends straight to Railway over HTTPS. It does NOT need the same Wi-Fi as any laptop.

To flash it:
1. Plug the tracker in by USB and run `iot\setup-tracker.bat`.
2. Card **1 Hotspot:** the standard name and password.
3. Card **2 Server:** choose **Online - militarygps.vercel.app**. The tool checks the online server and the IoT secret before flashing.
   - A red ✕ "rejects the IoT secret" means `backend\.env` `IOT_HMAC_SECRET` on this laptop differs from Railway.
4. Card **3 Tracker:** the firearm number, which is the end of its page address on the site (`/firearms/3` = 3). Positions are accepted only while that firearm is issued with GPS on (or is out for repair).
5. **Save to tracker.** Success ends with "the online server accepted its position". Do it outdoors so the GPS gets a fix.

More details:
- Online setup is by USB only: no over-Wi-Fi update or Wi-Fi live log. Without USB, follow the tracker on the GPS page of the site.
- Manual arduino-cli steps: `RUNNING_THE_SYSTEM.txt` section 5.12.
- `config.example.h` has the ISRG Root X1 + X2 certificates that verify Railway's Let's Encrypt certificate.
- `config.h` is git-ignored and holds secrets: never commit it, never print it.

### Fingerprint scanner on the online site
Done on the PC with the scanner and the DigitalPersona SDK:
1. In `biometric-bridge\bridge.settings.json`, add `"https://militarygps.vercel.app"` to `allowed_origins`, keeping the localhost entries.
2. `hmac_secret` there must equal Railway's `BIOMETRIC_BRIDGE_HMAC_SECRET`.
3. Restart the bridge: close its window and run `start-bridge.bat`.
4. Open the online site in Chrome on that PC, log in, and click **Allow** when Chrome asks about local devices.
5. Register fingerprints again: the first login asks for 4 touches.
   - "Doesn't match" means an Admin resets the user's fingerprint on the Users page, then the user logs in again.

Fingerprint works only on a PC with the scanner and the bridge. Elsewhere, sign in with password + authenticator code.

### End-to-end checklist
- [ ] Tracker flashed in Online mode; the Activity panel shows the position accepted
- [ ] Positions appear live on the GPS page of militarygps.vercel.app
- [ ] Hotspot off for about 2 minutes gives a "signal lost" notification; back on gives "signal restored"
- [ ] Fingerprint login works on the online site
- [ ] Fingerprint confirmation works on issue and on return
- [ ] After the return, the tracker's positions are no longer accepted

If something fails, ask for the setup tool's Activity / tracker output or the exact message on screen.

## Working rules (from the developer)
- Commit and push only when asked. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit `iot/firmware/armory_tracker/config.h`, `bridge.settings.json` or any `.env`.
- Don't restart MySQL on your own; the user starts it.
- `RUNNING_THE_SYSTEM.txt` stays a .txt. IoT docs describe arduino-cli only.
- Never mention `start.bat`: it was deleted. The system is started by hand per `RUNNING_THE_SYSTEM.txt`.
- Messages for the client:
  - Written in Cebuano and in the second person.
  - Never use "boss", and don't mention "clients".
  - A confirmation message is written in English, in the third person, when asked.
- The user is writing a third-person instruction guide for the client. The biometric and tracker steps above go into it.
- Wiring diagram changes go in `frontend/public/tracker-wiring.html`.
