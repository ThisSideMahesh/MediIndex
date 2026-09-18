# MediIndex REST API Specification

All protected endpoints require a valid `mediindex_session` cookie established via `/api/auth/login`.

---

## Endpoint Summary

| HTTP Method | Route Path | Access Level | Description | Status |
|---|---|---|---|---|
| `GET` | `/api/health` | Public | System health and database connectivity | IMPLEMENTED |
| `POST` | `/api/auth/login` | Public | Authenticates credentials and issues session cookie | IMPLEMENTED |
| `POST` | `/api/auth/logout` | Session | Invalidates session and clears cookie | IMPLEMENTED |
| `GET` | `/api/auth/me` | Session | Returns current authenticated user profile | IMPLEMENTED |
| `GET` | `/api/dashboard` | Session | Aggregated inventory, expiry, and sales metrics | IMPLEMENTED |
| `GET` | `/api/analytics/demand` | Session | 3-period WMA demand forecast and safety stock recommendations | IMPLEMENTED |
| `GET` | `/api/batches/:id/qr` | Session | Generates structured QR payload and printable sticker metadata | IMPLEMENTED |
| `POST` | `/api/qr/lookup` | Session | Validates QR code and returns authoritative database records | IMPLEMENTED |
| `GET` | `/api/medicines` | Session | Search and list medicines (`?q=term`) | IMPLEMENTED |
| `POST` | `/api/medicines` | Admin | Create new medicine catalogue entry | IMPLEMENTED |
| `PUT` | `/api/medicines/:id` | Admin | Update medicine metadata | IMPLEMENTED |
| `DELETE` | `/api/medicines/:id` | Admin | Soft-deactivate medicine | IMPLEMENTED |
| `GET` | `/api/medicines/:id/batches` | Session | List all batches for a medicine | IMPLEMENTED |
| `POST` | `/api/medicines/:id/batches` | Session | Add new batch inventory stock | IMPLEMENTED |
| `POST` | `/api/batches/:id/adjustments` | Session | Adjust physical stock with audit trail | IMPLEMENTED |
| `GET` | `/api/expiry-alerts` | Session | Filter alerts (`?status=ALL|EXPIRED|EXPIRING_SOON`) | IMPLEMENTED |
| `POST` | `/api/expiry-alerts/:id/acknowledge` | Session | Acknowledge specific expiry alert | IMPLEMENTED |
| `POST` | `/api/sales` | Session | Process point-of-sale checkout (FEFO / batch) | IMPLEMENTED |
| `GET` | `/api/sales` | Session | List recent sales transactions and receipts | IMPLEMENTED |
| `GET` | `/api/sales/:id` | Session | Fetch full invoice details with line items | IMPLEMENTED |
| `GET` | `/api/layout/shelves` | Session | 2D shelf and rack spatial location mapping | IMPLEMENTED |
| `POST` | `/api/mobile/pairing/create` | Admin | Generates 10-min single-use mobile pairing PIN | IMPLEMENTED |
| `POST` | `/api/mobile/pairing/complete` | Public/App | Claims pairing PIN, registers hardware, issues token | IMPLEMENTED |
| `GET` | `/api/mobile/auth/verify` | Device Token | Validates device token and returns pharmacy context | IMPLEMENTED |
| `POST` | `/api/mobile/stock-entry` | Device Token | Mobile QR stock intake with idempotency & audit | IMPLEMENTED |
| `POST` | `/api/mobile/stock-entry/batch-sync` | Device Token | Batch offline outbox synchronization with per-op atomicity | IMPLEMENTED |
| `GET` | `/api/mobile/devices` | Admin | Lists all paired mobile devices and last active dates | IMPLEMENTED |
| `POST` | `/api/mobile/devices/:id/revoke` | Admin | Revokes mobile device authorization immediately | IMPLEMENTED |

---

## Authentication & Session Management (Phase 5B)

### 1. User Login: `POST /api/auth/login`
- **Access Level:** Public
- **Request Body:**
  ```json
  {
    "email": "admin@mediindex.local",
    "password": "MediIndex@2026"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "user": {
      "fullName": "Admin User",
      "email": "admin@mediindex.local",
      "role": "ADMIN"
    }
  }
  ```
- **Response Headers:**
  `Set-Cookie: mediindex_session=<raw_token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600`
- **Security & Persistence Architecture:**
  - Token is a cryptographically secure 256-bit random hex string generated via `crypto.randomBytes(32)`.
  - Raw token is sent **only** in the HttpOnly cookie and is **never stored** in the database.
  - The SHA-256 hash (`token_hash`) is persisted in the `sessions` table along with `user_id`, `pharmacy_id`, and `expires_at` (6 hours TTL).
  - Compatible with stateless Vercel Serverless instances across multiple concurrent invocations.

### 2. User Logout: `POST /api/auth/logout`
- **Access Level:** Session
- **Response (200 OK):**
  ```json
  {
    "ok": true
  }
  ```
