# MediIndex Mobile — Stock Entry App

React Native + Expo + TypeScript client for MediIndex pharmacy stock intake.

**Status: Phase 7C — device pairing implemented.** Navigation, configuration, the
API transport, secure credential storage, pairing, startup routing and unpair all
work. QR scanning, stock submission, the offline queue and synchronisation are
deliberately **not** implemented yet.

## Pairing a device

1. In the MediIndex **web app**, a pharmacy **ADMIN** generates a pairing code
   (`POST /api/mobile/pairing/create`). Codes look like `MED-XXXXXX`, are valid for
   10 minutes, and work exactly once.
2. In the mobile app, enter the code and a device name on **Pair Device**.
3. The app calls `POST /api/mobile/pairing/complete` and stores the returned device
   token in `expo-secure-store`. The token is shown **never** — not on success, not
   in Settings, not in a log.
4. On every later launch the app checks secure storage **locally** and opens **Home**
   when paired or **Pair Device** when not. No network call gates startup, so a
   paired device still starts correctly offline.

**Unpair** (Settings → *Unpair this device*) deletes the credential from this
device only. It does **not** revoke the device server-side: the backend's
`POST /api/mobile/devices/:id/revoke` is authenticated as an ADMIN *web session*,
not as a device, so the app has no authenticated way to call it — and no endpoint is
invented to work around that. An administrator revokes a lost device in the web app.

## Purpose

The app lets pharmacy staff scan a medicine batch QR code and record a stock
intake, working both online and offline:

| | Behaviour |
|---|---|
| **Online** | Submit immediately; the server updates authoritative inventory |
| **Offline** | Persist locally as `PENDING`; show "Saved locally / Pending sync" |
| **Reconnect** | Sync automatically, reusing the **same** idempotency key |
| **Retry** | Same key again — the server applies the receipt exactly once |

The **server is always authoritative for inventory**. A local `PENDING` receipt has
not changed server stock, and the UI must never imply otherwise.

## Requirements

- Node 20+ and npm
- Android Studio / an Android emulator, or the Expo Go app on a device
- A reachable MediIndex backend (see Configuration)

## Getting started

```bash
cd mobile
npm install
cp .env.example .env      # then edit the URL for your setup
npm run android           # or: npm start
```

## Configuration

The backend origin is **never hard-coded**. Set it in `mobile/.env`:

```
EXPO_PUBLIC_MOBILE_API_BASE_URL=http://10.0.2.2:3000
```

- **Android emulator (AVD):** `http://10.0.2.2:3000` reaches `localhost` on the host.
- **Physical device:** use the host's LAN IP, e.g. `http://192.168.1.10:3000`.
- **Default when unset:** `http://10.0.2.2:3000`.

Start the backend from the repository root with `npm start` (listens on port 3000).

> The MediIndex Vercel Preview sits behind Vercel Deployment Protection (SSO),
> which a mobile device cannot authenticate through. Point the app at a local
> server or an unprotected deployment. Do not attempt to bypass SSO.

Verify what the app actually loaded on the **Settings** screen.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Expo dev server |
| `npm run android` | Launch on Android emulator/device |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Pairing behaviour + structure/safety checks (60 tests) |
| `npm run verify` | typecheck + tests |

## Architecture

