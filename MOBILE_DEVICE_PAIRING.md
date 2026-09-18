# MediIndex Mobile Device One-Time Pairing Specification

**Project:** MediIndex — Intelligent Pharmacy Inventory & Expiry Management Platform  
**Module:** MOD-14 (Mobile Hardware Device Registration & Authentication Subsystem)  
**Academic Context:** B.Tech Computer Science & Engineering (Major Project-II)  
**Status:** Backend Pairing Foundation IMPLEMENTED & VERIFIED  

---

## 1. Architectural Justification & Philosophy

### 1.1 The Lightweight Stock Entry App Requirement
MediIndex includes a dedicated **Mobile Stock Entry App** designed for warehouse workers and pharmacists receiving physical medicine inventory on the shop floor. The mobile app is **not** a full pharmacy management suite (it does not perform POS checkout, financial audits, or catalogue administration); it is specialized for high-speed barcode/QR scanning and stock intake.

### 1.2 Why Wi-Fi Connectivity Alone is NOT Authentication
A common architectural flaw in local network applications is assuming that presence on the pharmacy's local Wi-Fi router constitutes authentication. In reality:
1. **Network Promiscuity:** Any customer, guest, or compromised IoT device with the Wi-Fi password could discover the local server port.
2. **Replay & Impersonation:** Without cryptographic authentication, rogue HTTP clients could forge stock intake requests.
3. **No Accountability:** The server would have no cryptographic record of *which physical device* performed an inventory adjustment or receipt.

**Core Principle:** *Wi-Fi is merely an IP transport layer. The MediIndex backend remains authoritative, and every hardware device must be explicitly paired and authenticated via cryptographic tokens.*

### 1.3 Why One-Time Pairing Eliminates Password Fatigue
Requiring warehouse workers to enter complex administrative emails and passwords every time the scanner wakes up creates severe operational friction. One-time pairing establishes a permanent hardware trust relationship:
- Admin issues a short-lived PIN on the web dashboard.
- Mobile device claims the PIN once and receives an opaque 256-bit device token.
- Device stores the token in secure hardware storage (Keychain / EncryptedSharedPreferences).
- All subsequent mobile API calls automatically authenticate via this device credential.

---

## 2. End-to-End Pairing Lifecycle

```
┌─────────────────────────┐                            ┌────────────────────────┐
│  Pharmacy Administrator │                            │ Mobile Stock Entry App │
│     (Web Dashboard)     │                            │     (Mobile Phone)     │
└────────────┬────────────┘                            └───────────┬────────────┘
             │                                                     │
    1. Admin clicks "Pair Device"                                  │
    2. POST /api/mobile/pairing/create                             │
             │                                                     │
┌────────────▼─────────────────────────────────────────────────────┴────────────┐
│                             MediIndex Backend Server                          │
│  - Generates 6-character uppercase PIN (e.g. "MED-A9F2")                      │
│  - Sets expiry to 10 minutes (`expires_at = NOW() + 600s`)                    │
│  - Stores in `device_pairing_codes (pharmacy_id, code, expires_at, used=0)`   │
└────────────┬──────────────────────────────────────────────────────────────────┘
             │
    3. Server returns {"pairingCode": "MED-A9F2", "expiresInSeconds": 600}
    4. Admin displays PIN / QR to mobile operator
             │
             │                    5. Operator opens app & enters PIN "MED-A9F2"
             │                    6. POST /api/mobile/pairing/complete
             │                       Body: { pairingCode: "MED-A9F2", deviceName: "Scanner 1" }
             │                                                     │
┌────────────┴─────────────────────────────────────────────────────▼────────────┐
│                             MediIndex Backend Server                          │
│  [ATOMIC TRANSACTION]                                                         │
│  1. Check code exists, `used == 0`, and `expires_at > NOW()`                  │
│  2. Mark code as used: `UPDATE device_pairing_codes SET used=1 WHERE id=?`    │
│  3. Generate 256-bit cryptographically random token: `medidev_<64_hex_chars>` │
│  4. Compute SHA-256 hash of token: `token_hash = sha256(rawToken)`           │
│  5. Insert device into `paired_devices (pharmacy_id, name, token_hash)`       │
│  6. Commit transaction                                                        │
└──────────────────────────────────────────────────────────────────┬────────────┘
                                                                   │
                                  7. Server returns {"success": true, "deviceToken": "medidev_..."}
                                  8. Mobile app saves token in Secure Storage
                                                                   │
                                  9. All future API calls use header:
                                     `X-Device-Token: medidev_...`
```

---

## 3. Database Schema

### 3.1 `device_pairing_codes`
Tracks short-lived, single-use pairing codes.
```sql
CREATE TABLE IF NOT EXISTS device_pairing_codes (
  id INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  pairing_code TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_code ON device_pairing_codes(pairing_code);
```

### 3.2 `paired_devices`
Tracks authorized mobile hardware devices.
```sql
CREATE TABLE IF NOT EXISTS paired_devices (
  id INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  device_name TEXT NOT NULL,
  device_model TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  paired_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_paired_devices_token ON paired_devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_paired_devices_pharmacy ON paired_devices(pharmacy_id);
```

---

## 4. API Endpoints

### 4.1 Generate Pairing Code (Admin Only)
- **Route:** `POST /api/mobile/pairing/create` (or `/api/mobile/pairing/generate`)
- **Authentication:** `mediindex_session` cookie (`ADMIN` role required).
- **Response (201 Created):**
  ```json
  {
    "pairingCode": "MED-7C91B4",
    "expiresAt": "2026-09-03T01:10:00.000Z",
    "expiresInSeconds": 600
  }
  ```