- **Response Headers:**
  `Set-Cookie: mediindex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
- **Behavior:**
  - Deletes the session record matching `token_hash` from the persistent `sessions` table.
  - Clears browser cookie immediately.

### 3. Current Authenticated Profile: `GET /api/auth/me`
- **Access Level:** Session
- **Response (200 OK):**
  ```json
  {
    "user": {
      "id": 1,
      "pharmacy_id": 1,
      "full_name": "Admin User",
      "email": "admin@mediindex.local",
      "role": "ADMIN"
    }
  }
  ```

---

## Key Payload Specifications

### 1. Batch QR Generation: `GET /api/batches/:id/qr`

**Response (200 OK):**
```json
{
  "payload": {
    "app": "MEDIINDEX",
    "v": 1,
    "medicineId": 1,
    "batchNumber": "AZI-LOT-2027"
  },
  "payloadString": "{\"app\":\"MEDIINDEX\",\"v\":1,\"medicineId\":1,\"batchNumber\":\"AZI-LOT-2027\"}",
  "sticker": {
    "medicineId": 1,
    "medicineName": "Azithromycin 500mg",
    "genericName": "Azithromycin",
    "category": "Tablet",
    "batchNumber": "AZI-LOT-2027",
    "expiryDate": "2027-06-30",
    "sellingPrice": 25,
    "currentStock": 50,
    "location": "Rack C3"
  }
}
```

---

### 2. QR Authoritative Lookup: `POST /api/qr/lookup`

**Request:**
```json
{
  "payload": {
    "app": "MEDIINDEX",
    "v": 1,
    "medicineId": 1,
    "batchNumber": "AZI-LOT-2027"
  }
}
```
*(Accepts either JSON object, JSON string, or pipe-delimited `MEDIINDEX|v1|1|AZI-LOT-2027`)*

**Response (200 OK):**
```json
{
  "valid": true,
  "authoritative": true,
  "medicine": {
    "id": 1,
    "name": "Azithromycin 500mg",
    "genericName": "Azithromycin",
    "manufacturer": "Cipla Ltd",
    "category": "Tablet",
    "minimumStock": 10
  },
  "batch": {
    "id": 4,
    "batchNumber": "AZI-LOT-2027",
    "quantity": 50,
    "purchasePrice": 15,
    "sellingPrice": 25,
    "manufacturingDate": "2024-06-01",
    "expiryDate": "2027-06-30",
    "expiryStatus": "SAFE",
    "location": "Rack C3"
  }
}
```

---

### 3. Mobile Device Pairing: `POST /api/mobile/pairing/complete`

**Request:**
```json
{
  "pairingCode": "MED-7C91B4",
  "deviceName": "Warehouse Scanner 1",
  "deviceModel": "Zebra TC26 Android"
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "deviceId": 3,
  "deviceName": "Warehouse Scanner 1",
  "deviceToken": "medidev_8f93a1c4b7e8d2e5a6f09123847291a8...",
  "pharmacy": {
    "id": 1,
    "name": "MediIndex Demo Pharmacy",
    "address": "Chhatrapati Sambhajinagar"
  },
  "pairedAt": "2026-09-03T01:00:15.000Z"
}
```

---

### 4. Mobile Device Auth Verification: `GET /api/mobile/auth/verify`

**Request Header:**
```http
X-Device-Token: medidev_8f93a1c4b7e8d2e5a6f09123847291a8...
```

**Response (200 OK):**
```json
{
  "valid": true,
  "device": {
    "id": 3,
    "name": "Warehouse Scanner 1",
    "model": "Zebra TC26 Android",
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

---

### 5. Mobile Stock Entry Intake: `POST /api/mobile/stock-entry`

**Headers:**
```http
X-Device-Token: medidev_8f93a1c4b7e8d2e5a6f09123847291a8...
Content-Type: application/json
```

**Request (JSON QR Payload):**
```json
{
  "qrPayload": {
    "app": "MEDIINDEX",
    "v": 1,
    "medicineId": 1,
    "batchNumber": "AZI-LOT-2027"
  },
  "quantity": 50,
  "idempotencyKey": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
}
```
*(Also accepts pipe-delimited QR string: `"qrPayload": "MEDIINDEX|v1|1|AZI-LOT-2027"`)*

**Response (200 OK - First Submission):**
```json
{
  "success": true,
  "status": "STOCK_UPDATED",
  "idempotent": false,
  "medicine": {
    "id": 1,
    "name": "Azithromycin 500mg",
    "genericName": "Azithromycin",
    "category": "Tablet"
  },
  "batch": {
    "id": 4,
    "batchNumber": "AZI-LOT-2027",
    "quantityAdded": 50,
    "currentStock": 100,
    "expiryDate": "2027-06-30",
    "sellingPrice": 25,
    "location": "Rack C3"
  },
  "movementId": 89,
  "deviceId": 3,
  "timestamp": "2026-09-03T01:10:00.000Z"
}
```

**Response (200 OK - Idempotent Replay):**
```json
{
  "success": true,
  "status": "STOCK_UPDATED",
  "idempotent": true,
  "medicine": {
    "id": 1,
    "name": "Azithromycin 500mg",
    "genericName": "Azithromycin",
    "category": "Tablet"
  },
  "batch": {
    "id": 4,
    "batchNumber": "AZI-LOT-2027",
    "quantityAdded": 50,
    "currentStock": 100,
    "expiryDate": "2027-06-30",
    "sellingPrice": 25,
    "location": "Rack C3"
  },
  "movementId": 89,
  "deviceId": 3,
  "timestamp": "2026-09-03T01:10:00.000Z"
}
```

**Error Responses:**
- `401 Unauthorized`: Device token missing, invalid, or revoked (`{"error": "Device authentication required. Invalid or revoked device token."}`).
- `400 Bad Request`: Missing/malformed QR payload, invalid quantity (`<= 0`, float, or `> 100,000`), or client-supplied `pharmacy_id`.
- `404 Not Found`: Medicine or batch does not exist within the authenticated device's pharmacy context.
- `409 Conflict`: Idempotency key reused with different request parameters (`{"error": "Idempotency key conflict: This key was previously used with a different request payload."}`).

---

### 6. Mobile Batch Stock Entry Synchronization: `POST /api/mobile/stock-entry/batch-sync`

Enables offline mobile clients to upload a queue of stock receipt operations upon reconnection.

**Authentication:**
- `X-Device-Token: <token>` or `Authorization: Bearer <token>`
- Authoritative pharmacy context is strictly derived from the paired hardware token. Client-supplied `pharmacyId`/`pharmacy_id` is rejected (`400 Bad Request`).

**Batch Constraints:**
- `operations` must be an array with length $1 \le N \le 100$.
- Each operation must provide `operationId` (string, max 120), `idempotencyKey` (string, max 120), `qrPayload` (JSON or pipe format), and `quantity` ($1 \le Q \le 100,000$).
- `clientCreatedAt` is optional metadata for audit logging.

**Transaction Semantics:**
- **Per-Operation Atomicity:** Each operation is evaluated inside its own discrete `BEGIN IMMEDIATE` transaction.
- **Partial Failure Resilience:** Failure in one operation (e.g. non-existent batch) does **NOT** roll back valid operations in the same batch.
- **Idempotency Deduplication:** Re-submitted operations with the same `idempotencyKey` and identical payload return `IDEMPOTENT` status with previously committed data, preventing double-increment.

**Request:**
```json
{
  "operations": [
    {
      "operationId": "op-001",
      "idempotencyKey": "uuid-001",
      "qrPayload": {
        "app": "MEDIINDEX",
        "v": 1,
        "medicineId": 1,
        "batchNumber": "AZI-LOT-2027"
      },
      "quantity": 50,
      "clientCreatedAt": "2026-09-03T01:00:00.000Z"
    },
    {
      "operationId": "op-002",
      "idempotencyKey": "uuid-002",
      "qrPayload": "MEDIINDEX|v1|1|AZI-LOT-2027",
      "quantity": 20,
      "clientCreatedAt": "2026-09-03T01:01:00.000Z"
    },
    {
      "operationId": "op-003",
      "idempotencyKey": "uuid-003",
      "qrPayload": {
        "app": "MEDIINDEX",
        "v": 1,
        "medicineId": 999,
        "batchNumber": "UNKNOWN-LOT"
      },
      "quantity": 10,
      "clientCreatedAt": "2026-09-03T01:02:00.000Z"
    }
  ]
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "deviceId": 3,
  "pharmacyId": 1,
  "summary": {
    "total": 3,
    "synced": 1,
    "idempotent": 1,
    "failed": 1
  },
  "results": [
    {
      "operationId": "op-001",
      "status": "SYNCED",
      "idempotent": false,
      "movementId": 101,
      "batchId": 4,
      "batchNumber": "AZI-LOT-2027",
      "quantityAdded": 50,
      "currentStock": 150,
      "timestamp": "2026-09-03T01:15:00.000Z"
    },
    {
      "operationId": "op-002",
      "status": "IDEMPOTENT",
      "idempotent": true,
      "movementId": 100,
      "batchId": 4,
      "batchNumber": "AZI-LOT-2027",
      "quantityAdded": 20,
      "currentStock": 100,
      "timestamp": "2026-09-03T01:10:00.000Z"
    },
    {
      "operationId": "op-003",
      "status": "FAILED",
      "errorCode": "MEDICINE_NOT_FOUND",
      "message": "Active medicine ID 999 not found for this pharmacy."
    }
  ]
}
```

**HTTP Error Responses:**
- `401 Unauthorized`: Device token missing, invalid, or hardware is revoked (`{"error": "Device authentication required. Invalid or revoked device token."}`).
- `400 Bad Request`: `operations` is not an array, empty, exceeds 100 operations, or request contains client `pharmacy_id`.