```
mobile/
├── App.tsx                        entry: safe-area + navigation
├── index.ts                       Expo registration
├── src/
│   ├── api/
│   │   ├── client.ts              the ONLY network layer (GET/POST, timeout, errors)
│   │   ├── devicePairing.ts       pair / unpair; the token never leaves this module
│   │   ├── deviceToken.ts         binds the client's token provider to SecureStore
│   │   └── errors.ts              ApiError + transient/permanent classification
│   ├── components/
│   │   ├── PlaceholderScreen.tsx  shared "not implemented yet" body
│   │   └── theme.ts               design tokens matching the web palette
│   ├── config/
│   │   └── env.ts                 EXPO_PUBLIC_MOBILE_API_BASE_URL handling
│   ├── navigation/
│   │   ├── RootNavigator.tsx      native stack, typed route params
│   │   └── startupRoute.ts        local paired-state check -> Home | PairDevice
│   ├── screens/
│   │   ├── index.tsx              barrel
│   │   ├── SplashScreen.tsx       startup routing
│   │   ├── PairDeviceScreen.tsx   pairing form, success and error states
│   │   ├── SettingsScreen.tsx     paired state, diagnostics, unpair
│   │   └── placeholders.tsx       Home, ScanQr, StockReceipt, SyncQueue
│   ├── storage/
│   │   ├── secureStore.ts         device credential store (expo-secure-store)
│   │   └── outbox.ts              PLACEHOLDER — SQLite queue (Phase 7H)
│   ├── sync/
│   │   └── syncEngine.ts          PLACEHOLDER — auto sync (Phase 7I/7J)
│   ├── types/
│   │   └── api.ts                 backend contracts, mirrored from core.js
│   └── utils/
│       └── logger.ts              logging with mandatory secret redaction
└── tests/
    ├── helpers/                   TypeScript loader + SecureStore/fetch doubles
    ├── pairing.test.js            Phase 7C behaviour (43 tests)
    └── scaffold.test.js           structure + safety checks (17 tests)
```

The outbox and sync engine remain **interfaces with throwing stubs**. They do not
import `expo-sqlite` yet, so the app builds without dependencies it does not need —
and a later phase cannot accidentally rely on a fake implementation.

## Backend contracts reused

No new endpoints. All of these already exist and are tested server-side:

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/mobile/pairing/create` | session, ADMIN |
| `POST` | `/api/mobile/pairing/complete` | pairing code |
| `GET` | `/api/mobile/auth/verify` | device token |
| `POST` | `/api/mobile/stock-entry` | device token |
| `POST` | `/api/mobile/stock-entry/batch-sync` | device token |
| `GET` | `/api/health` | public |

The device token is sent as `X-Device-Token`. The client **never** sends a pharmacy
id — the server derives it from the device, and a client-supplied one is rejected.

The QR format is the existing MediIndex one; no second format is introduced:

```json
{ "app": "MEDIINDEX", "v": 1, "medicineId": 123, "batchNumber": "PCM-2026-08" }
```
The compact form `MEDIINDEX|v1|123|PCM-2026-08` is also accepted by the server.

## Security rules

- The device token lives only in `expo-secure-store`, under the single key
  `mediindex.device.credential.v1` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so it does
  not migrate via backup. Never AsyncStorage, never SQLite, never source, never a log.
- Only `storage/secureStore.ts` imports `expo-secure-store`. If secure storage is
  unavailable the app refuses to pair rather than fall back to plaintext.
- The token is **server-issued only**. `saveCredential()` rejects any value without
  the `medidev_` prefix, so a pairing code or a locally invented value can never
  become the device credential.
- `pairDevice()` returns non-secret identity only, so screens have no token to leak.
- `utils/logger.ts` redacts tokens, `Authorization`/`X-Device-Token` headers,
  pairing codes and any `medidev_`-prefixed string.
- No secrets in `.env` — `EXPO_PUBLIC_*` values ship inside the app bundle.
- On `401` / `DEVICE_REVOKED` the token is cleared and the app returns to pairing.

## Upcoming phases

| Phase | Scope |
|---|---|
| 7D | Startup token verification against `/api/mobile/auth/verify` |
| 7E | Home / dashboard |
| 7F | QR scanner (`expo-camera`) |
| 7G | Stock receipt submission |
| 7H | Persistent offline queue (`expo-sqlite`) |
| 7I | Automatic synchronisation (NetInfo + batch-sync) |
| 7J | Retry / error handling |
| 7K | Mobile test suite |
| 7L | Android build & demo |