### 4.2 Complete Device Pairing (Public to App)
- **Route:** `POST /api/mobile/pairing/complete` (or `/api/mobile/pairing/claim`)
- **Authentication:** None (Pairing PIN acts as transient single-use secret).
- **Request Body:**
  ```json
  {
    "pairingCode": "MED-7C91B4",
    "deviceName": "Warehouse Zebra Scanner 1",
    "deviceModel": "TC26 Android 13"
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "success": true,
    "deviceId": 3,
    "deviceName": "Warehouse Zebra Scanner 1",
    "deviceToken": "medidev_8f93a1c4b7e8d2...",
    "pharmacy": {
      "id": 1,
      "name": "MediIndex Demo Pharmacy",
      "address": "Chhatrapati Sambhajinagar"
    },
    "pairedAt": "2026-09-03T01:00:15.000Z"
  }
  ```
  *(Note: `deviceToken` is returned ONLY in this response and is never stored in plaintext on the server).*

### 4.3 Verify Device Authentication (Mobile Device)
- **Route:** `GET /api/mobile/auth/verify` (or `/api/mobile/verify`)
- **Authentication:** Header `X-Device-Token: medidev_...` or `Authorization: Bearer medidev_...`.
- **Response (200 OK):**
  ```json
  {
    "valid": true,
    "device": {
      "id": 3,
      "name": "Warehouse Zebra Scanner 1",
      "model": "TC26 Android 13",
      "createdAt": "2026-09-03T01:00:15.000Z",
      "lastSeenAt": "2026-09-03T01:05:22.000Z"
    },
    "pharmacy": {
      "id": 1,
      "name": "MediIndex Demo Pharmacy",
      "address": "Chhatrapati Sambhajinagar"
    }
  }
  ```

### 4.4 List Paired Devices (Admin Only)
- **Route:** `GET /api/mobile/devices`
- **Authentication:** `mediindex_session` cookie (`ADMIN` role required).
- **Response (200 OK):**
  ```json
  {
    "devices": [
      {
        "id": 3,
        "device_name": "Warehouse Zebra Scanner 1",
        "device_model": "TC26 Android 13",
        "created_at": "2026-09-03T01:00:15.000Z",
        "last_seen_at": "2026-09-03T01:05:22.000Z",
        "revoked": 0,
        "revoked_at": null
      }
    ]
  }
  ```

### 4.5 Revoke Device (Admin Only)
- **Route:** `POST /api/mobile/devices/:id/revoke`
- **Authentication:** `mediindex_session` cookie (`ADMIN` role required).
- **Response (200 OK):**
  ```json
  {
    "ok": true,
    "message": "Device 'Warehouse Zebra Scanner 1' has been successfully revoked.",
    "device": {
      "id": 3,
      "deviceName": "Warehouse Zebra Scanner 1",
      "revoked": 1,
      "revokedAt": "2026-09-03T01:08:00.000Z"
    }
  }
  ```

---

## 5. Security & Isolation Controls

1. **Zero Plaintext Token Storage:** Device credentials are generated with 256 bits of cryptographic entropy (`crypto.randomBytes(32)`). The database stores only `token_hash = sha256(rawToken)`.
2. **Immediate Revocation Effect:** All device lookups verify `revoked == 0`. Revoking a device on the admin panel invalidates all subsequent mobile requests immediately (401 Unauthorized).
3. **Strict Multi-Tenant Isolation:**
   - Every paired device is permanently bound to `pharmacy_id`.
   - Admin in Pharmacy A cannot view, query, or revoke devices in Pharmacy B.
   - Device credentials never expose `pharmacy_id` in plain text; the backend resolves tenancy authoritatively from the validated database record.
4. **Single-Use Atomic Claims:** Database transactions with `WHERE id = ? AND used = 0` ensure that concurrent attempts to claim the same PIN cannot create multiple devices.
5. **Short-Lived Expiration:** Pairing codes expire automatically after 10 minutes (600 seconds).

---

## 6. Current Implementation Boundary

| Subsystem Component | Current Status | Notes |
|---|---|---|
| **Database Schema (`paired_devices`, `device_pairing_codes`)** | **IMPLEMENTED** | SQLite WAL mode with indexed token hashes. |
| **Admin Pairing Code Creation API** | **IMPLEMENTED** | 10-minute expiry, Scrypt admin check. |
| **Mobile Pairing Claim API** | **IMPLEMENTED** | Single-use atomic claim, 256-bit token issue. |
| **Device Token Middleware & Verification API** | **IMPLEMENTED** | `currentDevice(req)`, `X-Device-Token` header. |
| **Admin Device Management & Revocation API** | **IMPLEMENTED** | List devices, immediate revocation. |
| **Multi-Tenancy & Isolation Tests** | **IMPLEMENTED** | 100% automated coverage in `tests/mobile-pairing.test.js`. |
| **Mobile Stock Entry API (`/api/mobile/stock-entry`)** | *NOT YET IMPLEMENTED* | Next phase on roadmap. |
| **Mobile Offline Queue & Batch Sync** | *NOT YET IMPLEMENTED* | Future phase. |
| **Mobile Frontend Client App** | *NOT YET IMPLEMENTED* | Client application layer. |
